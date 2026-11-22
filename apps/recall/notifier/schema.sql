-- Local experiment, NOT a deployment migration. Apply only after the two
-- Recall migrations in an isolated test database. No public RPC is exposed.
create table flashcards_private.completion_events (
  event_id uuid primary key,
  owner_id uuid not null references flashcards_private.app_owner(owner_id),
  session_id uuid not null,
  review_ids uuid[] not null check (cardinality(review_ids) between 1 and 5),
  state text not null default 'waiting' check (state in ('waiting','leased','accepted','dead')),
  created_at timestamptz not null,
  ready_observed_at timestamptz,
  last_review_recorded_at timestamptz,
  next_attempt_at timestamptz not null,
  attempts integer not null default 0,
  lease_token uuid,
  lease_until timestamptz,
  relay_accepted_at timestamptz,
  last_error text,
  unique(owner_id, session_id)
);
-- One saved review cannot produce debriefs under several session IDs.
create table flashcards_private.completion_reviews (
  owner_id uuid not null,
  review_id uuid not null,
  event_id uuid not null references flashcards_private.completion_events(event_id),
  primary key (owner_id, review_id)
);
create index completion_due_idx on flashcards_private.completion_events(next_attempt_at, created_at)
  where state in ('waiting','leased');
alter table flashcards_private.completion_events enable row level security;
alter table flashcards_private.completion_reviews enable row level security;
revoke all on flashcards_private.completion_events, flashcards_private.completion_reviews
  from public, anon, authenticated, service_role;
