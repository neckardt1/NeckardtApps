begin;

-- All three readers use the same eligible occasions. Pagination and the round's
-- 100-check-in limit are applied after eligibility and per-pair deduplication.
create function flashcards_private.eligible_habit_actions()
returns table(opportunity_id uuid, card_id uuid, revision integer, prompt text, cue text, scheduled boolean, available_at timestamptz)
language plpgsql stable security definer set search_path = '' as $$
declare v_owner uuid := auth.uid();
begin
  if not exists (select 1 from flashcards_private.app_owner a where a.owner_id = v_owner) then
    raise exception using errcode = '42501', message = 'Deck enrollment required';
  end if;
  return query
    with candidates as (
      select o.opportunity_id, o.card_id,
             case when c.cue_card_id is null then o.revision else c.revision end as revision,
             o.prompt, o.cue, c.cue_card_id is not null as scheduled, o.available_at,
             row_number() over (partition by o.card_id order by o.available_at, o.opportunity_id) as ordinal
        from flashcards_private.action_opportunities o
        join flashcards_private.cards c on (c.owner_id, c.id) = (o.owner_id, o.card_id)
        left join flashcards_private.cards cue_card on (cue_card.owner_id, cue_card.id) = (c.owner_id, c.cue_card_id)
       where o.owner_id = v_owner and o.active and c.active and o.available_at <= now()
         and (o.expires_at is null or o.expires_at > now())
         and (c.cue_card_id is null or
              (c.due_at <= now() and cue_card.active and cue_card.kind = 'habit-recall'))
         and not exists (
           select 1 from flashcards_private.action_responses r
            where (r.owner_id, r.opportunity_id) = (o.owner_id, o.opportunity_id)
              and (r.outcome in ('yes','no') or (c.cue_card_id is not null and (
                r.outcome = 'no_opportunity' or (r.outcome = 'skip' and
                  (r.answered_at at time zone 'America/Los_Angeles')::date >=
                  (now() at time zone 'America/Los_Angeles')::date)))))
    )
    select q.opportunity_id, q.card_id, q.revision, q.prompt, q.cue, q.scheduled, q.available_at
      from candidates q where not q.scheduled or q.ordinal = 1
     order by q.available_at, q.opportunity_id;
end $$;

revoke all on function flashcards_private.eligible_habit_actions() from public, anon, authenticated, service_role;
grant execute on function flashcards_private.eligible_habit_actions() to authenticated;

create or replace function flashcards_private.recall_action_queue(p_limit integer)
returns table(opportunity_id uuid, card_id uuid, revision integer, prompt text, cue text, scheduled boolean)
language sql stable security invoker set search_path = '' as $$
  select a.opportunity_id, a.card_id, a.revision, a.prompt, a.cue, a.scheduled
  from flashcards_private.eligible_habit_actions() a
  order by a.available_at, a.opportunity_id limit least(100, greatest(1, coalesce(p_limit, 100)))
$$;

create or replace function flashcards_private.recall_opportunities(p_limit integer)
returns table(opportunity_id uuid, card_id uuid, revision integer, prompt text, cue text)
language sql stable security invoker set search_path = '' as $$
  select a.opportunity_id, a.card_id, a.revision, a.prompt, a.cue
  from flashcards_private.eligible_habit_actions() a where not a.scheduled
  order by a.available_at, a.opportunity_id limit least(100, greatest(1, coalesce(p_limit, 100)))
$$;

-- Confirmed receipts still replay. A fresh legacy check-in from a cached tab
-- must respect a later pause just as a paired check-in already does.
create or replace function flashcards_private.recall_record_legacy_action(
  p_action_id uuid,p_opportunity_id uuid,p_card_id uuid,p_revision integer,p_outcome text,p_answered_at timestamptz
) returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare
  v_owner uuid := auth.uid();
  o flashcards_private.action_opportunities%rowtype;
  r flashcards_private.action_responses%rowtype;
begin
  if v_owner is null or not exists (select 1 from flashcards_private.app_owner a where a.owner_id=v_owner) then
    raise exception using errcode='42501',message='Configured flashcard owner required';
  end if;
  if p_action_id is null or p_opportunity_id is null or p_card_id is null
    or p_revision is null or p_revision<0 or p_revision>=2147483647
    or p_outcome is null or p_outcome not in ('yes','no','no_opportunity','skip')
    or p_answered_at is null or not isfinite(p_answered_at) then
    raise exception using errcode='22023',message='Invalid opportunity response';
  end if;
  select * into o from flashcards_private.action_opportunities a
    where a.owner_id=v_owner and a.opportunity_id=p_opportunity_id for update;
  if not found then raise exception using errcode='PT404',message='Opportunity not found'; end if;
  select * into r from flashcards_private.action_responses a where a.owner_id=v_owner and a.action_id=p_action_id;
  if found then
    if (r.opportunity_id,r.card_id,r.revision,r.outcome,r.answered_at)
      is distinct from (p_opportunity_id,p_card_id,p_revision,p_outcome,p_answered_at) then
      raise exception using errcode='22023',message='Action ID belongs to a different response';
    end if;
  else
    if not o.active or o.revision<>p_revision or o.card_id<>p_card_id
      or not exists (select 1 from flashcards_private.cards c where c.owner_id=v_owner and c.id=p_card_id and c.active)
      or o.available_at>now()
      or exists (select 1 from flashcards_private.action_responses a
        where a.owner_id=v_owner and a.opportunity_id=p_opportunity_id and a.outcome in ('yes','no')) then
      raise exception using errcode='PT409',message='Opportunity changed or was already answered';
    end if;
    if p_answered_at>now()+interval '5 minutes' or p_answered_at<o.available_at
      or (o.expires_at is not null and p_answered_at>=o.expires_at) then
      raise exception using errcode='22023',message='Invalid opportunity response time';
    end if;
    insert into flashcards_private.action_responses(owner_id,action_id,opportunity_id,card_id,revision,outcome,answered_at)
      values(v_owner,p_action_id,p_opportunity_id,p_card_id,p_revision,p_outcome,p_answered_at)
      returning * into r;
  end if;
  return jsonb_build_object('action_id',r.action_id,'opportunity_id',r.opportunity_id,
    'card_id',r.card_id,'revision',r.revision,'outcome',r.outcome,'answered_at',r.answered_at);
