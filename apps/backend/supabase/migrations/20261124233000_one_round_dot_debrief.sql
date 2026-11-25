begin;

create schema habit_notify;
revoke all on schema habit_notify from public, anon, authenticated, service_role;

-- An arm belongs to one callback registration, even if its owner later reconnects.
create table habit_notify.listeners (
  owner_id uuid primary key references auth.users(id) on delete cascade,
  registration uuid unique not null default gen_random_uuid(),
  id text not null,
  url text not null,
  secret text not null,
  expires_at timestamptz not null
);
create table habit_notify.armed_rounds (
  owner_id uuid not null,
  round_id uuid not null,
  registration uuid not null references habit_notify.listeners(registration) on delete cascade,
  primary key (owner_id, round_id),
  foreign key (owner_id, round_id) references flashcards_private.practice_rounds on delete cascade
);
create table habit_notify.deliveries (
  delivery_id uuid primary key default gen_random_uuid(),
  owner_id uuid not null,
  round_id uuid not null,
  unique (owner_id, round_id),
  foreign key (owner_id, round_id) references habit_notify.armed_rounds on delete cascade,
  state text not null default 'pending' check (state in ('pending', 'claimed', 'accepted', 'failed')),
  http_status integer check (http_status between 100 and 599)
);
alter table habit_notify.listeners enable row level security;
alter table habit_notify.armed_rounds enable row level security;
alter table habit_notify.deliveries enable row level security;
revoke all on all tables in schema habit_notify from public, anon, authenticated, service_role;

create function public.habit_notify_arm(round_id uuid) returns boolean
language plpgsql security definer set search_path = '' as $$
declare
  actor uuid := auth.uid();
  claims jsonb := nullif(current_setting('request.jwt.claims', true), '')::jsonb;
  listener uuid;
begin
  if actor is null or claims ? 'client_id' or claims->>'aud' is distinct from 'authenticated'
     or claims->>'role' is distinct from 'authenticated'
     or claims->'is_anonymous' is distinct from 'false'::jsonb
     or claims->'amr' @> '[{"method":"oauth_provider/authorization_code"}]'::jsonb then
    raise exception using errcode = '42501', message = 'App sign-in required';
  end if;
  -- Serialize with Finish. Consent cannot attach to an already-completed round.
  perform 1 from flashcards_private.practice_rounds r
    where r.owner_id = actor and r.round_id = $1 and r.finished_at is null for update;
  if not found then raise exception using errcode = '42501', message = 'Open your round first'; end if;
  select registration into listener from habit_notify.listeners
    where owner_id = actor and expires_at > clock_timestamp() for share;
  if not found then raise exception using errcode = 'PT409', message = 'Open a Dot listener first'; end if;
  insert into habit_notify.armed_rounds values (actor, $1, listener) on conflict do nothing;
  return true;
end $$;
revoke all on function public.habit_notify_arm(uuid) from public, anon, authenticated, service_role;
grant execute on function public.habit_notify_arm(uuid) to authenticated;

create function habit_notify.enqueue() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  delivery uuid;
  dispatch_url text;
  dispatch_secret text;
begin
  insert into habit_notify.deliveries(owner_id, round_id)
    select a.owner_id, a.round_id from habit_notify.armed_rounds a
    join habit_notify.listeners l using (registration)
    where a.owner_id = new.owner_id and a.round_id = new.round_id and l.expires_at > clock_timestamp()
    on conflict do nothing returning delivery_id into delivery;
  if delivery is null then return new; end if;
  -- pg_net starts after commit. Delivery setup failures must not roll back Finish.
  begin
    select decrypted_secret into strict dispatch_url from vault.decrypted_secrets where name = 'habit_notify_dispatch_url';
    select decrypted_secret into strict dispatch_secret from vault.decrypted_secrets where name = 'habit_notify_dispatch_secret';
    if dispatch_url !~ '^https://[a-z0-9]+\.supabase\.co/functions/v1/neckardt-apps-mcp/deliver$'
       or coalesce(length(dispatch_secret), 0) < 32 then raise exception 'Invalid dispatch configuration'; end if;
    perform net.http_post(url := dispatch_url, body := jsonb_build_object('delivery_id', delivery),
      headers := jsonb_build_object('Content-Type','application/json','Authorization','Bearer ' || dispatch_secret),
      timeout_milliseconds := 15000);
  exception when others then
    update habit_notify.deliveries set state = 'failed' where delivery_id = delivery;
    raise warning 'Habit Practice could not queue its completion notification (SQLSTATE %)', sqlstate;
  end;
  return new;
