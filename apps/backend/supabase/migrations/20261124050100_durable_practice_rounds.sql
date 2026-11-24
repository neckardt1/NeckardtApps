-- The manifest is a snapshot of the exact prompts and revisions shown. Each
-- preallocated event ID is also the ordinary grading/action idempotency key.
begin;

create table flashcards_private.practice_rounds (
  owner_id uuid not null references flashcards_private.app_owner(owner_id),
  round_id uuid not null,
  opened_at timestamptz not null default clock_timestamp(),
  finished_at timestamptz,
  primary key (owner_id, round_id)
);
create unique index practice_rounds_one_open on flashcards_private.practice_rounds(owner_id)
  where finished_at is null;

create table flashcards_private.round_items (
  owner_id uuid not null,
  round_id uuid not null,
  "position" integer not null check ("position" >= 0),
  event_id uuid not null default gen_random_uuid(),
  item_kind text not null check (item_kind in ('action','review')),
  card_id uuid not null,
  revision integer not null check (revision >= 0),
  front text not null,
  back text,
  opportunity_id uuid,
  due_at timestamptz,
  paired_action boolean not null,
  final_answer text,
  final_answered_at timestamptz,
  primary key (owner_id, round_id, "position"),
  unique (owner_id, event_id),
  foreign key (owner_id, round_id) references flashcards_private.practice_rounds,
  check ((item_kind = 'action') = (opportunity_id is not null)),
  check (not paired_action or item_kind = 'action')
);
-- The completion event is created in the same transaction as Finish. Consumers
-- can use (owner_id,round_id) to deduplicate a later delivery.
create table flashcards_private.round_completions (
  owner_id uuid not null,
  round_id uuid not null,
  finished_at timestamptz not null,
  review_count integer not null,
  action_count integer not null,
  superseded_count integer not null,
  outcomes jsonb not null,
  primary key (owner_id, round_id),
  foreign key (owner_id, round_id) references flashcards_private.practice_rounds
);

alter table flashcards_private.practice_rounds enable row level security;
alter table flashcards_private.round_items enable row level security;
alter table flashcards_private.round_completions enable row level security;

-- Only a matching receipt can attest to an answer. A competing revision,
-- expired occasion, or retired card can be settled as superseded without
-- inventing a grade. Finish freezes those decisions for later devices.
create view flashcards_private.round_manifest with (security_invoker = true) as
select i.owner_id, i.round_id, r.finished_at, i."position", i.item_kind, i.event_id,
  i.card_id, i.revision, i.front, i.back, i.opportunity_id, i.due_at,
  case
    when r.finished_at is not null then i.final_answer
    when v.review_id is not null then v.grade
    when a.action_id is not null then a.outcome
    when c.id is null or not c.active then 'superseded'
    when i.item_kind = 'review' and
      (c.revision <> i.revision or not flashcards_private.recall_card_supported(i.owner_id, i.card_id))
      then 'superseded'
    when i.item_kind = 'action' and
      (o.opportunity_id is null or not o.active or o.card_id <> i.card_id
       or o.available_at > now() or o.expires_at <= now()
       or (case when i.paired_action then c.revision else o.revision end) <> i.revision
       or (not i.paired_action and c.kind = 'habit-action' and c.cue_card_id is not null)
       or (i.paired_action and (c.kind <> 'habit-action' or c.due_at > now() or not exists (
         select 1 from flashcards_private.cards cue where cue.owner_id = i.owner_id
           and cue.id = c.cue_card_id and cue.kind = 'habit-recall' and cue.active)))
       or exists (select 1 from flashcards_private.action_responses other
                  where other.owner_id = i.owner_id and other.opportunity_id = i.opportunity_id
                    and (other.outcome in ('yes','no') or
                         (i.paired_action and other.outcome = 'no_opportunity'))))
      then 'superseded'
  end as answer,
  case when r.finished_at is not null then i.final_answered_at
       else coalesce(v.reviewed_at, a.answered_at) end as answered_at,
  i.paired_action
from flashcards_private.round_items i
join flashcards_private.practice_rounds r using (owner_id, round_id)
left join flashcards_private.cards c on c.owner_id = i.owner_id and c.id = i.card_id
left join flashcards_private.action_opportunities o
  on o.owner_id = i.owner_id and o.opportunity_id = i.opportunity_id
left join flashcards_private.reviews v on i.item_kind = 'review' and v.owner_id = i.owner_id
  and v.review_id = i.event_id and v.card_id = i.card_id and v.card_revision = i.revision
