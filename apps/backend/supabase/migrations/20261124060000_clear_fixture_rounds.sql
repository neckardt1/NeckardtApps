-- The fixture reset and expiry routines already verify the disposable worker before calling this helper.
begin;

create or replace function flashcards_private.clear_worker_deck(worker uuid)
returns void language sql security invoker set search_path = '' as $$
  -- Serialize with starting and finishing a round for this worker.
  select 1 from flashcards_private.app_owner where owner_id = worker for update;
  select 1 from flashcards_private.practice_rounds where owner_id = worker for update;
  delete from flashcards_private.round_completions where owner_id = worker;
  delete from flashcards_private.round_items where owner_id = worker;
  delete from flashcards_private.practice_rounds where owner_id = worker;
  delete from flashcards_private.action_responses where owner_id = worker;
  delete from flashcards_private.action_opportunities where owner_id = worker;
  delete from flashcards_private.reviews where owner_id = worker;
  delete from flashcards_private.cards where owner_id = worker;
$$;

commit;
