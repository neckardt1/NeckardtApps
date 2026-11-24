-- Give each card an explicit review behavior. An imported kind is trustworthy;
-- a matching title or prompt is not evidence that two cards form a pair.
begin;

alter table flashcards_private.cards
  add column kind text not null default 'fact'
    check (kind in ('fact', 'habit-recall', 'habit-action', 'reflection', 'unsupported')),
  add column cue_card_id uuid,
  add column cue_kind text generated always as (
    case when cue_card_id is not null then 'habit-recall'::text end
  ) stored,
  add constraint cards_owner_id_kind unique (owner_id, id, kind),
  add constraint action_cue_same_owner_and_kind foreign key (owner_id, cue_card_id, cue_kind)
    references flashcards_private.cards(owner_id, id, kind),
  add constraint action_cue_only check
    (cue_card_id is null or (kind = 'habit-action' and cue_card_id <> id));
create unique index one_action_per_cue on flashcards_private.cards(owner_id, cue_card_id)
  where cue_card_id is not null;

do $$
begin
  if to_regclass('flashcards_private.notion_imports') is not null then
    update flashcards_private.cards c
       set kind = i.kind
      from (
        select owner_id, card_id,
               case when count(*) = count(kind) and min(kind) = max(kind)
                     and min(kind) in ('fact','habit-recall','habit-action','reflection')
                    then min(kind) else 'unsupported' end as kind
          from flashcards_private.notion_imports
         group by owner_id, card_id
      ) i
     where c.owner_id = i.owner_id and c.id = i.card_id;
  end if;
end $$;

create or replace function flashcards_private.recall_card_supported(p_owner uuid, p_card_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from flashcards_private.cards c
    where c.owner_id = p_owner and c.id = p_card_id and c.kind in ('fact','habit-recall'))
$$;

-- A linked action references its cue by ID. Both members must be active to
-- schedule the action. Unpaired imported actions await an explicit pairing.
create function flashcards_private.recall_action_queue(p_limit integer)
returns table(opportunity_id uuid, card_id uuid, revision integer, prompt text, cue text, scheduled boolean)
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
       where o.owner_id = v_owner and o.active and o.available_at <= now()
         and (o.expires_at is null or o.expires_at > now())
         and (c.cue_card_id is null or
              (c.active and c.due_at <= now() and cue_card.active and cue_card.kind = 'habit-recall'))
         and not exists (
           select 1 from flashcards_private.action_responses r
            where (r.owner_id, r.opportunity_id) = (o.owner_id, o.opportunity_id)
              and (r.outcome in ('yes','no') or (c.cue_card_id is not null and (
                r.outcome = 'no_opportunity' or (r.outcome = 'skip' and
                  (r.answered_at at time zone 'America/Los_Angeles')::date >=
                  (now() at time zone 'America/Los_Angeles')::date)))))
    )
    select q.opportunity_id, q.card_id, q.revision, q.prompt, q.cue, q.scheduled
      from candidates q where not q.scheduled or q.ordinal = 1
     order by q.available_at, q.opportunity_id limit least(100, greatest(1, coalesce(p_limit,100)));
end $$;
create function public.recall_action_queue(p_limit integer default 100)
returns table(opportunity_id uuid, card_id uuid, revision integer, prompt text, cue text, scheduled boolean)
language sql stable security invoker set search_path = '' as $$
  select * from flashcards_private.recall_action_queue(p_limit)
$$;