left join flashcards_private.action_responses a on i.item_kind = 'action' and a.owner_id = i.owner_id
  and a.action_id = i.event_id and a.opportunity_id = i.opportunity_id
  and a.card_id = i.card_id and a.revision = i.revision;

revoke all on flashcards_private.practice_rounds, flashcards_private.round_items,
  flashcards_private.round_completions, flashcards_private.round_manifest
  from public, anon, authenticated, service_role;

-- Coordinate previously queued responses with a concurrent Finish. A write
-- takes a shared round lock; Finish takes the exclusive row lock. Replays of
-- already-stored answers never insert, so they still return their receipts.
create function flashcards_private.guard_round_receipt()
returns trigger language plpgsql security invoker set search_path = '' as $$
declare
  answer_id uuid;
  target record;
begin
  if tg_table_name = 'reviews' then
    answer_id := new.review_id;
  else
    answer_id := new.action_id;
  end if;

  select r.finished_at, i.item_kind, i.paired_action, i.card_id, i.revision, i.opportunity_id
    into target
    from flashcards_private.round_items i
    join flashcards_private.practice_rounds r using (owner_id, round_id)
    where i.owner_id = new.owner_id and i.event_id = answer_id
    for share of r;
  if not found then return new; end if;
  if target.finished_at is not null then
    raise exception using errcode = 'PT409', message = 'Round is already finished';
  end if;
  if target.card_id <> new.card_id then
    raise exception using errcode = '22023', message = 'Answer belongs to a different card';
  end if;
  if tg_table_name = 'reviews' then
    -- A scheduled action records its own FSRS grade and opportunity receipt.
    if (target.item_kind <> 'review' and not target.paired_action)
       or target.revision <> new.card_revision then
      raise exception using errcode = '22023', message = 'Review does not match round item';
    end if;
  else
    if target.item_kind <> 'action' or target.opportunity_id <> new.opportunity_id
       or target.revision <> new.revision then
      raise exception using errcode = '22023', message = 'Opportunity does not match round item';
    end if;
  end if;
  return new;
end $$;
revoke all on function flashcards_private.guard_round_receipt()
  from public, anon, authenticated, service_role;
create trigger guard_round_review before insert on flashcards_private.reviews
  for each row execute function flashcards_private.guard_round_receipt();
create trigger guard_round_action before insert on flashcards_private.action_responses
  for each row execute function flashcards_private.guard_round_receipt();

create function flashcards_private.request_round(p_action text, p_round_id uuid)
returns table (round_id uuid, finished_at timestamptz, "position" integer, item_kind text, event_id uuid,
  card_id uuid, revision integer, front text, back text, opportunity_id uuid, due_at timestamptz,
  answer text, answered_at timestamptz, paired_action boolean)
language plpgsql volatile security definer set search_path = '' as $$
declare
  actor uuid := auth.uid();
  chosen uuid;
  completed timestamptz;
