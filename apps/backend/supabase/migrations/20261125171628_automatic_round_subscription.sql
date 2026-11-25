begin;

-- Existing subscriptions only receive rounds explicitly armed by the owner.
alter table habit_notify.listeners add column automatic boolean not null default false,
  add column automatic_share_items boolean not null default false;

create function public.habit_notify_subscribe_automatic(payload jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  perform public.habit_notify_rpc('subscribe', payload);
  update habit_notify.listeners set automatic = true,
    automatic_share_items = coalesce((payload->>'share_items')::boolean, false)
    where owner_id = (payload->>'owner_id')::uuid and id = payload->>'id';
  return 'true'::jsonb;
end $$;
revoke all on function public.habit_notify_subscribe_automatic(jsonb) from public, anon, authenticated, service_role;
grant execute on function public.habit_notify_subscribe_automatic(jsonb) to service_role;

-- Bind at round creation. Unsubscribe, expiry or replacement cannot redirect a round.
create function habit_notify.arm_automatic_round() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  details boolean;
begin
  if new.owner_id = auth.uid() then
    select automatic_share_items into details from habit_notify.listeners
      where owner_id = new.owner_id and automatic and expires_at > clock_timestamp() for share;
    if found then
      -- Reuse the first-party session checks and the registration-bound delivery path.
      perform public.habit_notify_arm(new.round_id, details);
    end if;
  end if;
  return new;
exception when others then
  raise warning 'Could not prepare Habit Practice notification (SQLSTATE %)', sqlstate;
  return new;
end $$;
revoke all on function habit_notify.arm_automatic_round() from public, anon, authenticated, service_role;
create trigger habit_notify_automatic_round after insert on flashcards_private.practice_rounds
  for each row execute function habit_notify.arm_automatic_round();

notify pgrst, 'reload schema';
commit;
