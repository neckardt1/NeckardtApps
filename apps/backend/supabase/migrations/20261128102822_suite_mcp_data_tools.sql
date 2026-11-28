begin;

-- Data tools are selected at registration, for one account. Existing grants start empty.
alter table neckardt_mcp.clients add column data_tools text[] not null default '{}'
  check (data_tools <@ array['get_cards','create_cards','list_tasks','create_task','update_task','complete_task','set_task_focus']
    and array_position(data_tools, null) is null and (cardinality(data_tools) = 0 or owner_id is not null));

create function neckardt_mcp.prevent_tool_expansion() returns trigger
language plpgsql set search_path = '' as $$
begin
  if not (new.data_tools <@ old.data_tools) or
     (cardinality(new.data_tools) > 0 and (new.owner_id, new.client_id) is distinct from (old.owner_id, old.client_id)) then
    raise exception 'Expanded data access requires a fresh client registration and consent.';
  end if;
  return new;
end $$;
create trigger prevent_tool_expansion before update on neckardt_mcp.clients
  for each row execute function neckardt_mcp.prevent_tool_expansion();

-- Keep the original consent and hook eligibility predicate, including registry RLS.
drop function public.neckardt_mcp_client(uuid,uuid,text);
create function public.neckardt_mcp_client(requested_client uuid, requested_user uuid, requested_scope text)
returns table(display_name text, callback_url text, subscriptions boolean, data_tools text[])
language sql stable security invoker set search_path = '' as $$
  select c.display_name, c.callback_url, c.subscriptions, c.data_tools from neckardt_mcp.clients c
  where c.client_id = requested_client and requested_user is not null
    and (c.owner_id is null or c.owner_id = requested_user)
    and (requested_scope = 'openid' or
      (string_to_array(requested_scope, ' ') @> c.scopes and string_to_array(requested_scope, ' ') <@ c.scopes
       and cardinality(string_to_array(requested_scope, ' ')) = cardinality(c.scopes)))
$$;
revoke all on function public.neckardt_mcp_client(uuid,uuid,text) from public, anon, authenticated, service_role;
grant execute on function public.neckardt_mcp_client(uuid,uuid,text) to authenticated, supabase_auth_admin;

-- Both entry paths use the same enrollment, list visibility, receipts, revision locks and Focus logic.
-- The private implementations take an already authenticated actor. Browser wrappers still pin auth.uid().
create function tasks_private.require_browser_actor(p_actor uuid) returns uuid
language plpgsql stable set search_path = '' as $$
declare claims jsonb := nullif(current_setting('request.jwt.claims', true), '')::jsonb;
begin
  if p_actor is null or auth.uid() is distinct from p_actor
     or claims->>'aud' is distinct from 'authenticated' or claims->>'role' is distinct from 'authenticated'
     or claims->'is_anonymous' is distinct from 'false'::jsonb or claims ? 'client_id'
     or claims->'amr' @> '[{"method":"oauth_provider/authorization_code"}]'::jsonb then
    raise exception using errcode = '42501', message = 'Sign in to Tasks with your account.';
  end if;
  return p_actor;
end $$;
create or replace function tasks_private.visible_lists(p_actor uuid) returns uuid[]
language sql stable set search_path = '' as $$
  select array(select l.id from tasks_private.lists l where (l.owner_id = p_actor or l.slot = 0)
    and exists (select 1 from tasks_private.lists membership where membership.owner_id = p_actor))
$$;

