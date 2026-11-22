-- Synthetic review completions only. No triggers on application tables.
create extension if not exists pg_net with schema extensions;
create schema recall_canary;
revoke all on schema recall_canary from public, anon, authenticated, service_role;
grant usage on schema recall_canary to service_role;

create table recall_canary.settings (
  singleton boolean primary key default true check (singleton),
  deliver_url text check (deliver_url ~ '^https://[a-z0-9]{20}[.]supabase[.]co/functions/v1/recall-events/deliver$')
);
insert into recall_canary.settings default values;

create table recall_canary.subscriptions (
  id text primary key,
  callback_url bytea not null,
  signing_secret bytea not null,
  previous_secret bytea,
  rotation_expires timestamptz,
  expires timestamptz not null,
  active boolean not null default true
);

create table recall_canary.events (
  event_id uuid primary key default gen_random_uuid(),
  session_id text not null unique check (session_id ~ '^[A-Za-z0-9_-]{1,96}$'),
  saved_at timestamptz not null default clock_timestamp()
);

create table recall_canary.deliveries (
  event_id uuid not null references recall_canary.events,
  subscription_id text not null references recall_canary.subscriptions,
  state text not null default 'pending'
    check (state in ('pending','sending','accepted','rejected','unknown','cancelled')),
  attempts integer not null default 0,
  attempt_id uuid,
  leased_until timestamptz,
  available_after timestamptz not null default now(),
  acknowledged_at timestamptz,
  http_status integer,
  primary key (event_id, subscription_id)
);
alter table recall_canary.settings enable row level security;
alter table recall_canary.subscriptions enable row level security;
alter table recall_canary.events enable row level security;
alter table recall_canary.deliveries enable row level security;
revoke all on all tables in schema recall_canary from public, anon, authenticated, service_role;

-- Each secret is generated inside Postgres. Only the bearer is entered at Connect.
do $provision$
declare key_name text;
begin
  foreach key_name in array array['recall_canary_mcp_bearer','recall_canary_delivery_key','recall_canary_storage_key']
  loop
    perform vault.create_secret(encode(extensions.gen_random_bytes(32),'hex'), key_name);
  end loop;
end;
$provision$;

create function recall_canary.secret(key_name text) returns text
language plpgsql stable security invoker set search_path = ''
as $$
declare result text;
begin
  select decrypted_secret into strict result from vault.decrypted_secrets where name = key_name;
  return result;
end;
$$;

-- Per-event credentials keep the dispatch credential scoped to one synthetic event.
create function recall_canary.delivery_token(event_key uuid) returns text
language sql stable set search_path = '' as $$
  select encode(extensions.hmac(event_key::text, recall_canary.secret('recall_canary_delivery_key'), 'sha256'), 'hex');
$$;

create function recall_canary.dispatch(event_key uuid) returns bigint
language plpgsql set search_path = ''
as $$
declare endpoint text;
begin
  if not exists (
    select from recall_canary.deliveries d join recall_canary.subscriptions s on s.id = d.subscription_id
    where d.event_id = event_key and s.active and s.expires > now()
      and ((d.state = 'pending' and d.available_after <= now()) or (d.state = 'sending' and d.leased_until < now()))
      and d.attempts < 3
  ) then
    return null;
  end if;
  select deliver_url into strict endpoint from recall_canary.settings where singleton;
  if endpoint is null then raise exception 'Configure the synthetic delivery endpoint first'; end if;
  -- pg_net sends only after the inserting transaction commits.
  return net.http_post(
    url := endpoint,
    body := jsonb_build_object('event_id', event_key),
    headers := jsonb_build_object('Content-Type','application/json','Authorization',
                                  'Bearer ' || recall_canary.delivery_token(event_key)),
    timeout_milliseconds := 20000
  );
end;
$$;

create function recall_canary.queue_event() returns trigger
language plpgsql set search_path = ''
as $$
begin
  insert into recall_canary.deliveries(event_id,subscription_id)
    select new.event_id, id from recall_canary.subscriptions where active and expires > now();
  perform recall_canary.dispatch(new.event_id);
  return new;
end;
$$;
create trigger recall_canary_insert after insert on recall_canary.events
  for each row execute function recall_canary.queue_event();

-- Only the Edge service role can invoke this bridge. All secret-bearing operations
-- execute in this private schema, with a fixed search path and no dynamic SQL.
create function recall_canary.rpc(action text, payload jsonb) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  crypto_key text;
  expires_at timestamptz;
  event_key uuid;
  auth_hash text;
  status_code integer;
  retry_at timestamptz;
  result jsonb;
