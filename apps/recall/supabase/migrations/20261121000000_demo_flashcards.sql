-- DRAFT: synthetic-only review schema and RPCs. Do not run in the live
-- project as part of the offline UI demo. No account or card is created here.
begin;

create schema flashcards_private;
revoke all on schema flashcards_private from public, anon, authenticated;
grant usage on schema flashcards_private to authenticated;

-- Intentionally a single configured owner. An arbitrary authenticated
-- Supabase account is not enough to become an owner.
create table flashcards_private.app_owner (
    singleton boolean primary key default true check (singleton),
    owner_id uuid not null unique references auth.users(id) on delete restrict
);

create table flashcards_private.cards (
    id uuid primary key default gen_random_uuid(),
    owner_id uuid not null references flashcards_private.app_owner(owner_id),
    front text not null check (length(btrim(front)) > 0),
    back text not null check (length(btrim(back)) > 0),
    due_at timestamptz not null default now(),
    revision integer not null default 0 check (revision >= 0),
    last_review_at timestamptz,
    active boolean not null default true,
    unique (owner_id, id)
);
create index flashcards_due_idx on flashcards_private.cards (owner_id, due_at, id) where active;

create table flashcards_private.reviews (
    owner_id uuid not null,
    review_id uuid not null,
    card_id uuid not null,
    card_revision integer not null check (card_revision >= 0),
    grade text not null check (grade in ('miss','hard','medium','easy')),
    reviewed_at timestamptz not null,
    recorded_at timestamptz not null default now(),
    next_due_at timestamptz not null,
    primary key (owner_id, review_id),
    unique (owner_id, card_id, card_revision),
    foreign key (owner_id, card_id) references flashcards_private.cards (owner_id, id)
);

alter table flashcards_private.app_owner enable row level security;
alter table flashcards_private.cards enable row level security;
alter table flashcards_private.reviews enable row level security;

revoke all on all tables in schema flashcards_private from public, anon, authenticated;
grant select on flashcards_private.app_owner to authenticated;
grant select on flashcards_private.cards to authenticated;
grant update (due_at, revision, last_review_at) on flashcards_private.cards to authenticated;
grant select, insert on flashcards_private.reviews to authenticated;
-- No review UPDATE/DELETE/TRUNCATE grants. The private schema must not be
-- added to Data API Exposed Schemas or handed out as a SQL credential.

create policy own_allowlist on flashcards_private.app_owner
    for select to authenticated using (owner_id = (select auth.uid()));
create policy own_cards_read on flashcards_private.cards
    for select to authenticated using (owner_id = (select auth.uid()));
create policy own_cards_update on flashcards_private.cards
    for update to authenticated
    using (owner_id = (select auth.uid())) with check (owner_id = (select auth.uid()));
create policy own_reviews_read on flashcards_private.reviews
    for select to authenticated using (owner_id = (select auth.uid()));
create policy own_reviews_append on flashcards_private.reviews
    for insert to authenticated with check (owner_id = (select auth.uid()));

-- public remains an exposed Data API schema; only these explicitly granted
-- RPCs are needed. Base tables live in the non-exposed schema above.
create function public.demo_flashcards_due(p_limit integer default 5)
returns table (card_id uuid, front text, back text, revision integer, due_at timestamptz)
language plpgsql stable security invoker set search_path = ''
as $$
declare
    v_owner uuid := auth.uid();
begin
    if v_owner is null or not exists (
        select 1 from flashcards_private.app_owner o where o.owner_id = v_owner
    ) then
        raise exception using errcode = '42501', message = 'Configured flashcard owner required';
    end if;
    return query
        select c.id, c.front, c.back, c.revision, c.due_at
        from flashcards_private.cards c
        where c.owner_id = v_owner and c.active and c.due_at <= now()
        order by c.due_at, c.id
        limit least(5, greatest(1, coalesce(p_limit, 5)));
end
$$;

-- One call = one database transaction for history and schedule. The
-- intervals are demo placeholders and are not Py-FSRS.
create function public.demo_flashcards_grade(
    p_review_id uuid, p_card_id uuid, p_revision integer, p_grade text, p_reviewed_at timestamptz
)
returns table (review_id uuid, card_id uuid, revision integer, due_at timestamptz)
language plpgsql volatile security invoker set search_path = ''
as $$
declare
    v_owner uuid := auth.uid();
    v_card flashcards_private.cards%rowtype;
    v_review flashcards_private.reviews%rowtype;
    v_due timestamptz;
begin
    if v_owner is null or not exists (
        select 1 from flashcards_private.app_owner o where o.owner_id = v_owner
    ) then
        raise exception using errcode = '42501', message = 'Configured flashcard owner required';
    end if;
    if p_review_id is null or p_card_id is null or p_revision is null or p_revision < 0
        or p_grade is null or p_grade not in ('miss','hard','medium','easy')
        or p_reviewed_at is null or not isfinite(p_reviewed_at)
    then
        raise exception using errcode = '22023', message = 'Invalid demo review';
    end if;

    select c.* into v_card from flashcards_private.cards c
    where c.owner_id = v_owner and c.id = p_card_id
    for update;
    if not found then
        raise exception using errcode = 'P0002', message = 'Card not found';
    end if;

    -- Look up replay under the card lock, before checking the current
    -- revision. A successful previous attempt already bumped the revision.
    select r.* into v_review from flashcards_private.reviews r
    where r.owner_id = v_owner and r.review_id = p_review_id;
    if found then
        if (v_review.card_id, v_review.card_revision, v_review.grade, v_review.reviewed_at)
            is distinct from (p_card_id, p_revision, p_grade, p_reviewed_at) then
            raise exception using errcode = '22023', message = 'Review ID already belongs to a different answer';
        end if;
        return query select v_review.review_id, v_review.card_id, v_review.card_revision + 1, v_review.next_due_at;
        return;
    end if;

    if not v_card.active or v_card.revision <> p_revision then
        raise exception using errcode = 'PT409', message = 'This card changed. Refresh before grading.';
    end if;
    if p_reviewed_at > now() + interval '5 minutes'
        or (v_card.last_review_at is not null and p_reviewed_at <= v_card.last_review_at) then
        raise exception using errcode = '22023', message = 'Review time is invalid for this card';
    end if;

    v_due := p_reviewed_at + case p_grade
        when 'miss' then interval '10 minutes'
        when 'hard' then interval '1 day'
        when 'medium' then interval '3 days'
        when 'easy' then interval '7 days'
    end;

    insert into flashcards_private.reviews (owner_id, review_id, card_id, card_revision, grade, reviewed_at, next_due_at)
    values (v_owner, p_review_id, p_card_id, p_revision, p_grade, p_reviewed_at, v_due);

    update flashcards_private.cards c
    set due_at = v_due, revision = p_revision + 1, last_review_at = p_reviewed_at
    where c.owner_id = v_owner and c.id = p_card_id;

    return query select p_review_id, p_card_id, p_revision + 1, v_due;
end
$$;

revoke all on function public.demo_flashcards_due(integer) from public, anon, authenticated;
revoke all on function public.demo_flashcards_grade(uuid, uuid, integer, text, timestamptz) from public, anon, authenticated;
grant execute on function public.demo_flashcards_due(integer) to authenticated;
grant execute on function public.demo_flashcards_grade(uuid, uuid, integer, text, timestamptz) to authenticated;
notify pgrst, 'reload schema';
commit;
