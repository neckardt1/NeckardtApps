create or replace function public.recall_canary_access_token_hook(event jsonb)
returns jsonb
language plpgsql stable security invoker set search_path = ''
as $$
declare
  claims jsonb := event->'claims';
  client text := claims->>'client_id';
  binding record;
  suite_scopes text[];
  -- Public registration for the suite. Keep its identity independent of all canary bindings.
  suite_client constant text := '99658a13-b445-411d-bcc8-6a01bc5358ff';
  suite_origin constant text := 'https://jjgepkhpvslqwzkquqaf.supabase.co';
  denied constant jsonb := '{"error":{"http_code":403,"message":"This OAuth client is not enabled."}}';
begin
  if event->>'client_id' is not null and (event->>'client_id') is distinct from client then
    return denied;
  end if;

  if client is null then
    -- Social-provider sign-in ("oauth") is first party. An OAuth-server grant
    -- and a refresh of that grant both need the delegated client's identity.
    if event->>'authentication_method' = 'oauth_provider/authorization_code'
       or claims->'amr' @> '[{"method":"oauth_provider/authorization_code"}]'::jsonb then
      return denied;
    end if;
    return jsonb_build_object('claims', claims);
  end if;

  if client = suite_client then
    -- Supabase supplies the same session scopes on issuance and refresh.
    suite_scopes := string_to_array(coalesce(claims->>'scope', ''), ' ');
    if coalesce(event->>'authentication_method', '') not in ('oauth_provider/authorization_code', 'token_refresh')
       or (claims->>'iss') is distinct from (suite_origin || '/auth/v1')
       or nullif(event->>'user_id', '') is null
       or (claims->>'sub') is distinct from (event->>'user_id')
       or (claims->>'role') is distinct from 'authenticated'
       or claims->'is_anonymous' is distinct from 'false'::jsonb
       or not (suite_scopes = array['openid'] or (cardinality(suite_scopes) = 3
         and suite_scopes @> array['openid', 'email', 'offline_access'])) then
      return denied;
    end if;

    -- The MCP server checks this audience and role. No database role or API grants are needed.
    -- Keep contact claims blank on the MCP access token. Supabase handles OIDC identity separately.
    return jsonb_build_object('claims', (claims - 'app_metadata' - 'user_metadata') || jsonb_build_object(
      'aud', suite_origin || '/functions/v1/neckardt-apps-mcp', 'role', 'neckardt_apps_oauth',
      'email', '', 'phone', ''
    ));
  end if;

  -- All other delegated clients require an explicit canary binding.
  if to_regclass('recall_canary.oauth_clients') is null then
    return denied;
  end if;
  select b.subject_id, b.audience into binding
  from recall_canary.oauth_clients as b
  where b.client_id::text = client;
  if not found then
    return denied;
  end if;

  if binding.subject_id is null
     or (event->>'user_id') is distinct from binding.subject_id::text
     or (claims->>'sub') is distinct from binding.subject_id::text
     or (claims->>'role') is distinct from 'authenticated'
     or claims->'is_anonymous' is distinct from 'false'::jsonb then
    return jsonb_build_object('error', jsonb_build_object(
      'http_code', 403, 'message', 'This account cannot authorize the Recall canary client.'
    ));
  end if;

  return jsonb_build_object('claims', claims || jsonb_build_object(
    'aud', binding.audience, 'role', 'recall_canary_oauth'
  ));
end;
$$;

revoke all on function public.recall_canary_access_token_hook(jsonb)
  from public, anon, authenticated, service_role;
grant execute on function public.recall_canary_access_token_hook(jsonb) to supabase_auth_admin;