-- Cached clients only understand ledger-only opportunities.
create or replace function flashcards_private.recall_opportunities(p_limit integer)
returns table(opportunity_id uuid, card_id uuid, revision integer, prompt text, cue text)
language plpgsql stable security definer set search_path = '' as $$
declare v_owner uuid := auth.uid();
begin
  if not exists (select 1 from flashcards_private.app_owner a where a.owner_id = v_owner) then
    raise exception using errcode = '42501', message = 'Deck enrollment required';
  end if;
  return query select o.opportunity_id,o.card_id,o.revision,o.prompt,o.cue
    from flashcards_private.action_opportunities o
    join flashcards_private.cards c on (c.owner_id,c.id) = (o.owner_id,o.card_id)
    where o.owner_id=v_owner and o.active and o.available_at<=now() and c.cue_card_id is null
      and (o.expires_at is null or o.expires_at>now())
      and not exists (select 1 from flashcards_private.action_responses r
        where r.owner_id=v_owner and r.opportunity_id=o.opportunity_id and r.outcome in ('yes','no'))
    order by o.available_at,o.opportunity_id limit least(100,greatest(1,coalesce(p_limit,100)));
end $$;

-- Kept behind its compatibility wrapper for existing, unpaired check-ins.
alter function flashcards_private.recall_record_action(uuid,uuid,uuid,integer,text,timestamptz)
  rename to recall_record_legacy_action;
revoke all on function flashcards_private.recall_record_legacy_action(uuid,uuid,uuid,integer,text,timestamptz)
  from public, anon, authenticated, service_role;

create function flashcards_private.recall_check_in(
  p_action_id uuid,p_opportunity_id uuid,p_card_id uuid,p_revision integer,p_outcome text,p_answered_at timestamptz
) returns setof flashcards_private.action_responses language plpgsql volatile security definer set search_path = '' as $$
declare
  v_owner uuid := auth.uid();
  o flashcards_private.action_opportunities%rowtype;
  c flashcards_private.cards%rowtype;
  r flashcards_private.action_responses%rowtype;
begin
  if not exists (select 1 from flashcards_private.app_owner a where a.owner_id = v_owner) then
    raise exception using errcode='42501', message='Deck enrollment required';
  end if;
  -- Lock in the same order as the grading transaction.
  select * into c from flashcards_private.cards where owner_id=v_owner and id=p_card_id for update;
  if not found then raise exception using errcode='PT404', message='Card not found'; end if;
  if c.cue_card_id is null then
    perform flashcards_private.recall_record_legacy_action(
      p_action_id,p_opportunity_id,p_card_id,p_revision,p_outcome,p_answered_at);
    return query select a.* from flashcards_private.action_responses a
      where a.owner_id=v_owner and a.action_id=p_action_id;
    return;
  end if;
  select * into o from flashcards_private.action_opportunities
    where owner_id=v_owner and opportunity_id=p_opportunity_id for update;
  if not found then raise exception using errcode='PT404', message='Opportunity not found'; end if;
  select * into r from flashcards_private.action_responses where owner_id=v_owner and action_id=p_action_id;
  if found then
    if (r.opportunity_id,r.card_id,r.revision,r.outcome,r.answered_at)
      is distinct from (p_opportunity_id,p_card_id,p_revision,p_outcome,p_answered_at) then
      raise exception using errcode='22023',message='Action ID belongs to a different response';
    end if;
  else
    if p_action_id is null or p_outcome is null or p_outcome not in ('no_opportunity','skip') then
      raise exception using errcode='22023', message='Paired Yes and No require scheduled grading';
    end if;
    if not c.active or not o.active or o.card_id <> c.id or c.revision is distinct from p_revision
       or not exists (select 1 from flashcards_private.cards cue
           where cue.owner_id=v_owner and cue.id=c.cue_card_id and cue.kind='habit-recall' and cue.active)
       or exists (select 1 from flashcards_private.action_responses a where a.owner_id=v_owner
           and a.opportunity_id=o.opportunity_id and a.outcome in ('yes','no','no_opportunity')) then
      raise exception using errcode='PT409', message='Opportunity changed';
    end if;
    if p_answered_at is null or not isfinite(p_answered_at) or p_answered_at>now()+interval '5 minutes'
       or o.available_at>now() or p_answered_at<o.available_at
       or (o.expires_at is not null and p_answered_at>=o.expires_at) then
      raise exception using errcode='22023',message='Invalid opportunity response time';
    end if;
    insert into flashcards_private.action_responses(owner_id,action_id,opportunity_id,card_id,revision,outcome,answered_at)
      values(v_owner,p_action_id,p_opportunity_id,p_card_id,p_revision,p_outcome,p_answered_at) returning * into r;
  end if;
  return next r;
