begin;

create schema tasks_private;
revoke all on schema tasks_private from public, anon, authenticated, service_role;

-- An operator provisions slot 0 for Household and slots 1 and 2 for the two
-- accounts. Owning a private list is the only enrollment. Start with no rows.
create table tasks_private.lists (
  id uuid primary key default gen_random_uuid(),
  slot smallint unique not null check (slot between 0 and 2),
  owner_id uuid unique references auth.users(id) on delete cascade,
  check ((slot = 0) = (owner_id is null))
);

create table tasks_private.items (
  id uuid primary key default gen_random_uuid(),
  list_id uuid not null references tasks_private.lists(id) on delete cascade,
  created_by uuid references auth.users(id) on delete set null,
  request_id uuid not null,
  unique (created_by, request_id),
  title text not null check (title ~ '[^[:space:]]'),
  planned_date date,
  planned_time time,
  deadline_date date,
  deadline_time time,
  show_after_date date,
  show_after_time time,
  check (planned_time is null or planned_date is not null),
  check (deadline_time is null or deadline_date is not null),
  check (show_after_time is null or show_after_date is not null),
  show_after_at timestamptz generated always as
    ((show_after_date + coalesce(show_after_time, time '00:00')) at time zone 'America/Los_Angeles') stored,
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  version integer not null default 1
);
create index active_tasks_by_list on tasks_private.items (list_id, created_at, id) where completed_at is null;

create sequence tasks_private.focus_order;
create table tasks_private.focus (
  owner_id uuid not null references auth.users(id) on delete cascade,
  task_id uuid not null references tasks_private.items(id) on delete cascade,
  state text not null check (state in ('promoted', 'deprioritized')),
  chosen_day date not null,
  position bigint not null default nextval('tasks_private.focus_order'),
  primary key (owner_id, task_id)
);

alter table tasks_private.lists enable row level security;
alter table tasks_private.items enable row level security;
alter table tasks_private.focus enable row level security;
revoke all on all tables in schema tasks_private from public, anon, authenticated, service_role;
revoke all on all sequences in schema tasks_private from public, anon, authenticated, service_role;

-- Used by every public RPC before reading or writing data. p_actor pins a
-- pending browser operation to the account that initiated it.
create function tasks_private.visible_lists(p_actor uuid) returns uuid[]
language plpgsql stable set search_path = '' as $$
declare
  claims jsonb := nullif(current_setting('request.jwt.claims', true), '')::jsonb;
begin
  if p_actor is null or auth.uid() is distinct from p_actor
     or claims->>'aud' is distinct from 'authenticated' or claims->>'role' is distinct from 'authenticated'
     or claims->'is_anonymous' is distinct from 'false'::jsonb or claims ? 'client_id'
     or claims->'amr' @> '[{"method":"oauth_provider/authorization_code"}]'::jsonb then
    raise exception using errcode = '42501', message = 'Sign in to Tasks with your account.';
  end if;
  return array(select l.id from tasks_private.lists l
    where (l.owner_id = p_actor or l.slot = 0)
      and exists (select 1 from tasks_private.lists membership where membership.owner_id = p_actor));
end $$;

