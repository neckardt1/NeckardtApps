begin;

-- Old clients call arm with just the round ID, and existing authorizations
-- promised counts only. Detail sharing requires the updated in-app disclosure.
alter table habit_notify.armed_rounds add column share_items boolean not null default false;
-- An action's question belongs to the opportunity and may differ from the
-- card's own front. Capture that display name alongside the prompt at Open.
alter table flashcards_private.round_items add column action_card_name text;
create function flashcards_private.snapshot_action_card_name() returns trigger
language plpgsql security invoker set search_path = '' as $$
begin
  select c.front into new.action_card_name from flashcards_private.cards c
    where (c.owner_id, c.id) = (new.owner_id, new.card_id);
  return new;
end $$;
revoke all on function flashcards_private.snapshot_action_card_name() from public, anon, authenticated, service_role;
create trigger snapshot_action_card_name before insert on flashcards_private.round_items
  for each row when (new.item_kind = 'action') execute function flashcards_private.snapshot_action_card_name();

drop function public.habit_notify_arm(uuid);

create function public.habit_notify_arm(round_id uuid, share_items boolean default false) returns boolean
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
  insert into habit_notify.armed_rounds as a (owner_id, round_id, registration, share_items)
    values (actor, $1, listener, coalesce($2, false))
    on conflict on constraint armed_rounds_pkey do update set share_items = a.share_items or excluded.share_items;
  return true;
end $$;
revoke all on function public.habit_notify_arm(uuid,boolean) from public, anon, authenticated, service_role;
grant execute on function public.habit_notify_arm(uuid,boolean) to authenticated;

create or replace function public.habit_notify_rpc(action text, payload jsonb) returns jsonb
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
           and jsonb_typeof(v) = 'number' and v::text ~ '^[0-9]{1,10}$')) ||
        case when a.share_items then jsonb_build_object(
          'round_id', c.round_id, 'items', (
            select coalesce(jsonb_agg(jsonb_build_object(
              'position', i."position", 'item_kind', i.item_kind, 'card_id', i.card_id,
              'card_name', coalesce(i.action_card_name, i.front), 'front', i.front, 'back', i.back, 'answer', i.final_answer,
              'grade', r.grade, 'answered_at', i.final_answered_at,
              'due_at', i.due_at, 'next_due_at', r.next_due_at
            ) order by i."position"), '[]'::jsonb)
            from flashcards_private.round_items i
            left join flashcards_private.reviews r
              on (r.owner_id, r.review_id, r.card_id, r.card_revision) =
                 (i.owner_id, i.event_id, i.card_id, i.revision)
              and (i.item_kind = 'review' or i.paired_action)
              and i.final_answer <> 'superseded'
            where (i.owner_id, i.round_id) = (c.owner_id, c.round_id)
          )
        ) else '{}'::jsonb end into response;
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

notify pgrst, 'reload schema';
commit;
