-- Private API and legacy compatibility prerequisite for the mobile UI.
-- Apply separately after review; this repository change does not apply it.
-- No opportunities or private card data are created by this migration.
begin;

create table flashcards_private.action_opportunities (
  opportunity_id uuid primary key default gen_random_uuid(),
  owner_id uuid not null,
  card_id uuid not null,
  revision integer not null default 0 check (revision >= 0 and revision < 2147483647),
  prompt text not null check (length(btrim(prompt)) > 0),
  cue text,
  available_at timestamptz not null default now(),
  expires_at timestamptz,
  active boolean not null default true,
  unique (owner_id, opportunity_id),
  foreign key (owner_id, card_id) references flashcards_private.cards(owner_id, id),
  check (expires_at is null or expires_at > available_at)
);
create index action_opportunities_due_idx on flashcards_private.action_opportunities(owner_id, available_at)
  where active;
create table flashcards_private.action_responses (
  owner_id uuid not null,
  action_id uuid not null,
  opportunity_id uuid not null,
  card_id uuid not null,
  revision integer not null check (revision >= 0),
  outcome text not null check (outcome in ('yes','no','no_opportunity','skip')),
  answered_at timestamptz not null,
  recorded_at timestamptz not null default now(),
  primary key (owner_id, action_id),
  foreign key (owner_id, opportunity_id) references flashcards_private.action_opportunities(owner_id, opportunity_id),
  foreign key (owner_id, card_id) references flashcards_private.cards(owner_id, id)
);
-- Yes/No consumes a distinct occasion once. No opportunity and Skip are
-- immutable check-ins, but leave that occasion available for a later session.
create unique index action_responses_once_idx
  on flashcards_private.action_responses(owner_id, opportunity_id) where outcome in ('yes','no');
alter table flashcards_private.action_opportunities enable row level security;
alter table flashcards_private.action_responses enable row level security;
revoke all on flashcards_private.action_opportunities, flashcards_private.action_responses
  from public, anon, authenticated, service_role;

-- New browser RPCs have invoker wrappers and definer entry helpers in the
-- non-exposed private schema. Entry helpers check the actual JWT owner. This
-- internal classifier has no client grants and also serves the existing
-- service-only grading API, whose owner was verified by the Edge Function.
create function flashcards_private.recall_card_supported(p_owner uuid, p_card_id uuid)
returns boolean language plpgsql stable security definer set search_path = '' as $$
begin
  if p_owner is null or not exists (select 1 from flashcards_private.app_owner o where o.owner_id=p_owner) then
    raise exception using errcode='42501',message='Configured flashcard owner required';
  end if;
  if to_regclass('flashcards_private.notion_imports') is not null then
    return not exists (select 1 from flashcards_private.notion_imports i
      where i.owner_id=p_owner and i.card_id=p_card_id and (i.kind is null or i.kind not in ('habit-recall','fact')));
  end if;
  return true;
end $$;

-- Preserve the existing service-only signature and ACL. Reject new unsupported
-- memory grades in prepare and in the locked commit recheck. Exact previously
-- committed receipts can still replay without scheduling or another write.
create or replace function public.recall_grade_context(
  p_owner uuid,p_review_id uuid,p_card_id uuid,p_revision integer,p_grade text,p_reviewed_at timestamptz
) returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare
  c flashcards_private.cards%rowtype;
  r flashcards_private.reviews%rowtype;
begin
  if p_owner is null or not exists (select 1 from flashcards_private.app_owner o where o.owner_id=p_owner) then
    raise exception using errcode='42501',message='Configured flashcard owner required';
  end if;
  if p_review_id is null or p_card_id is null or p_revision is null or p_revision<0
     or p_grade is null or p_grade not in ('miss','hard','medium','easy')
     or p_reviewed_at is null or not isfinite(p_reviewed_at) then
    raise exception using errcode='22023',message='Invalid review';
  end if;
  select * into c from flashcards_private.cards where owner_id=p_owner and id=p_card_id;
  if not found then raise exception using errcode='PT404',message='Card not found'; end if;
  select * into r from flashcards_private.reviews where owner_id=p_owner and review_id=p_review_id;
  if found then
    if (r.card_id,r.card_revision,r.grade,r.reviewed_at)
       is distinct from (p_card_id,p_revision,p_grade,p_reviewed_at) then
      raise exception using errcode='22023',message='Review ID already belongs to a different answer';
    end if;
    return jsonb_build_object('kind','replay','review_id',r.review_id,'card_id',r.card_id,
      'revision',r.card_revision+1,'due_at',r.next_due_at);
  end if;
  if not flashcards_private.recall_card_supported(p_owner,p_card_id) then
    raise exception using errcode='22023',message='This card does not support memory grading';
  end if;
  if not c.active or c.revision<>p_revision then
    raise exception using errcode='PT409',message='This card changed. Refresh before grading.';
  end if;
  if p_reviewed_at > now()+interval '5 minutes'
     or (c.last_review_at is not null and p_reviewed_at<=c.last_review_at) then
    raise exception using errcode='22023',message='Invalid review time';
  end if;
  return jsonb_build_object('kind','card','state',c.scheduler_state,'due_at',c.due_at);
