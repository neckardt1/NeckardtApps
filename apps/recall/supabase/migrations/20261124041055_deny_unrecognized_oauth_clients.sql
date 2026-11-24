-- Keep the existing Supabase Auth hook name so this takes effect on the
-- configured project without switching hooks or modifying client bindings.
create or replace function public.recall_canary_access_token_hook(event jsonb)
returns jsonb
language plpgsql stable security invoker set search_path = ''
as $$
declare
  claims jsonb := event->'claims';
  client text := claims->>'client_id';
  binding record;
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

  -- A fresh project may have no canary installation. Deny all delegated
  -- clients there while still allowing ordinary sign-in and token refresh.
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
