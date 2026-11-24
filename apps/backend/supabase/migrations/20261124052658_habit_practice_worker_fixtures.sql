-- Disposable test users share the hosted database with ordinary enrolled owners.
begin;

create function flashcards_private.is_habit_fixture(subject uuid, email text, app_metadata jsonb)
returns boolean language sql immutable strict set search_path = '' as $$
  select app_metadata->>'neckardt_fixture' = 'habit-practice-v1'
    and email = 'worker-' || subject::text || '@example.test'
$$;

create function flashcards_private.clear_worker_deck(worker uuid)
returns void language sql security invoker set search_path = '' as $$
  delete from flashcards_private.action_responses where owner_id = worker;
  delete from flashcards_private.action_opportunities where owner_id = worker;
  delete from flashcards_private.reviews where owner_id = worker;
  delete from flashcards_private.cards where owner_id = worker;
$$;

create function flashcards_private.recall_reset_fixture()
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  worker uuid := auth.uid();
  card uuid;
begin
  perform 1 from auth.users u
    where u.id = worker and flashcards_private.is_habit_fixture(u.id, u.email, u.raw_app_meta_data)
    for update;
  if not found then
    raise exception using errcode = '42501', message = 'Habit Practice fixture account required';
  end if;
  insert into flashcards_private.app_owner (owner_id) values (worker) on conflict (owner_id) do nothing;
  perform flashcards_private.clear_worker_deck(worker);
  insert into flashcards_private.cards (owner_id, front, back)
    values (worker, 'Worker card ' || worker, 'Fixture answer') returning id into card;
  return card;
end $$;
create function public.recall_reset_fixture()
returns uuid language sql security invoker set search_path = '' as $$
  select flashcards_private.recall_reset_fixture()
$$;

-- Called by the database owner's scheduled job. Lock the same Auth row as reset.
create function flashcards_private.expire_habit_fixtures()
returns void language plpgsql security invoker set search_path = '' as $$
declare
  worker uuid;
begin
  for worker in select u.id from auth.users u
    where u.created_at < now() - interval '48 hours'
      and flashcards_private.is_habit_fixture(u.id, u.email, u.raw_app_meta_data)
    order by u.id for update skip locked
  loop
    perform flashcards_private.clear_worker_deck(worker);
    delete from flashcards_private.app_owner where owner_id = worker;
    delete from auth.users where id = worker;
  end loop;
end $$;

revoke all on function flashcards_private.is_habit_fixture(uuid, text, jsonb),
  flashcards_private.clear_worker_deck(uuid), flashcards_private.expire_habit_fixtures(),
  flashcards_private.recall_reset_fixture(), public.recall_reset_fixture()
  from public, anon, authenticated, service_role;
grant execute on function flashcards_private.recall_reset_fixture(), public.recall_reset_fixture()
  to authenticated;

notify pgrst, 'reload schema';
commit;
