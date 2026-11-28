begin;

create index completed_tasks_by_date on tasks_private.items (completed_at desc, id desc)
  where completed_at is not null;

create table tasks_private.activity (
  id uuid primary key default gen_random_uuid(),
  ordinal bigint generated always as identity,
  task_id uuid not null references tasks_private.items(id) on delete cascade,
  actor_id uuid references auth.users(id) on delete set null,
  happened_at timestamptz not null default clock_timestamp(),
  action text not null check (action in ('created','edited','rescheduled','completed','promoted','deprioritized')),
  item_version integer not null,
  before_value jsonb,
  after_plan jsonb,
  undo_of uuid unique references tasks_private.activity(id)
);
create index activity_by_task on tasks_private.activity (task_id, ordinal desc);
alter table tasks_private.activity enable row level security;
revoke all on tasks_private.activity, tasks_private.activity_ordinal_seq from public, anon, authenticated, service_role;

create function tasks_private.editable_fields(item tasks_private.items) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object('title', item.title,
    'plannedDate', item.planned_date, 'plannedTime', to_char(item.planned_time,'HH24:MI'),
    'deadlineDate', item.deadline_date, 'deadlineTime', to_char(item.deadline_time,'HH24:MI'),
    'showAfterDate', item.show_after_date, 'showAfterTime', to_char(item.show_after_time,'HH24:MI'))
$$;

-- Only actual inserts create events. A retry of tasks_create still returns the same task ID.
create function tasks_private.record_creation() returns trigger language plpgsql set search_path = '' as $$
begin
  insert into tasks_private.activity(task_id, actor_id, action, item_version)
    values (new.id, new.created_by, 'created', new.version);
  return new;
end $$;
create trigger record_creation after insert on tasks_private.items for each row execute function tasks_private.record_creation();

-- These original primitives still enforce the field, date, Focus and revision rules.
-- Every browser and MCP writer goes through the recording wrapper below.
alter function tasks_private.tasks_update(uuid,uuid,integer,jsonb) rename to update_item;
alter function tasks_private.tasks_complete(uuid,uuid,integer) rename to complete_item;
alter function tasks_private.tasks_focus(uuid,uuid,text) rename to choose_focus;

create function tasks_private.change_task(p_actor uuid, p_task uuid, p_version integer, p_action text, p_fields jsonb)
returns uuid language plpgsql set search_path = '' as $$
declare
  item tasks_private.items := tasks_private.lock_task(p_actor, p_task);
  prior jsonb;
  changed jsonb;
  plan jsonb;
  choice tasks_private.focus;
  receipt uuid;
begin
  if p_action in ('promoted','deprioritized') then
    -- Legacy Focus callers do not supply a shared item version.
    if p_version is not null and p_version <> item.version then
      raise exception using errcode = 'PT409', message = 'This task changed. Refresh Tasks.';
    end if;
    select to_jsonb(f) into prior from tasks_private.focus f where owner_id = p_actor and task_id = p_task;
    perform tasks_private.choose_focus(p_actor,p_task,p_action);
    select * into choice from tasks_private.focus where owner_id = p_actor and task_id = p_task;
    if choice.position is not distinct from (prior->>'position')::bigint then return null; end if;
  elsif p_action = 'completed' then
    perform tasks_private.complete_item(p_actor,p_task,p_version);
    item.version := item.version + 1;
  elsif p_action = 'edited' then
    prior := tasks_private.editable_fields(item);
    perform tasks_private.update_item(p_actor,p_task,p_version,p_fields);
    select tasks_private.editable_fields(i), i.version into changed, item.version from tasks_private.items i where i.id = p_task;
    if prior = changed then return null; end if;
    if (prior->'plannedDate',prior->'plannedTime') is distinct from (changed->'plannedDate',changed->'plannedTime') then
      plan := jsonb_build_object('plannedDate',changed->'plannedDate','plannedTime',changed->'plannedTime');
      if prior - 'plannedDate' - 'plannedTime' = changed - 'plannedDate' - 'plannedTime' then
        p_action := 'rescheduled';
        prior := jsonb_build_object('plannedDate',prior->'plannedDate','plannedTime',prior->'plannedTime');
      end if;
    end if;
  else
    raise exception using errcode = 'PT422', message = 'Unknown task action.';
  end if;
  insert into tasks_private.activity(task_id,actor_id,action,item_version,before_value,after_plan)
    values (p_task,p_actor,p_action,item.version,prior,plan) returning id into receipt;
  return receipt;
end $$;

create function tasks_private.tasks_update(p_actor uuid, p_task uuid, p_version integer, p_fields jsonb) returns void
language sql set search_path = '' as $$ select tasks_private.change_task(p_actor,p_task,p_version,'edited',p_fields) $$;
create function tasks_private.tasks_complete(p_actor uuid, p_task uuid, p_version integer) returns void
language sql set search_path = '' as $$ select tasks_private.change_task(p_actor,p_task,p_version,'completed',null) $$;
create function tasks_private.tasks_focus(p_actor uuid, p_task uuid, p_state text) returns void
language plpgsql set search_path = '' as $$
begin
  if p_state is null or p_state not in ('promoted','deprioritized') then
    raise exception using errcode = 'PT422', message = 'Invalid Focus choice.';
  end if;
  perform tasks_private.change_task(p_actor,p_task,null,p_state,null);
end $$;