end $$;
create function public.recall_check_in(
  p_action_id uuid,p_opportunity_id uuid,p_card_id uuid,p_revision integer,p_outcome text,p_answered_at timestamptz
) returns table(action_id uuid, opportunity_id uuid, card_id uuid, revision integer, outcome text, answered_at timestamptz)
language sql volatile security invoker set search_path = '' as $$
  select a.action_id, a.opportunity_id, a.card_id, a.revision, a.outcome, a.answered_at
    from flashcards_private.recall_check_in(p_action_id,p_opportunity_id,p_card_id,p_revision,p_outcome,p_answered_at) a
$$;
-- Preserve the cached clients' object-shaped, scalar receipt.
create or replace function public.recall_record_action(
  p_action_id uuid,p_opportunity_id uuid,p_card_id uuid,p_revision integer,p_outcome text,p_answered_at timestamptz
) returns jsonb language sql volatile security invoker set search_path = '' as $$
  select to_jsonb(a) from public.recall_check_in(p_action_id,p_opportunity_id,p_card_id,p_revision,p_outcome,p_answered_at) a
$$;

-- Prepare and commit use one check function. Commit repeats that check under a
-- row lock after the Edge scheduler has run. No database lock spans the network.
create function flashcards_private.recall_prepare_answer(
  p_owner uuid, p_review_id uuid, p_card_id uuid, p_revision integer, p_grade text, p_reviewed_at timestamptz,
  p_opportunity_id uuid default null
) returns table(kind text, review_id uuid, card_id uuid, revision integer, due_at timestamptz, scheduler_state jsonb)
language plpgsql volatile security definer set search_path = '' as $$
declare
  c flashcards_private.cards%rowtype;
  r flashcards_private.reviews%rowtype;
  a flashcards_private.action_responses%rowtype;
  o flashcards_private.action_opportunities%rowtype;