alter function public.tasks_read(uuid) set schema tasks_private;
revoke all on function tasks_private.tasks_read(uuid) from public, anon, authenticated, service_role;
create function public.tasks_read(p_actor uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select tasks_private.tasks_read(tasks_private.require_browser_actor(p_actor))
$$;
revoke all on function public.tasks_read(uuid) from public, anon, authenticated, service_role;
grant execute on function public.tasks_read(uuid) to authenticated;

alter function public.tasks_create(uuid,uuid,uuid,jsonb) set schema tasks_private;
revoke all on function tasks_private.tasks_create(uuid,uuid,uuid,jsonb) from public, anon, authenticated, service_role;
create function public.tasks_create(p_actor uuid, p_list uuid, p_request uuid, p_fields jsonb) returns uuid
language sql security definer set search_path = '' as $$
  select tasks_private.tasks_create(tasks_private.require_browser_actor(p_actor), p_list, p_request, p_fields)
$$;
revoke all on function public.tasks_create(uuid,uuid,uuid,jsonb) from public, anon, authenticated, service_role;
grant execute on function public.tasks_create(uuid,uuid,uuid,jsonb) to authenticated;

alter function public.tasks_update(uuid,uuid,integer,jsonb) set schema tasks_private;
revoke all on function tasks_private.tasks_update(uuid,uuid,integer,jsonb) from public, anon, authenticated, service_role;
create function public.tasks_update(p_actor uuid, p_task uuid, p_version integer, p_fields jsonb) returns void
language sql security definer set search_path = '' as $$
  select tasks_private.tasks_update(tasks_private.require_browser_actor(p_actor), p_task, p_version, p_fields)
$$;
revoke all on function public.tasks_update(uuid,uuid,integer,jsonb) from public, anon, authenticated, service_role;
grant execute on function public.tasks_update(uuid,uuid,integer,jsonb) to authenticated;

alter function public.tasks_complete(uuid,uuid,integer) set schema tasks_private;
revoke all on function tasks_private.tasks_complete(uuid,uuid,integer) from public, anon, authenticated, service_role;
create function public.tasks_complete(p_actor uuid, p_task uuid, p_version integer) returns void
language sql security definer set search_path = '' as $$
  select tasks_private.tasks_complete(tasks_private.require_browser_actor(p_actor), p_task, p_version)
$$;
revoke all on function public.tasks_complete(uuid,uuid,integer) from public, anon, authenticated, service_role;
grant execute on function public.tasks_complete(uuid,uuid,integer) to authenticated;

alter function public.tasks_focus(uuid,uuid,text) set schema tasks_private;
revoke all on function tasks_private.tasks_focus(uuid,uuid,text) from public, anon, authenticated, service_role;
create function public.tasks_focus(p_actor uuid, p_task uuid, p_state text) returns void
language sql security definer set search_path = '' as $$
  select tasks_private.tasks_focus(tasks_private.require_browser_actor(p_actor), p_task, p_state)
$$;
revoke all on function public.tasks_focus(uuid,uuid,text) from public, anon, authenticated, service_role;
grant execute on function public.tasks_focus(uuid,uuid,text) to authenticated;

create function neckardt_mcp.read_cards(p_owner uuid, ids uuid[], after_id uuid, page_size integer)
returns jsonb language sql stable set search_path = '' as $$
  select coalesce(jsonb_agg(to_jsonb(page) order by page.id), '[]'::jsonb) from (
    select c.id, c.front, c.back, c.kind, c.cue_card_id, c.active, c.due_at
    from flashcards_private.cards c where c.owner_id = p_owner and (ids is null or c.id = any(ids))
      and (after_id is null or c.id > after_id)
    order by c.id limit least(101, greatest(1, page_size))
  ) page
$$;

-- The Edge schema accepts facts and complete cue/action pairs and supplies only normalized rows.
-- Verify the entire batch after the insert, so conflicts roll back new rows and retries preserve schedules.
create function neckardt_mcp.create_cards(p_owner uuid, cards jsonb) returns jsonb
language plpgsql set search_path = '' as $$
declare
  card_ids uuid[];
  saved jsonb;
begin
  insert into flashcards_private.cards (owner_id, id, front, back, kind, cue_card_id)
    select p_owner, id, front, back, kind, cue_card_id from jsonb_to_recordset(cards)
      as r(id uuid, front text, back text, kind text, cue_card_id uuid)
    order by id on conflict (id) do nothing;
  if exists (select 1 from jsonb_to_recordset(cards) as r(id uuid, front text, back text, kind text, cue_card_id uuid)
      left join flashcards_private.cards c on c.owner_id = p_owner and c.id = r.id
      where c.id is null or (c.front, c.back, c.kind, c.cue_card_id)
        is distinct from (r.front, r.back, r.kind, r.cue_card_id)) then
    raise exception using errcode = 'PT409', message = 'Card IDs conflict with the approved batch.';
  end if;
  select array_agg((r->>'id')::uuid) into card_ids from jsonb_array_elements(cards) r;
  saved := neckardt_mcp.read_cards(p_owner, card_ids, null, 100);
  if coalesce(cardinality(card_ids), 0) = 0 or jsonb_array_length(saved) <> cardinality(card_ids) then
    raise exception using errcode = 'PT422', message = 'Expected unique IDs for the entire batch.';
  end if;
  return jsonb_build_object('cards', saved);
end $$;

-- Only the Edge service can relay a verified JWT subject/client pair. Resolve the live grant again on
-- every invocation, independently of discovery. No MCP bearer can use this RPC or the Tasks browser API.
create function public.neckardt_mcp_data(p_client uuid, p_actor uuid, operation text, args jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  allowed text[];
  cards jsonb;
  page_size integer;
begin
  select c.data_tools into allowed from neckardt_mcp.clients c where c.client_id = p_client and c.owner_id = p_actor;
  if operation = 'tools/list' then return to_jsonb(coalesce(allowed, '{}'::text[])); end if;
  if allowed is null or operation is null or not (operation = any(allowed)) then
    raise exception using errcode = '42501', message = 'Tool unavailable.';
  end if;
  if operation in ('get_cards', 'create_cards') and not exists (
      select 1 from flashcards_private.app_owner where owner_id = p_actor) then
    raise exception using errcode = '42501', message = 'Tool unavailable.';
  end if;
  case operation
    when 'get_cards' then
      page_size := case when args ? 'ids' then 100 else least(100, greatest(1, coalesce((args->>'limit')::integer, 50))) end;
      cards := neckardt_mcp.read_cards(p_actor, case when args ? 'ids' then
        array(select jsonb_array_elements_text(args->'ids')::uuid) end, (args->>'after')::uuid, page_size + 1);
      if jsonb_array_length(cards) > page_size then
        cards := cards - page_size;
        return jsonb_build_object('cards', cards, 'next_after', cards->-1->>'id');
      end if;
      return jsonb_build_object('cards', cards, 'next_after', null);
    when 'create_cards' then return neckardt_mcp.create_cards(p_actor, args->'cards');
    when 'list_tasks' then return tasks_private.tasks_read(p_actor);
    when 'create_task' then return jsonb_build_object('id', tasks_private.tasks_create(
      p_actor, (args->>'list_id')::uuid, (args->>'request_id')::uuid, args->'fields'));
    when 'update_task' then perform tasks_private.tasks_update(p_actor, (args->>'task_id')::uuid,
      (args->>'version')::integer, args->'fields');
    when 'complete_task' then perform tasks_private.tasks_complete(p_actor, (args->>'task_id')::uuid,
      (args->>'version')::integer);
    when 'set_task_focus' then perform tasks_private.tasks_focus(p_actor, (args->>'task_id')::uuid, args->>'state');
    else raise exception using errcode = '42501', message = 'Tool unavailable.';
  end case;
  return jsonb_build_object('id', args->>'task_id');
end $$;
revoke all on function neckardt_mcp.read_cards(uuid,uuid[],uuid,integer), neckardt_mcp.create_cards(uuid,jsonb),
  neckardt_mcp.prevent_tool_expansion(), tasks_private.require_browser_actor(uuid),
  public.neckardt_mcp_data(uuid,uuid,text,jsonb) from public, anon, authenticated, service_role;
grant execute on function public.neckardt_mcp_data(uuid,uuid,text,jsonb) to service_role;
notify pgrst, 'reload schema';
commit;
