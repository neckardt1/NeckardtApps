create schema neckardt_mcp;
revoke all on schema neckardt_mcp from public;
grant usage on schema neckardt_mcp to authenticated, supabase_auth_admin;

-- Only operators configure clients. Removing a pilot user also removes their binding.
create table neckardt_mcp.clients (
  client_id uuid primary key,
  display_name text not null check (btrim(display_name) <> ''),
  callback_url text not null check (callback_url ~ '^https://[^/@?#[:space:]]+/[^?#[:space:]]*$'),
  owner_id uuid references auth.users(id) on delete cascade,
  subscriptions boolean not null default false,
  scopes text[] not null default array['openid'] check (
    scopes @> array['openid'] and scopes <@ array['openid', 'email', 'offline_access']
    and array_position(scopes, null) is null
    and cardinality(scopes) = 1 + ('email' = any(scopes))::int + ('offline_access' = any(scopes))::int
  )
);
alter table neckardt_mcp.clients enable row level security;
revoke all on neckardt_mcp.clients from public, anon, authenticated, service_role;
grant select on neckardt_mcp.clients to authenticated, supabase_auth_admin;
create policy consent_reads_eligible_clients on neckardt_mcp.clients for select to authenticated using (
  (select auth.uid()) is not null and (owner_id is null or owner_id = (select auth.uid()))
  and (select nullif(current_setting('request.jwt.claims', true), '')::jsonb -> 'is_anonymous') = 'false'::jsonb
  and (select nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'client_id') is null
);
create policy auth_reads_clients on neckardt_mcp.clients for select to supabase_auth_admin using (true);

insert into neckardt_mcp.clients (client_id, display_name, callback_url, subscriptions, scopes)
values ('99658a13-b445-411d-bcc8-6a01bc5358ff', 'ChatGPT',
  'https://chatgpt.com/connector/oauth/2ULNAMaEaROG', true, array['openid','email','offline_access']);

-- The consent page and Auth hook apply the same subject and exact scope-set policy.
create function public.neckardt_mcp_client(requested_client uuid, requested_user uuid, requested_scope text)
returns table (display_name text, callback_url text, subscriptions boolean)
language sql stable security invoker set search_path = '' as $$
  select c.display_name, c.callback_url, c.subscriptions from neckardt_mcp.clients c
  where c.client_id = requested_client and requested_user is not null
    and (c.owner_id is null or c.owner_id = requested_user)
    and (requested_scope = 'openid' or
      (string_to_array(requested_scope, ' ') @> c.scopes and string_to_array(requested_scope, ' ') <@ c.scopes
       and cardinality(string_to_array(requested_scope, ' ')) = cardinality(c.scopes)));
$$;
revoke all on function public.neckardt_mcp_client(uuid, uuid, text) from public, anon, authenticated, service_role;
grant execute on function public.neckardt_mcp_client(uuid, uuid, text) to authenticated, supabase_auth_admin;

create or replace function public.recall_canary_access_token_hook(event jsonb)
returns jsonb
language plpgsql stable security invoker set search_path = ''
as $$
declare
  claims jsonb := event->'claims';
  client text := claims->>'client_id';
  binding record;
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

  select * into binding from public.neckardt_mcp_client(
    client::uuid, (event->>'user_id')::uuid, claims->>'scope'
  );
  if found then
    if coalesce(event->>'authentication_method', '') not in ('oauth_provider/authorization_code', 'token_refresh')
       or (claims->>'iss') is distinct from (suite_origin || '/auth/v1')
       or (claims->>'sub') is distinct from (event->>'user_id')
       or (claims->>'role') is distinct from 'authenticated'
       or claims->'is_anonymous' is distinct from 'false'::jsonb
       or not exists (select 1 from auth.oauth_clients c where c.id = client::uuid and c.deleted_at is null
         and c.registration_type = 'manual' and c.client_type = 'public' and c.token_endpoint_auth_method = 'none'
         and c.redirect_uris = binding.callback_url) then
      return denied;
    end if;

    -- The database role has no Data API privileges. Only Auth signs these MCP permissions.
    return jsonb_build_object('claims', (claims - 'app_metadata' - 'user_metadata') || jsonb_build_object(
      'aud', suite_origin || '/functions/v1/neckardt-apps-mcp',
      'role', 'neckardt_apps_oauth', 'neckardt_mcp', jsonb_build_object(
        'subscriptions', binding.subscriptions, 'origin', substring(binding.callback_url from '^(https://[^/]+)')
      ),
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