begin
  if not exists (select 1 from flashcards_private.app_owner e where e.owner_id=p_owner) then
    raise exception using errcode='42501', message='Deck enrollment required';
  end if;
  if p_review_id is null or p_card_id is null or p_revision is null or p_revision < 0
     or p_grade is null or p_grade not in ('miss','hard','medium','easy')
     or p_reviewed_at is null or not isfinite(p_reviewed_at) then
    raise exception using errcode='22023', message='Invalid answer';
  end if;
  select * into c from flashcards_private.cards x where x.owner_id=p_owner and x.id=p_card_id;
  if not found then raise exception using errcode='PT404', message='Card not found'; end if;

  -- Look for a receipt before any mutable eligibility check. Even if the card
  -- is edited, retired, or its opportunity expires, a lost ack is recoverable.
  select * into a from flashcards_private.action_responses x where x.owner_id=p_owner and x.action_id=p_review_id;
  select * into r from flashcards_private.reviews x where x.owner_id=p_owner and x.review_id=p_review_id;
  if found then
    if (r.card_id, r.card_revision, r.grade, r.reviewed_at, a.opportunity_id)
       is distinct from (p_card_id, p_revision, p_grade, p_reviewed_at, p_opportunity_id) then
      raise exception using errcode='22023', message='Answer ID already belongs to a different response';
    end if;
    return query select 'replay'::text, r.review_id, r.card_id, r.card_revision+1, r.next_due_at, null::jsonb;
    return;
  end if;
  if a.action_id is not null then
    raise exception using errcode='22023', message='Answer ID already belongs to a check-in';
  end if;
  if not c.active or c.revision<>p_revision then
    raise exception using errcode='PT409', message='Card changed';
  end if;
  if p_reviewed_at > now()+interval '5 minutes' or p_reviewed_at <= c.last_review_at then
    raise exception using errcode='22023', message='Invalid answer time';
  end if;
  if p_opportunity_id is null then
    if c.kind not in ('fact','habit-recall') then
      raise exception using errcode='22023', message='This card does not support memory grading';
    end if;
  else
    select * into o from flashcards_private.action_opportunities x
      where x.owner_id=p_owner and x.opportunity_id=p_opportunity_id and x.card_id=c.id;
    if not found then raise exception using errcode='PT404', message='Opportunity not found'; end if;
    if p_grade not in ('miss','medium') then
      raise exception using errcode='22023', message='A fresh action accepts only Yes or No';
    end if;
    if c.kind<>'habit-action' or c.cue_card_id is null or not o.active
       or c.due_at>now() or o.available_at>now()
       or not exists (select 1 from flashcards_private.cards cue where cue.owner_id=p_owner
         and cue.id=c.cue_card_id and cue.kind='habit-recall' and cue.active)
       or exists (select 1 from flashcards_private.action_responses x where x.owner_id=p_owner
         and x.opportunity_id=o.opportunity_id and x.outcome in ('yes','no','no_opportunity')) then
      raise exception using errcode='PT409', message='Action is no longer eligible';
    end if;
    if p_reviewed_at<o.available_at or p_reviewed_at>=o.expires_at then
      raise exception using errcode='22023', message='Answer was outside this opportunity';
    end if;
  end if;
  if c.scheduler_state is null and (c.revision<>0 or c.last_review_at is not null) then
    raise exception using errcode='22023', message='Missing schedule for previously reviewed card';
  elsif c.scheduler_state is not null and jsonb_typeof(c.scheduler_state)<>'object' then
    raise exception using errcode='22023', message='Invalid stored schedule';
  end if;
  return query select case when c.scheduler_state is null then 'new_card' else 'studied_card' end,
    p_review_id, c.id, c.revision, c.due_at, c.scheduler_state;
end $$;

create function public.recall_prepare_answer(
  p_owner uuid, p_review_id uuid, p_card_id uuid, p_revision integer, p_grade text, p_reviewed_at timestamptz,
  p_opportunity_id uuid default null
) returns table(kind text, review_id uuid, card_id uuid, revision integer, due_at timestamptz, scheduler_state jsonb)
language sql volatile security invoker set search_path = '' as $$
  select * from flashcards_private.recall_prepare_answer(
    p_owner, p_review_id, p_card_id, p_revision, p_grade, p_reviewed_at, p_opportunity_id)
$$;

create function flashcards_private.recall_commit_answer(
  p_owner uuid, p_review_id uuid, p_card_id uuid, p_revision integer, p_grade text, p_reviewed_at timestamptz,
  p_due_at timestamptz, p_state jsonb, p_log jsonb, p_scheduler_build text, p_scheduler_config jsonb,
  p_opportunity_id uuid default null
) returns table(kind text, review_id uuid, card_id uuid, revision integer, due_at timestamptz, scheduler_state jsonb)
language plpgsql volatile security definer set search_path = '' as $$
declare ctx record;
begin
  perform 1 from flashcards_private.cards c where c.owner_id=p_owner and c.id=p_card_id for update;
  if p_opportunity_id is not null then
    perform 1 from flashcards_private.action_opportunities o where o.owner_id=p_owner
      and o.card_id=p_card_id and o.opportunity_id=p_opportunity_id for update;
  end if;
  select * into strict ctx from flashcards_private.recall_prepare_answer(
    p_owner, p_review_id, p_card_id, p_revision, p_grade, p_reviewed_at, p_opportunity_id);
  if ctx.kind='replay' then
    return query select ctx.kind, ctx.review_id, ctx.card_id, ctx.revision, ctx.due_at, ctx.scheduler_state;
    return;
  end if;
  if p_due_at is null or not isfinite(p_due_at) or p_due_at<=p_reviewed_at
     or jsonb_typeof(p_state) is distinct from 'object' or jsonb_typeof(p_log) is distinct from 'object'
     or jsonb_typeof(p_scheduler_config) is distinct from 'object' or nullif(p_scheduler_build,'') is null then
    raise exception using errcode='22023', message='Invalid scheduler result';
  end if;

  insert into flashcards_private.reviews(owner_id,review_id,card_id,card_revision,grade,reviewed_at,
    next_due_at,fsrs_log,after_state,scheduler_build,scheduler_config)
    values(p_owner,p_review_id,p_card_id,p_revision,p_grade,p_reviewed_at,
      p_due_at,p_log,p_state,p_scheduler_build,p_scheduler_config);
  update flashcards_private.cards c set revision=p_revision+1, due_at=p_due_at,
    last_review_at=p_reviewed_at, scheduler_state=p_state where c.owner_id=p_owner and c.id=p_card_id;
  if p_opportunity_id is not null then
    insert into flashcards_private.action_responses(owner_id,action_id,opportunity_id,card_id,revision,outcome,answered_at)
      values(p_owner,p_review_id,p_opportunity_id,p_card_id,p_revision,
        case when p_grade='medium' then 'yes' else 'no' end, p_reviewed_at);
  end if;
  return query select 'saved'::text, p_review_id, p_card_id, p_revision+1, p_due_at, null::jsonb;