begin
  case action
  when 'auth' then
    auth_hash := encode(extensions.digest(recall_canary.secret('recall_canary_mcp_bearer'),'sha256'),'hex');
    return to_jsonb(coalesce(auth_hash = (payload->>'token_hash'), false));

  when 'subscribe' then
    if (payload->>'batch_id') is distinct from 'mcp-canary' then raise exception 'Invalid batch'; end if;
    crypto_key := recall_canary.secret('recall_canary_storage_key');
    expires_at := clock_timestamp() + least(86400000, greatest(1, coalesce((payload->>'ttl_ms')::int,3600000)))
                                      * interval '1 millisecond';
    insert into recall_canary.subscriptions as old(id, callback_url, signing_secret, expires)
      values (payload->>'id', extensions.pgp_sym_encrypt(payload->>'callback_url', crypto_key),
              extensions.pgp_sym_encrypt(payload->>'secret', crypto_key), expires_at)
    on conflict (id) do update set
      previous_secret = case
        when not old.active or old.expires <= now() then null
        when extensions.pgp_sym_decrypt(old.signing_secret, crypto_key) <> payload->>'secret' then old.signing_secret
        else old.previous_secret end,
      rotation_expires = case
        when not old.active or old.expires <= now() then null
        when extensions.pgp_sym_decrypt(old.signing_secret, crypto_key) <> payload->>'secret' then now()+interval '5 minutes'
        else old.rotation_expires end,
      signing_secret = excluded.signing_secret, expires = excluded.expires, active = true;
    return jsonb_build_object('id',payload->>'id','refreshBefore',expires_at,'cursor',null,'truncated',false);

  when 'unsubscribe' then
    update recall_canary.subscriptions set active = false where id = payload->>'id';
    update recall_canary.deliveries set state = 'cancelled'
      where subscription_id = payload->>'id' and state in ('sending','pending');
    return '{}'::jsonb;

  when 'get' then
    select jsonb_build_object('event_id',event_id,'session_id',session_id,'batch_id','mcp-canary',
                              'saved_at',saved_at,'synthetic',true)
      into result from recall_canary.events where session_id = payload->>'session_id';
    return coalesce(result,'{"found":false}'::jsonb);

  when 'claim' then
    event_key := (payload->>'event_id')::uuid;
    auth_hash := encode(extensions.digest(recall_canary.delivery_token(event_key),'sha256'),'hex');
    if payload->>'delivery_token_hash' is distinct from auth_hash then return 'null'::jsonb; end if;
    crypto_key := recall_canary.secret('recall_canary_storage_key');
    with claimed as (
      update recall_canary.deliveries d set state = 'sending', attempts = d.attempts + 1,
          attempt_id = gen_random_uuid(), leased_until = clock_timestamp() + interval '90 seconds'
        from recall_canary.subscriptions s, recall_canary.events e
        where d.event_id = event_key and e.event_id = event_key and s.id = d.subscription_id
          and s.active and s.expires > now() and d.attempts < 3
          and ((d.state = 'pending' and d.available_after <= now()) or (d.state = 'sending' and d.leased_until < now()))
        returning s.id as subscription_id, extensions.pgp_sym_decrypt(s.callback_url,crypto_key) as callback_url,
          extensions.pgp_sym_decrypt(s.signing_secret,crypto_key) as secret,
          case when s.rotation_expires > now() then extensions.pgp_sym_decrypt(s.previous_secret,crypto_key) end as old_secret,
          d.attempt_id, e.event_id, e.saved_at, e.session_id, 'mcp-canary'::text as batch_id
    ) select coalesce(jsonb_agg(to_jsonb(claimed)), '[]'::jsonb) into result from claimed;
    return result;

  when 'ack' then
    status_code := (payload->>'http_status')::int;
    retry_at := clock_timestamp();
    if payload->>'retry_after' ~ '^[0-9]{1,9}$' then
      retry_at := retry_at + (payload->>'retry_after')::integer * interval '1 second';
    elsif payload->>'retry_after' ~ '^[A-Z][a-z]{2}, ' then
      begin
        retry_at := (payload->>'retry_after')::timestamptz;
      exception when invalid_datetime_format or datetime_field_overflow then
        retry_at := clock_timestamp();
      end;
    end if;
    update recall_canary.deliveries set
      available_after = greatest(retry_at, clock_timestamp() + attempts * interval '1 second'),
      state = case
        when status_code between 200 and 299 then 'accepted'
        when status_code in (0,408,429) or status_code >= 500 then
          case when attempts < 3 then 'pending' else 'unknown' end
        else 'rejected' end,
      http_status = status_code,
      acknowledged_at = case when status_code between 200 and 299 then clock_timestamp() end
      where event_id = (payload->>'event_id')::uuid and subscription_id = payload->>'subscription_id'
        and attempt_id = (payload->>'attempt_id')::uuid and state = 'sending';
    return '{}'::jsonb;
  else
    raise exception 'Unknown canary operation';
  end case;
end;
$$;
revoke all on all functions in schema recall_canary from public, anon, authenticated, service_role;
grant execute on function recall_canary.rpc(text,jsonb) to service_role;

create function public.recall_canary_db(action text, payload jsonb) returns jsonb
language sql security invoker set search_path = '' as $$
  select recall_canary.rpc(action, payload);
$$;
revoke all on function public.recall_canary_db(text,jsonb) from public, anon, authenticated;
grant execute on function public.recall_canary_db(text,jsonb) to service_role;
