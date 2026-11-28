begin;

create schema mcp_oauth;
revoke all on schema mcp_oauth from public, anon, authenticated;
grant usage on schema mcp_oauth to service_role;

-- Enroll each connector separately for the pilot owner. Deleting a registration
-- invalidates its codes, access tokens, refresh tokens and associated listeners.
create table mcp_oauth.pilot_owner (
  singleton boolean primary key default true check (singleton),
  owner_id uuid unique not null references auth.users(id) on delete cascade
);
create table mcp_oauth.clients (
  id text primary key check (id in ('neckardt-muse', 'neckardt-chatgpt')),
  owner_id uuid not null references mcp_oauth.pilot_owner(owner_id) on delete cascade,
  redirect_uri text not null,
  unique (id, owner_id, redirect_uri),
  check (case id when 'neckardt-muse' then redirect_uri = 'https://agent.meta.ai/api/hatch/oauth/callback'
    else redirect_uri = 'https://chatgpt.com/connector_platform_oauth_redirect' or redirect_uri ~ '^https://chatgpt[.]com/connector/oauth/[A-Za-z0-9_-]+$' end)
);
create table mcp_oauth.grants (
  id uuid primary key default gen_random_uuid(),
  client_id text not null, owner_id uuid not null, redirect_uri text not null,
  foreign key (client_id, owner_id, redirect_uri) references mcp_oauth.clients (id, owner_id, redirect_uri) on delete cascade,
  resource text not null, scope text not null,
  check (scope = 'habit:link' or (client_id = 'neckardt-chatgpt'
    and scope in ('habit:link offline_access', 'habit:events habit:link', 'habit:events habit:link offline_access'))),
  code_hash text unique not null check (code_hash ~ '^[a-f0-9]{64}$'),
  challenge text not null check (challenge ~ '^[A-Za-z0-9_-]{43}$'),
  code_until timestamptz not null default (now() + interval '3 minutes'),
  issued boolean not null default false,
  expires_at timestamptz not null default (now() + interval '30 days')
);
create index mcp_oauth_grants_client on mcp_oauth.grants(client_id);
create table mcp_oauth.tokens (
  hash text primary key check (hash ~ '^[a-f0-9]{64}$'),
  grant_id uuid not null references mcp_oauth.grants(id) on delete cascade,
  kind text not null check (kind in ('access', 'refresh')), spent boolean not null default false,
  expires_at timestamptz not null
);
create index mcp_oauth_tokens_grant on mcp_oauth.tokens(grant_id);
alter table mcp_oauth.pilot_owner enable row level security;
alter table mcp_oauth.clients enable row level security;
alter table mcp_oauth.grants enable row level security;
alter table mcp_oauth.tokens enable row level security;
revoke all on all tables in schema mcp_oauth from public, anon, authenticated, service_role;
grant select on mcp_oauth.clients to service_role;
-- SELECT FOR UPDATE on the registration serializes reconnect, rotation and disconnect per client.
grant update (id) on mcp_oauth.clients to service_role;
grant select, insert, update, delete on mcp_oauth.grants, mcp_oauth.tokens to service_role;

-- A replacement ChatGPT subscription is owned by precisely the grant that created it.
-- Existing ChatGPT subscriptions have a null grant and continue to use their existing lifecycle.
alter table habit_notify.listeners add column mcp_grant uuid references mcp_oauth.grants(id) on delete cascade;
create index habit_notify_mcp_grant on habit_notify.listeners(mcp_grant) where mcp_grant is not null;

create function public.mcp_oauth_grant(action text, p jsonb) returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare
  c mcp_oauth.clients%rowtype;
  g mcp_oauth.grants%rowtype;
  tok mcp_oauth.tokens%rowtype;