end $$;

create function public.recall_commit_answer(
  p_owner uuid, p_review_id uuid, p_card_id uuid, p_revision integer, p_grade text, p_reviewed_at timestamptz,
  p_due_at timestamptz, p_state jsonb, p_log jsonb, p_scheduler_build text, p_scheduler_config jsonb,
  p_opportunity_id uuid default null
) returns table(kind text, review_id uuid, card_id uuid, revision integer, due_at timestamptz, scheduler_state jsonb)
language sql volatile security invoker set search_path = '' as $$
  select * from flashcards_private.recall_commit_answer(
    p_owner, p_review_id, p_card_id, p_revision, p_grade, p_reviewed_at,
    p_due_at, p_state, p_log, p_scheduler_build, p_scheduler_config, p_opportunity_id)
$$;

grant usage on schema flashcards_private to service_role;
revoke all on function
  flashcards_private.recall_action_queue(integer), public.recall_action_queue(integer),
  flashcards_private.recall_check_in(uuid,uuid,uuid,integer,text,timestamptz),
  public.recall_check_in(uuid,uuid,uuid,integer,text,timestamptz),
  flashcards_private.recall_prepare_answer(uuid,uuid,uuid,integer,text,timestamptz,uuid),
  public.recall_prepare_answer(uuid,uuid,uuid,integer,text,timestamptz,uuid),
  flashcards_private.recall_commit_answer(uuid,uuid,uuid,integer,text,timestamptz,timestamptz,jsonb,jsonb,text,jsonb,uuid),
  public.recall_commit_answer(uuid,uuid,uuid,integer,text,timestamptz,timestamptz,jsonb,jsonb,text,jsonb,uuid)
  from public, anon, authenticated, service_role;
grant execute on function flashcards_private.recall_action_queue(integer), public.recall_action_queue(integer),
  flashcards_private.recall_check_in(uuid,uuid,uuid,integer,text,timestamptz),
  public.recall_check_in(uuid,uuid,uuid,integer,text,timestamptz) to authenticated;
grant execute on function
  flashcards_private.recall_prepare_answer(uuid,uuid,uuid,integer,text,timestamptz,uuid),
  public.recall_prepare_answer(uuid,uuid,uuid,integer,text,timestamptz,uuid),
  flashcards_private.recall_commit_answer(uuid,uuid,uuid,integer,text,timestamptz,timestamptz,jsonb,jsonb,text,jsonb,uuid),
  public.recall_commit_answer(uuid,uuid,uuid,integer,text,timestamptz,timestamptz,jsonb,jsonb,text,jsonb,uuid) to service_role;

notify pgrst, 'reload schema';
commit;