end $$;

-- The JSON API is additive for existing browser bundles. Its cursor and
-- original columns keep the same meaning.
grant select (cue_card_id), update (active) on flashcards_private.cards to authenticated;
create policy own_card_activity on flashcards_private.cards for update to authenticated
  using (owner_id = (select auth.uid())) with check (owner_id = (select auth.uid()));

drop function public.recall_browse_cards(uuid);
create function public.recall_browse_cards(p_after uuid default null)
returns table(card_id uuid, front text, back text, kind text, active boolean, due_at timestamptz,
              cue_card_id uuid, check_in_available boolean)
language sql stable security invoker set search_path = '' as $$
  select c.id, c.front, c.back, c.kind, c.active, c.due_at, c.cue_card_id,
         c.id in (select a.card_id from flashcards_private.eligible_habit_actions() a)
  from flashcards_private.cards c
  where c.owner_id = (select auth.uid()) and (p_after is null or c.id > p_after)
  order by c.id limit 100
$$;

-- Count scheduled recall separately from real occasions. A preview never
-- creates, resumes or completes a round.
create function public.recall_round_preview()
returns table(due_reviews bigint, check_ins bigint, next_review_at timestamptz)
language sql stable security invoker set search_path = '' as $$
  select count(*) filter (where c.due_at <= now()),
         (select count(*) from flashcards_private.recall_action_queue(100)),
         min(c.due_at) filter (where c.due_at > now())
  from flashcards_private.cards c
  where c.owner_id = (select auth.uid()) and c.active and c.kind in ('fact', 'habit-recall')
$$;

-- Change only the explicitly selected rows. A missing or foreign ID rolls the
-- entire statement back. Repeating the same requested state is safe.
create function public.recall_set_cards_active(p_card_ids uuid[], p_active boolean)
returns integer language plpgsql volatile security invoker set search_path = '' as $$
declare
  actor uuid := auth.uid();
  matched integer;
begin
  if actor is null or not exists (select 1 from flashcards_private.app_owner o where o.owner_id = actor) then
    raise exception using errcode='42501', message='Deck enrollment required';
  end if;
  if p_active is null or coalesce(cardinality(p_card_ids), 0) = 0
     or array_ndims(p_card_ids) <> 1
     or cardinality(p_card_ids) <> (select count(distinct id) from unnest(p_card_ids) id) then
    raise exception using errcode='22023', message='Select distinct cards';
  end if;
  update flashcards_private.cards c set active = p_active
    where c.owner_id = actor and c.id = any(p_card_ids);
  get diagnostics matched = row_count;
  if matched <> cardinality(p_card_ids) then
    raise exception using errcode='22023', message='Selection unavailable';
  end if;
  return matched;
end
$$;

-- The new optional size is consulted only when creating a fresh manifest.
-- Defaulted arguments preserve the calls made by open tabs and saved rounds.
drop function flashcards_private.request_round(text, uuid);
create function flashcards_private.request_round(p_action text, p_round_id uuid, p_review_limit integer default 5)
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
     or (p_action <> 'latest' and p_round_id is null)
     or p_review_limit is null or p_review_limit not between 1 and 100 then
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
        from flashcards_private.recall_due(p_review_limit) with ordinality as d
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
revoke all on function flashcards_private.request_round(text,uuid,integer) from public, anon, authenticated, service_role;
grant execute on function flashcards_private.request_round(text,uuid,integer) to authenticated;

drop function public.recall_open_round(uuid);
create function public.recall_open_round(p_round_id uuid, p_review_limit integer default 5)
returns table (round_id uuid, finished_at timestamptz, "position" integer, item_kind text, event_id uuid,
  card_id uuid, revision integer, front text, back text, opportunity_id uuid, due_at timestamptz,
  answer text, answered_at timestamptz, paired_action boolean)
language sql volatile security invoker set search_path = '' as $$
  select * from flashcards_private.request_round('open', p_round_id, p_review_limit) order by "position"
$$;
revoke all on function public.recall_open_round(uuid,integer) from public, anon, authenticated, service_role;
grant execute on function public.recall_open_round(uuid,integer) to authenticated;


revoke all on function public.recall_browse_cards(uuid), public.recall_round_preview(),
    public.recall_set_cards_active(uuid[], boolean) from public, anon, authenticated, service_role;
grant execute on function public.recall_browse_cards(uuid), public.recall_round_preview(),
    public.recall_set_cards_active(uuid[], boolean) to authenticated;

notify pgrst, 'reload schema';
commit;