create function public.tasks_change(p_actor uuid, p_task uuid, p_version integer, p_action text, p_fields jsonb default null)
returns uuid language plpgsql security definer set search_path = '' as $$
begin
  perform tasks_private.require_browser_actor(p_actor);
  if p_version is null then raise exception using errcode = 'PT422', message = 'A task version is required.'; end if;
  return tasks_private.change_task(p_actor,p_task,p_version,p_action,p_fields);
end $$;

create function public.tasks_undo(p_actor uuid, p_event uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  visible uuid[] := tasks_private.visible_lists(tasks_private.require_browser_actor(p_actor));
  entry tasks_private.activity;
  item tasks_private.items;
  prior tasks_private.focus;
begin
  select * into entry from tasks_private.activity where id = p_event and actor_id = p_actor and undo_of is null and action <> 'created';
  select * into item from tasks_private.items where id = entry.task_id and list_id = any(visible) for update;
  if not found then raise exception using errcode = '42501', message = 'Task action unavailable.'; end if;
  -- A lost response can safely retry even if the task has changed since the undo.
  if exists (select 1 from tasks_private.activity where undo_of = entry.id) then return; end if;
  if entry.happened_at < clock_timestamp() - interval '2 minutes' then
    raise exception using errcode = 'PT410', message = 'The undo window has closed.';
  end if;
  if item.version <> entry.item_version then
    raise exception using errcode = 'PT409', message = 'This task has changed since that action.';
  end if;
  if entry.action in ('promoted','deprioritized') then
    if exists (select 1 from tasks_private.activity where task_id = item.id and actor_id = p_actor
        and action in ('promoted','deprioritized') and ordinal > entry.ordinal) then
      raise exception using errcode = 'PT409', message = 'Your Focus has changed since that action.';
    end if;
    if entry.before_value is null then
      delete from tasks_private.focus where owner_id = p_actor and task_id = item.id;
    else
      prior := jsonb_populate_record(null::tasks_private.focus, entry.before_value);
      update tasks_private.focus set state = prior.state, chosen_day = prior.chosen_day, position = prior.position
        where owner_id = p_actor and task_id = item.id;
    end if;
  elsif entry.action = 'completed' then
    update tasks_private.items set completed_at = null, version = version + 1 where id = item.id;
  else
    perform tasks_private.update_item(p_actor,item.id,item.version,entry.before_value);
  end if;
  insert into tasks_private.activity(task_id,actor_id,action,item_version,undo_of,before_value,after_plan)
    select i.id,p_actor,entry.action,i.version,entry.id,entry.after_plan,
      case when entry.after_plan is not null then jsonb_build_object(
        'plannedDate',entry.before_value->'plannedDate','plannedTime',entry.before_value->'plannedTime') end
    from tasks_private.items i where i.id = item.id;
end $$;

create function public.tasks_history(p_actor uuid, p_task uuid, p_before uuid default null)
returns table(event_id uuid, happened_at timestamptz, action text, is_undo boolean, by_you boolean,
  from_date text, from_time text, to_date text, to_time text)
language plpgsql stable security definer set search_path = '' as $$
declare visible uuid[] := tasks_private.visible_lists(tasks_private.require_browser_actor(p_actor));
begin
  if not exists (select 1 from tasks_private.items where id = p_task and list_id = any(visible)) then
    raise exception using errcode = '42501', message = 'Task unavailable.';
  end if;
  return query
    with permitted as not materialized (select e.* from tasks_private.activity e where e.task_id = p_task
      and (e.action not in ('promoted','deprioritized') or e.actor_id = p_actor))
    select e.id,e.happened_at,e.action,e.undo_of is not null,coalesce(e.actor_id = p_actor,false),
      case when e.after_plan is not null then e.before_value->>'plannedDate' end,
      case when e.after_plan is not null then e.before_value->>'plannedTime' end,
      e.after_plan->>'plannedDate',e.after_plan->>'plannedTime' from permitted e
    where p_before is null or e.ordinal < (select cursor.ordinal from permitted cursor where cursor.id = p_before)
    order by e.ordinal desc limit 50;
end $$;

create function public.tasks_completed(p_actor uuid, p_before_at timestamptz default null, p_before_id uuid default null)
returns table(task_id uuid, list_id uuid, title text, completed_at timestamptz)
language plpgsql stable security definer set search_path = '' as $$
declare visible uuid[] := tasks_private.visible_lists(tasks_private.require_browser_actor(p_actor));
begin
  return query select i.id,i.list_id,i.title,i.completed_at from tasks_private.items i
  where i.list_id = any(visible) and i.completed_at is not null
    and (p_before_at is null or (i.completed_at,i.id) < (p_before_at,p_before_id))
  order by i.completed_at desc,i.id desc limit 50;
end $$;

revoke all on function tasks_private.editable_fields(tasks_private.items), tasks_private.record_creation(),
  tasks_private.change_task(uuid,uuid,integer,text,jsonb), tasks_private.tasks_update(uuid,uuid,integer,jsonb),
  tasks_private.tasks_complete(uuid,uuid,integer), tasks_private.tasks_focus(uuid,uuid,text)
  from public, anon, authenticated, service_role;
revoke all on function public.tasks_change(uuid,uuid,integer,text,jsonb), public.tasks_undo(uuid,uuid),
  public.tasks_history(uuid,uuid,uuid), public.tasks_completed(uuid,timestamptz,uuid) from public,anon,authenticated,service_role;
grant execute on function public.tasks_change(uuid,uuid,integer,text,jsonb), public.tasks_undo(uuid,uuid),
  public.tasks_history(uuid,uuid,uuid), public.tasks_completed(uuid,timestamptz,uuid) to authenticated;

commit;
