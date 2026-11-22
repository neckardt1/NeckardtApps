-- Register each dedicated OAuth client before enabling it for a user. A NULL
-- subject suspends this client without falling back to a normal project token.
create table recall_canary.oauth_clients (
  client_id uuid primary key,
  subject_id uuid,
  audience text not null check (
    audience ~ '^https://[a-z0-9]{20}[.]supabase[.]co/functions/v1/recall-events/web/mcp$'
  )
);
alter table recall_canary.oauth_clients enable row level security;
revoke all on table recall_canary.oauth_clients from public, anon, authenticated, service_role;
grant usage on schema recall_canary to supabase_auth_admin;
grant select on recall_canary.oauth_clients to supabase_auth_admin;
create policy auth_reads_canary_oauth_clients on recall_canary.oauth_clients
  for select to supabase_auth_admin using (true);

-- Deliberately do not create or grant a Postgres role of this name. PostgREST
-- cannot SET ROLE for these tokens, even on deployments without audience checks.
do $$
begin
  if to_regrole('recall_canary_oauth') is not null then
    raise exception 'The reserved recall_canary_oauth role must not exist';
  end if;
end;
$$;

create function public.recall_canary_access_token_hook(event jsonb) returns jsonb
language plpgsql stable security invoker set search_path = ''
as $$
declare
  claims jsonb := event->'claims';
  client text := claims->>'client_id';
  binding recall_canary.oauth_clients%rowtype;
begin
  if client is null then
    return jsonb_build_object('claims', claims);
  end if;
  -- Supabase Auth supplies client_id as a UUID on OAuth issuance and refresh.
  select * into binding from recall_canary.oauth_clients where client_id = client::uuid;
  if not found then
    return jsonb_build_object('claims', claims);
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
  claims := claims || jsonb_build_object('aud', binding.audience, 'role', 'recall_canary_oauth');
  return jsonb_build_object('claims', claims);
end;
$$;
revoke all on function public.recall_canary_access_token_hook(jsonb)
  from public, anon, authenticated, service_role;
grant execute on function public.recall_canary_access_token_hook(jsonb) to supabase_auth_admin;