begin
  if action = 'inspect' then
    select grant_row.* into g from mcp_oauth.tokens t join mcp_oauth.grants grant_row on grant_row.id = t.grant_id
      where t.hash = p->>'hash' and t.kind = 'access' and not t.spent and t.expires_at > now()
        and grant_row.issued and grant_row.resource = p->>'resource' and grant_row.expires_at > now();
    if not found then return null; end if;
    return jsonb_build_object('client', g.client_id, 'subject', g.owner_id, 'grant', g.id, 'scope', g.scope);
  end if;

  select * into c from mcp_oauth.clients where id = p->>'client' for update;
  if not found then return null; end if;
  if action in ('owner', 'disconnect') then
    if c.owner_id is distinct from (p->>'owner')::uuid then return null; end if;
    if action = 'disconnect' then delete from mcp_oauth.grants where client_id = c.id; end if;
    return 'true'::jsonb;
  end if;
  if action in ('review','approve') then
    if c.owner_id is distinct from (p->>'owner')::uuid or c.redirect_uri is distinct from p->>'callback' then return null; end if;
    if action = 'approve' then
      delete from mcp_oauth.grants where client_id = c.id and (expires_at <= now() or (not issued and code_until <= now()));
      insert into mcp_oauth.grants(client_id, owner_id, redirect_uri, resource, scope, code_hash, challenge)
        values (c.id, c.owner_id, c.redirect_uri, p->>'resource', p->>'scope', p->>'hash', p->>'challenge');
    end if;
    return 'true'::jsonb;
  end if;

  if action = 'exchange' then
    select * into g from mcp_oauth.grants where client_id = c.id and code_hash = p->>'hash'
      and redirect_uri = p->>'callback' and resource = p->>'resource' and challenge = p->>'challenge';
    if not found or g.code_until <= now() then return null; end if;
    if g.issued then
      delete from mcp_oauth.grants where id = g.id;
      return null;
    end if;
    -- A cancelled or incomplete reconnect never terminates the existing grant.
    delete from mcp_oauth.grants where client_id = c.id and issued;
    update mcp_oauth.grants set issued = true where id = g.id;
  elsif action in ('refresh','revoke') then
    select t.* into tok from mcp_oauth.tokens t join mcp_oauth.grants gr on gr.id = t.grant_id
      where t.hash = p->>'hash' and gr.client_id = c.id;
    if not found then return null; end if;
    select * into strict g from mcp_oauth.grants where id = tok.grant_id;
    if action = 'revoke' then
      delete from mcp_oauth.grants where id = g.id;
      return 'true'::jsonb;
    end if;
    if tok.kind <> 'refresh' or tok.expires_at <= now() or g.expires_at <= now()
       or g.resource is distinct from p->>'resource' then return null; end if;
    if tok.spent then
      delete from mcp_oauth.grants where id = g.id;
      return null;
    end if;
    -- A refresh may repeat the existing scope; changing scope requires new consent.
    if p->>'scope' is not null and p->>'scope' <> g.scope then return null; end if;
    update mcp_oauth.tokens set spent = true where hash = tok.hash;
    delete from mcp_oauth.tokens where grant_id = g.id and kind = 'access';
  else
    raise exception 'Unknown OAuth operation';
  end if;
  insert into mcp_oauth.tokens(hash,grant_id,kind,expires_at) values
    (p->>'access_hash', g.id, 'access', least(g.expires_at, now() + interval '10 minutes'));
  if 'offline_access' = any(string_to_array(g.scope,' ')) then
    insert into mcp_oauth.tokens(hash,grant_id,kind,expires_at) values (p->>'refresh_hash', g.id, 'refresh', g.expires_at);
  end if;
  return jsonb_build_object('scope', g.scope, 'expires_in', least(600, floor(extract(epoch from g.expires_at - now()))));
end $$;
revoke all on function public.mcp_oauth_grant(text,jsonb) from public, anon, authenticated;
grant execute on function public.mcp_oauth_grant(text,jsonb) to service_role;

-- The existing service entry points enforce event payloads. This wrapper ties their mutation
-- to a still-active ChatGPT grant inside the same transaction as the listener change.
create function mcp_oauth.event(action text, payload jsonb, grant_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  g mcp_oauth.grants%rowtype;
begin
  select * into g from mcp_oauth.grants where id = grant_id and issued and expires_at > now()
    and client_id = 'neckardt-chatgpt' and owner_id = (payload->>'owner_id')::uuid
    and 'habit:events' = any(string_to_array(scope,' ')) for share;
  if not found or action not in ('subscribe','subscribe_automatic','unsubscribe') then
    raise exception using errcode = '42501', message = 'Active event grant required';
  end if;
  if action = 'unsubscribe' then
    delete from habit_notify.listeners where mcp_grant = grant_id and id = payload->>'id';
    return 'true'::jsonb;
  end if;
  -- A listener cannot outlive the identity grant even if it is renewed near its final expiry.
  payload := jsonb_set(payload, '{expires_at}', to_jsonb(least(g.expires_at, (payload->>'expires_at')::timestamptz)));
  if action = 'subscribe_automatic' then perform public.habit_notify_subscribe_automatic(payload);
  else perform public.habit_notify_rpc('subscribe', payload); end if;
  update habit_notify.listeners set mcp_grant = grant_id where owner_id = g.owner_id and id = payload->>'id'
    and (mcp_grant is null or mcp_grant = grant_id);
  if not found then raise exception 'Subscription grant changed'; end if;
  return jsonb_build_object('expires_at', payload->>'expires_at');
end $$;
revoke all on function mcp_oauth.event(text,jsonb,uuid) from public, anon, authenticated;
grant execute on function mcp_oauth.event(text,jsonb,uuid) to service_role;
create function public.mcp_oauth_event(action text, payload jsonb, grant_id uuid) returns jsonb
language sql security invoker set search_path = '' as $$
  select mcp_oauth.event(action, payload, grant_id)
$$;
revoke all on function public.mcp_oauth_event(text,jsonb,uuid) from public, anon, authenticated;
grant execute on function public.mcp_oauth_event(text,jsonb,uuid) to service_role;
notify pgrst, 'reload schema';
commit;