begin
  if actor is null or not exists (
    select 1 from flashcards_private.app_owner e where e.owner_id = actor
  ) then
    raise exception using errcode = '42501', message = 'Deck enrollment required';
  end if;
  if p_action is null or p_action not in ('latest','open','finish')
     or (p_action <> 'latest' and p_round_id is null) then
    raise exception using errcode = '22023', message = 'Invalid round request';
  end if;

  if p_action = 'latest' then
    select r.round_id into chosen from flashcards_private.practice_rounds r
      where r.owner_id = actor
      order by (r.finished_at is null) desc, r.opened_at desc, r.round_id desc limit 1;
  elsif p_action = 'open' then
    -- Serialize starts even when the deck has no round row yet.
    perform 1 from flashcards_private.app_owner e where e.owner_id = actor for update;
    select r.round_id into chosen from flashcards_private.practice_rounds r
      where r.owner_id = actor and (r.round_id = p_round_id or r.finished_at is null)
      order by (r.round_id = p_round_id) desc limit 1;
    if chosen is null then
      chosen := p_round_id;
      insert into flashcards_private.practice_rounds(owner_id, round_id) values (actor, chosen);
      insert into flashcards_private.round_items
        (owner_id, round_id, "position", item_kind, card_id, revision, front, back,
         opportunity_id, due_at, paired_action)
      select actor, chosen, (row_number() over (order by q.phase, q.ord) - 1)::integer,
        q.kind, q.card, q.rev, q.front_text, q.back_text, q.occasion, q.due, q.paired
      from (
        select 0 as phase, o.ordinality as ord, 'action' as kind, o.card_id as card,
          o.revision as rev, o.prompt as front_text, o.cue as back_text,
          o.opportunity_id as occasion, null::timestamptz as due, o.scheduled as paired
        from flashcards_private.recall_action_queue(100) with ordinality as o
        union all
        select 1, d.ordinality, 'review', d.card_id, d.revision, d.front, d.back,
          null::uuid, d.due_at, false
        from flashcards_private.recall_due(5) with ordinality as d
      ) q;
      if not found then
        delete from flashcards_private.practice_rounds r where r.owner_id = actor and r.round_id = chosen;
        return;
      end if;
    end if;
  else
    chosen := p_round_id;
    select r.finished_at into completed from flashcards_private.practice_rounds r
      where r.owner_id = actor and r.round_id = chosen for update;
    if not found then
      raise exception using errcode = 'PT404', message = 'Round not found';
    end if;
    if completed is null then
      update flashcards_private.round_items i
        set final_answer = m.answer, final_answered_at = m.answered_at
        from flashcards_private.round_manifest m
        where m.owner_id = actor and m.round_id = chosen
          and i.owner_id = m.owner_id and i.event_id = m.event_id;
      if exists (select 1 from flashcards_private.round_items i where i.owner_id = actor
                 and i.round_id = chosen and i.final_answer is null) then
        raise exception using errcode = 'PT409', message = 'Some responses are still pending';
      end if;
      completed := clock_timestamp();
      update flashcards_private.practice_rounds r set finished_at = completed
        where r.owner_id = actor and r.round_id = chosen;
      insert into flashcards_private.round_completions
        (owner_id, round_id, finished_at, review_count, action_count, superseded_count, outcomes)
      select actor, chosen, completed,
        coalesce(sum(t.n) filter (where t.kind = 'review' and t.answer <> 'superseded'),0)::integer,
        coalesce(sum(t.n) filter (where t.kind = 'action' and t.answer <> 'superseded'),0)::integer,
        coalesce(sum(t.n) filter (where t.answer = 'superseded'),0)::integer,
        coalesce(jsonb_object_agg(t.answer, t.n) filter (where t.answer <> 'superseded'),'{}'::jsonb)
      from (select i.item_kind as kind, i.final_answer as answer, count(*) as n
            from flashcards_private.round_items i where i.owner_id = actor and i.round_id = chosen
            group by i.item_kind, i.final_answer) t;
    end if;
  end if;
  return query select m.round_id, m.finished_at, m."position", m.item_kind, m.event_id, m.card_id,
    m.revision, m.front, m.back, m.opportunity_id, m.due_at, m.answer, m.answered_at, m.paired_action
    from flashcards_private.round_manifest m where m.owner_id = actor and m.round_id = chosen order by m."position";
end $$;
revoke all on function flashcards_private.request_round(text,uuid) from public, anon, authenticated, service_role;
grant execute on function flashcards_private.request_round(text,uuid) to authenticated;

create function public.recall_latest_round()
returns table (round_id uuid, finished_at timestamptz, "position" integer, item_kind text, event_id uuid,
  card_id uuid, revision integer, front text, back text, opportunity_id uuid, due_at timestamptz,
  answer text, answered_at timestamptz, paired_action boolean)
language sql volatile security invoker set search_path = '' as $$
  select * from flashcards_private.request_round('latest', null::uuid) order by "position"
$$;
revoke all on function public.recall_latest_round() from public, anon, authenticated, service_role;
grant execute on function public.recall_latest_round() to authenticated;

create function public.recall_open_round(p_round_id uuid)
returns table (round_id uuid, finished_at timestamptz, "position" integer, item_kind text, event_id uuid,
  card_id uuid, revision integer, front text, back text, opportunity_id uuid, due_at timestamptz,
  answer text, answered_at timestamptz, paired_action boolean)
language sql volatile security invoker set search_path = '' as $$
  select * from flashcards_private.request_round('open', p_round_id) order by "position"
$$;
revoke all on function public.recall_open_round(uuid) from public, anon, authenticated, service_role;
grant execute on function public.recall_open_round(uuid) to authenticated;

create function public.recall_finish_round(p_round_id uuid)
returns table (round_id uuid, finished_at timestamptz, "position" integer, item_kind text, event_id uuid,
  card_id uuid, revision integer, front text, back text, opportunity_id uuid, due_at timestamptz,
  answer text, answered_at timestamptz, paired_action boolean)
language sql volatile security invoker set search_path = '' as $$
  select * from flashcards_private.request_round('finish', p_round_id) order by "position"
$$;
revoke all on function public.recall_finish_round(uuid) from public, anon, authenticated, service_role;
grant execute on function public.recall_finish_round(uuid) to authenticated;

notify pgrst, 'reload schema';
commit;