end $$;

create function flashcards_private.recall_due(p_limit integer)
returns table(card_id uuid, front text, back text, revision integer, due_at timestamptz)
language plpgsql stable security definer set search_path = '' as $$
declare v_owner uuid := auth.uid();
begin
  if v_owner is null or not exists (select 1 from flashcards_private.app_owner o where o.owner_id=v_owner) then
    raise exception using errcode='42501',message='Configured flashcard owner required';
  end if;
  return query select c.id,c.front,c.back,c.revision,c.due_at
    from flashcards_private.cards c
    where c.owner_id=v_owner and c.active and c.due_at<=now()
      and flashcards_private.recall_card_supported(v_owner,c.id)
    order by c.due_at,c.id limit least(100,greatest(1,coalesce(p_limit,100)));
end $$;
create function public.recall_due(p_limit integer default 100)
returns table(card_id uuid, front text, back text, revision integer, due_at timestamptz)
language sql stable security invoker set search_path = '' as $$
  select * from flashcards_private.recall_due(p_limit)
$$;

-- Keep cached legacy clients on the same five-card contract, using the same
-- supported-card filter as the mobile UI. The private entry helper checks the
-- actual JWT owner. CREATE OR REPLACE preserves the legacy function's ACL;
-- filtering occurs before its limit, with no client grant on the classifier.
create or replace function public.demo_flashcards_due(p_limit integer default 5)
returns table(card_id uuid, front text, back text, revision integer, due_at timestamptz)
language sql stable security invoker set search_path = '' as $$
  select * from flashcards_private.recall_due(least(5,greatest(1,coalesce(p_limit,5))))
$$;

create function flashcards_private.recall_opportunities(p_limit integer)
returns table(opportunity_id uuid, card_id uuid, revision integer, prompt text, cue text)
language plpgsql stable security definer set search_path = '' as $$
declare v_owner uuid := auth.uid();
begin
  if v_owner is null or not exists (select 1 from flashcards_private.app_owner o where o.owner_id=v_owner) then
    raise exception using errcode='42501',message='Configured flashcard owner required';
  end if;
  return query select o.opportunity_id,o.card_id,o.revision,o.prompt,o.cue
    from flashcards_private.action_opportunities o
    where o.owner_id=v_owner and o.active and o.available_at<=now()
      and (o.expires_at is null or o.expires_at>now())
      and not exists (select 1 from flashcards_private.action_responses r
        where r.owner_id=v_owner and r.opportunity_id=o.opportunity_id and r.outcome in ('yes','no'))
    order by o.available_at,o.opportunity_id limit least(100,greatest(1,coalesce(p_limit,100)));
end $$;
create function public.recall_opportunities(p_limit integer default 100)
returns table(opportunity_id uuid, card_id uuid, revision integer, prompt text, cue text)
language sql stable security invoker set search_path = '' as $$
  select * from flashcards_private.recall_opportunities(p_limit)
$$;

create function flashcards_private.recall_record_action(
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
create function public.recall_record_action(
  p_action_id uuid,p_opportunity_id uuid,p_card_id uuid,p_revision integer,p_outcome text,p_answered_at timestamptz
) returns jsonb language sql volatile security invoker set search_path = '' as $$
  select flashcards_private.recall_record_action(p_action_id,p_opportunity_id,p_card_id,p_revision,p_outcome,p_answered_at)
$$;

revoke all on function flashcards_private.recall_card_supported(uuid,uuid) from public,anon,authenticated,service_role;
revoke all on function flashcards_private.recall_due(integer),public.recall_due(integer),
  flashcards_private.recall_opportunities(integer),public.recall_opportunities(integer),
  flashcards_private.recall_record_action(uuid,uuid,uuid,integer,text,timestamptz),
  public.recall_record_action(uuid,uuid,uuid,integer,text,timestamptz) from public,anon,authenticated,service_role;
grant execute on function flashcards_private.recall_due(integer),public.recall_due(integer),
  flashcards_private.recall_opportunities(integer),public.recall_opportunities(integer),
  flashcards_private.recall_record_action(uuid,uuid,uuid,integer,text,timestamptz),
  public.recall_record_action(uuid,uuid,uuid,integer,text,timestamptz) to authenticated;
notify pgrst,'reload schema';
commit;