create function public.tasks_read(p_actor uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  visible uuid[] := tasks_private.visible_lists(p_actor);
  today date := (statement_timestamp() at time zone 'America/Los_Angeles')::date;
begin
  return (
    with active as (select * from tasks_private.items where list_id = any(visible) and completed_at is null)
    select jsonb_build_object(
      'lists', coalesce((select jsonb_agg(jsonb_build_object('id', id,
          'kind', case when slot = 0 then 'household' else 'private' end) order by slot = 0)
        from tasks_private.lists where id = any(visible)), '[]'::jsonb),
      'tasks', coalesce((select jsonb_agg(jsonb_build_object(
          'id', id, 'listId', list_id, 'title', title, 'version', version,
          'plannedDate', planned_date, 'plannedTime', to_char(planned_time, 'HH24:MI'),
          'deadlineDate', deadline_date, 'deadlineTime', to_char(deadline_time, 'HH24:MI'),
          'showAfterDate', show_after_date, 'showAfterTime', to_char(show_after_time, 'HH24:MI'),
          'showAfterAt', show_after_at) order by created_at, id)
        from active), '[]'::jsonb),
      'focusDay', today,
      'focus', coalesce((select jsonb_agg(jsonb_build_object('taskId', f.task_id, 'state', f.state) order by f.position desc)
        from tasks_private.focus f join active on active.id = f.task_id where f.owner_id = p_actor
          and (f.state = 'promoted' or f.chosen_day = today)), '[]'::jsonb))
  );
end $$;

-- The adapter sends all seven fields when creating/editing and only the plan
-- pair when rescheduling. Reject relative dates, device offsets and hidden keys.
create function tasks_private.check_fields(fields jsonb, allow_reschedule boolean) returns void
language plpgsql immutable set search_path = '' as $$
declare
  full_keys text[] := array['title','plannedDate','plannedTime','deadlineDate','deadlineTime','showAfterDate','showAfterTime'];
  plan_keys text[] := array['plannedDate','plannedTime'];
begin
  if jsonb_typeof(fields) is distinct from 'object' or not (
      (fields ?& full_keys and fields - full_keys = '{}'::jsonb)
      or (allow_reschedule and fields ?& plan_keys and fields - plan_keys = '{}'::jsonb)) then
    raise exception using errcode = 'PT422', message = 'Invalid task fields.';
  end if;
  if fields ? 'title' and coalesce(fields->>'title', '') !~ '[^[:space:]]' then
    raise exception using errcode = 'PT422', message = 'Enter a task title.';
  end if;
  if (fields->>'plannedTime' is not null and fields->>'plannedDate' is null)
     or (fields->>'deadlineTime' is not null and fields->>'deadlineDate' is null)
     or (fields->>'showAfterTime' is not null and fields->>'showAfterDate' is null) then
    raise exception using errcode = 'PT422', message = 'A time needs a date.';
  end if;
  if exists (select 1 from jsonb_each(fields) where value <> 'null'::jsonb and (
      jsonb_typeof(value) <> 'string'
      or (key like '%Date' and fields->>key !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$')
      or (key like '%Time' and fields->>key !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'))) then
    raise exception using errcode = 'PT422', message = 'Use a calendar date and an optional time to the minute.';
  end if;
end $$;

create function public.tasks_create(p_actor uuid, p_list uuid, p_request uuid, p_fields jsonb) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  visible uuid[] := tasks_private.visible_lists(p_actor);
  task_id uuid;
begin
  if p_list is null or not (p_list = any(visible)) then
    raise exception using errcode = '42501', message = 'List unavailable.';
  end if;
  if p_request is null then
    raise exception using errcode = 'PT422', message = 'A create request ID is required.';
  end if;
  perform tasks_private.check_fields(p_fields, false);
  insert into tasks_private.items (list_id, created_by, request_id, title, planned_date, planned_time,
      deadline_date, deadline_time, show_after_date, show_after_time)
    values (p_list, p_actor, p_request, btrim(p_fields->>'title'), (p_fields->>'plannedDate')::date,
      (p_fields->>'plannedTime')::time, (p_fields->>'deadlineDate')::date, (p_fields->>'deadlineTime')::time,
      (p_fields->>'showAfterDate')::date, (p_fields->>'showAfterTime')::time)
    on conflict (created_by, request_id) do nothing returning id into task_id;
  if task_id is null then
    -- A separate statement sees a concurrent winner after the unique-index wait.
    -- Receipts remain on completed rows and replay never writes their fields.
    select id into task_id from tasks_private.items
      where created_by = p_actor and request_id = p_request and list_id = p_list;
    if not found then
      raise exception using errcode = 'PT409', message = 'The create request was used for a different list.';
    end if;
  end if;
  return task_id;
end $$;

-- Lock before comparing revisions or evaluating a visibility gate, so a
-- concurrent edit/finish is observed after waiting. All misses look identical.
create function tasks_private.lock_task(p_actor uuid, p_task uuid) returns tasks_private.items
language plpgsql set search_path = '' as $$
declare
  visible uuid[] := tasks_private.visible_lists(p_actor);
  item tasks_private.items;
begin
  select * into item from tasks_private.items where id = p_task and list_id = any(visible) for update;
  if not found then
    raise exception using errcode = '42501', message = 'Task unavailable.';
  end if;
  if item.completed_at is not null then
    raise exception using errcode = 'PT409', message = 'This task was completed. Refresh Tasks.';
  end if;
  return item;
end $$;

create function public.tasks_update(p_actor uuid, p_task uuid, p_version integer, p_fields jsonb) returns void
language plpgsql security definer set search_path = '' as $$
declare
  item tasks_private.items := tasks_private.lock_task(p_actor, p_task);
begin
  if p_version is distinct from item.version then
    raise exception using errcode = 'PT409', message = 'This task changed. Refresh Tasks.';
  end if;
  perform tasks_private.check_fields(p_fields, true);
  if p_fields ? 'title' then
    update tasks_private.items set title = btrim(p_fields->>'title'),
      planned_date = (p_fields->>'plannedDate')::date, planned_time = (p_fields->>'plannedTime')::time,
      deadline_date = (p_fields->>'deadlineDate')::date, deadline_time = (p_fields->>'deadlineTime')::time,
      show_after_date = (p_fields->>'showAfterDate')::date, show_after_time = (p_fields->>'showAfterTime')::time,
      version = version + 1 where id = p_task;
  else
    update tasks_private.items set planned_date = (p_fields->>'plannedDate')::date,
      planned_time = (p_fields->>'plannedTime')::time, version = version + 1 where id = p_task;
  end if;
end $$;

create function public.tasks_complete(p_actor uuid, p_task uuid, p_version integer) returns void
language plpgsql security definer set search_path = '' as $$
declare
  item tasks_private.items := tasks_private.lock_task(p_actor, p_task);
begin
  if p_version is distinct from item.version then
    raise exception using errcode = 'PT409', message = 'This task changed. Refresh Tasks.';
  end if;
  update tasks_private.items set completed_at = now(), version = version + 1 where id = p_task;
end $$;

create function public.tasks_focus(p_actor uuid, p_task uuid, p_state text) returns void
language plpgsql security definer set search_path = '' as $$
declare
  item tasks_private.items := tasks_private.lock_task(p_actor, p_task);
  today date := (statement_timestamp() at time zone 'America/Los_Angeles')::date;
begin
  if p_state is null or p_state not in ('promoted', 'deprioritized') then
    raise exception using errcode = 'PT422', message = 'Invalid Focus choice.';
  end if;
  if p_state = 'promoted' and item.show_after_at > statement_timestamp() then
    raise exception using errcode = 'PT422', message = 'This task has a future Show after.';
  end if;
  -- Only a personal promotion brought a future plan into Today. A repeated
  -- drop preserves today's suppression and cannot renew yesterday's.
  if p_state = 'deprioritized' and item.planned_date > today and not exists (
      select 1 from tasks_private.focus
      where owner_id = p_actor and task_id = p_task and state = 'promoted') then
    return;
  end if;
  insert into tasks_private.focus (owner_id, task_id, state, chosen_day) values (p_actor, p_task, p_state, today)
    on conflict (owner_id, task_id) do update
      set state = excluded.state, chosen_day = excluded.chosen_day, position = excluded.position;
end $$;

revoke all on all functions in schema tasks_private from public, anon, authenticated, service_role;
revoke all on function public.tasks_read(uuid), public.tasks_create(uuid,uuid,uuid,jsonb),
  public.tasks_update(uuid,uuid,integer,jsonb), public.tasks_complete(uuid,uuid,integer), public.tasks_focus(uuid,uuid,text)
  from public, anon, authenticated, service_role;
grant execute on function public.tasks_read(uuid), public.tasks_create(uuid,uuid,uuid,jsonb),
  public.tasks_update(uuid,uuid,integer,jsonb), public.tasks_complete(uuid,uuid,integer), public.tasks_focus(uuid,uuid,text)
  to authenticated;

commit;
