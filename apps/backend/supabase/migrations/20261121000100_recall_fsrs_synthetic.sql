-- Follow the draft initial migration; this replaces its fixed demo scheduler.
-- Synthetic-only. Explicitly refuse converting demo review history.
begin;
do $$ begin
  if exists (select 1 from flashcards_private.reviews) then
    raise exception 'Existing demo history is not real FSRS state. Stop and review migration.';
  end if;
end $$;
drop function public.demo_flashcards_grade(uuid,uuid,integer,text,timestamptz);
revoke update (due_at, revision, last_review_at) on flashcards_private.cards from authenticated;
revoke insert, select on flashcards_private.reviews from authenticated;
drop policy own_cards_update on flashcards_private.cards;
drop policy own_reviews_append on flashcards_private.reviews;
drop policy own_reviews_read on flashcards_private.reviews;
alter table flashcards_private.cards add column scheduler_state jsonb;
revoke select on flashcards_private.cards from authenticated;
grant select (id, owner_id, active, due_at, front, back, revision)
  on flashcards_private.cards to authenticated;
alter table flashcards_private.reviews
  add column fsrs_log jsonb not null,
  add column after_state jsonb not null,
  add column scheduler_build text not null,
  add column scheduler_config jsonb not null;

-- Both functions use the migration role and are reachable ONLY by the Edge
-- backend's managed service identity. The browser cannot call these functions.
-- They independently verify the allowlist and the exact card owner.
create function public.recall_grade_context(
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
  if not c.active or c.revision<>p_revision then
    raise exception using errcode='PT409',message='This card changed. Refresh before grading.';
  end if;
  if p_reviewed_at > now()+interval '5 minutes'
     or (c.last_review_at is not null and p_reviewed_at<=c.last_review_at) then
    raise exception using errcode='22023',message='Invalid review time';
  end if;
  return jsonb_build_object('kind','card','state',c.scheduler_state,'due_at',c.due_at);
end $$;

create function public.recall_commit_review(
  p_owner uuid,p_review_id uuid,p_card_id uuid,p_revision integer,p_grade text,p_reviewed_at timestamptz,
  p_due_at timestamptz,p_state jsonb,p_log jsonb,p_scheduler_build text,p_scheduler_config jsonb
) returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare
  context jsonb;
begin
  perform 1 from flashcards_private.cards where owner_id=p_owner and id=p_card_id for update;
  context:=public.recall_grade_context(p_owner,p_review_id,p_card_id,p_revision,p_grade,p_reviewed_at);
  if context->>'kind'='replay' then return context; end if;
  if p_due_at is null or not isfinite(p_due_at) or p_due_at<=p_reviewed_at
     or jsonb_typeof(p_state) is distinct from 'object'
     or jsonb_typeof(p_log) is distinct from 'object'
     or jsonb_typeof(p_scheduler_config) is distinct from 'object'
     or p_scheduler_build is null or length(p_scheduler_build)=0 then
    raise exception using errcode='22023',message='Invalid trusted scheduler result';
  end if;

  insert into flashcards_private.reviews
    (owner_id,review_id,card_id,card_revision,grade,reviewed_at,next_due_at,fsrs_log,after_state,scheduler_build,scheduler_config)
    values(p_owner,p_review_id,p_card_id,p_revision,p_grade,p_reviewed_at,p_due_at,p_log,p_state,p_scheduler_build,p_scheduler_config);
  update flashcards_private.cards
    set revision=p_revision+1,due_at=p_due_at,last_review_at=p_reviewed_at,scheduler_state=p_state
    where owner_id=p_owner and id=p_card_id;
  return jsonb_build_object('kind','saved','review_id',p_review_id,'card_id',p_card_id,
    'revision',p_revision+1,'due_at',p_due_at);
end $$;

revoke all on function public.recall_grade_context(uuid,uuid,uuid,integer,text,timestamptz) from public,anon,authenticated,service_role;
revoke all on function public.recall_commit_review(uuid,uuid,uuid,integer,text,timestamptz,timestamptz,jsonb,jsonb,text,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.recall_grade_context(uuid,uuid,uuid,integer,text,timestamptz) to service_role;
grant execute on function public.recall_commit_review(uuid,uuid,uuid,integer,text,timestamptz,timestamptz,jsonb,jsonb,text,jsonb) to service_role;
notify pgrst,'reload schema';
commit;