exception when others then
  -- Consent can disappear concurrently with Finish. Grading must always win.
  raise warning 'Habit Practice could not record its completion notification (SQLSTATE %)', sqlstate;
  return new;
end $$;
revoke all on function habit_notify.enqueue() from public, anon, authenticated, service_role;
create trigger habit_notify_completion after insert on flashcards_private.round_completions
  for each row execute function habit_notify.enqueue();

create function public.habit_notify_rpc(action text, payload jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  actor uuid := (payload->>'owner_id')::uuid;
  key uuid := (payload->>'delivery_id')::uuid;
  response jsonb;
begin
  case action
  when 'subscribe' then
    if payload->>'expires_at' is null or (payload->>'expires_at')::timestamptz <= clock_timestamp() then
      raise exception using errcode = '22023', message = 'Invalid expiry';
    end if;
    delete from habit_notify.listeners where owner_id = actor and expires_at <= clock_timestamp();
    insert into habit_notify.listeners as l(owner_id,id,url,secret,expires_at) values
      (actor,payload->>'id',payload->>'url',payload->>'secret',(payload->>'expires_at')::timestamptz)
      on conflict (owner_id) do update set secret = excluded.secret, expires_at = excluded.expires_at
      where l.id = excluded.id and l.url = excluded.url;
    if not found then raise exception using errcode = 'PT409', message = 'A different Dot listener is active'; end if;
  when 'unsubscribe' then
    delete from habit_notify.listeners where owner_id = actor and id = payload->>'id';
  when 'claim' then
    -- A second pg_net request, including one racing the first, gets no payload.
    update habit_notify.deliveries d set state = 'claimed'
      from habit_notify.armed_rounds a join habit_notify.listeners l using (registration),
        flashcards_private.round_completions c
      where d.delivery_id = key and d.state = 'pending' and l.expires_at > clock_timestamp()
        and (a.owner_id, a.round_id) = (d.owner_id, d.round_id)
        and (c.owner_id, c.round_id) = (d.owner_id, d.round_id)
      returning jsonb_build_object('delivery_id',key,'id',key,'url',l.url,'secret',l.secret,
        'subscription_id',l.id,'finished_at',c.finished_at,'review_count',c.review_count,
        'action_count',c.action_count,'superseded_count',c.superseded_count,'outcomes',
        (select coalesce(jsonb_object_agg(k,v),'{}'::jsonb) from jsonb_each(c.outcomes) as o(k,v)
         where k in ('miss','hard','medium','easy','yes','no','no_opportunity','skip')
           and jsonb_typeof(v) = 'number' and v::text ~ '^[0-9]{1,10}$')) into response;
    return response;
  when 'ack' then
    update habit_notify.deliveries set http_status = (payload->>'http_status')::integer,
      state = case when (payload->>'http_status')::integer between 200 and 299 then 'accepted' else 'failed' end
      where delivery_id = key and state = 'claimed';
  else raise exception using errcode = '22023', message = 'Unknown notification operation';
  end case;
  return 'true'::jsonb;
end $$;
revoke all on function public.habit_notify_rpc(text,jsonb) from public, anon, authenticated, service_role;
grant execute on function public.habit_notify_rpc(text,jsonb) to service_role;

commit;
