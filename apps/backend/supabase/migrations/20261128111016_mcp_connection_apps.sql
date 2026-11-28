begin;

-- Operators offer an app scope to an account on a registered integration.
-- The browser records consent separately, against the specific native grant and session.
create table neckardt_mcp.account_apps (
  owner_id uuid not null references auth.users(id) on delete cascade,
  client_id uuid not null references neckardt_mcp.clients(client_id) on delete cascade,
  app text not null check (app in ('habit_cards','tasks')),
  primary key (owner_id, client_id, app)
);
create table neckardt_mcp.session_apps (
  owner_id uuid not null, client_id uuid not null, app text not null,
  session_id uuid not null, consent_id uuid not null, granted_at timestamptz not null,
  callback_url text not null, receipt uuid not null,
  primary key (owner_id, client_id, app, session_id),
  foreign key (owner_id, client_id, app) references neckardt_mcp.account_apps on delete cascade
);
alter table neckardt_mcp.account_apps enable row level security;
alter table neckardt_mcp.session_apps enable row level security;
revoke all on neckardt_mcp.account_apps, neckardt_mcp.session_apps from public, anon, authenticated, service_role;

create function neckardt_mcp.app_sessions(actor uuid, integration uuid default null)
returns table(client_id uuid, callback_url text, session_id uuid, connected_at timestamptz,
  consent_id uuid, granted_at timestamptz, app text, receipt uuid)
language plpgsql stable set search_path = '' as $$
begin
  return query select c.client_id, c.callback_url, s.id, s.created_at, g.id, g.granted_at, o.app, accepted.receipt
    from neckardt_mcp.account_apps o
    join neckardt_mcp.clients c on c.client_id=o.client_id and (c.owner_id is null or c.owner_id=o.owner_id)
    join auth.oauth_clients ac on ac.id=c.client_id and ac.redirect_uris=c.callback_url and ac.deleted_at is null
      and ac.registration_type='manual' and ac.client_type='public' and ac.token_endpoint_auth_method='none'
    join auth.oauth_consents g on g.user_id=o.owner_id and g.client_id=c.client_id and g.revoked_at is null
    join auth.sessions s on s.user_id=o.owner_id and s.oauth_client_id=c.client_id
      and (s.not_after is null or s.not_after > now())
    left join neckardt_mcp.session_apps accepted on accepted.owner_id=o.owner_id and accepted.client_id=c.client_id
      and accepted.app=o.app and accepted.session_id=s.id and accepted.consent_id=g.id
      and accepted.granted_at=g.granted_at and accepted.callback_url=c.callback_url
    where o.owner_id=actor and (integration is null or integration=c.client_id);
end $$;

create function neckardt_mcp.browser_owner() returns uuid language plpgsql stable set search_path = '' as $$
declare claims jsonb := nullif(current_setting('request.jwt.claims', true),'')::jsonb;
begin
  if auth.uid() is null or claims->>'aud' is distinct from 'authenticated' or claims->>'role' is distinct from 'authenticated'
     or claims->'is_anonymous' is distinct from 'false'::jsonb or claims ? 'client_id'
     or claims->'amr' @> '[{"method":"oauth_provider/authorization_code"}]'::jsonb
     or not exists (select 1 from auth.sessions browser where browser.id=(claims->>'session_id')::uuid
       and browser.user_id=auth.uid() and browser.oauth_client_id is null
       and (browser.not_after is null or browser.not_after > now())) then
    raise exception using errcode='42501',message='Sign in to manage connections.';
  end if;
  return auth.uid();
end $$;

create function public.neckardt_mcp_connection_options()
returns table(client_id uuid, callback_url text, session_id uuid, connected_at timestamptz,
  consent_id uuid, granted_at timestamptz, apps text[], approved boolean)
language sql stable security definer set search_path = '' as $$
  select client_id, callback_url, session_id, connected_at, consent_id, granted_at,
    array_agg(app order by app), bool_and(receipt is not null)
  from neckardt_mcp.app_sessions(neckardt_mcp.browser_owner())
  group by client_id, callback_url, session_id, connected_at, consent_id, granted_at
  order by client_id, connected_at, session_id
$$;

-- Match exactly what was shown, including the recipient and provider grant generation.
create function public.neckardt_mcp_allow_apps(p_client uuid,p_session uuid,p_consent uuid,
  p_granted_at timestamptz,p_callback text,p_apps text[]) returns void
language plpgsql security definer set search_path = '' as $$
declare actor uuid := neckardt_mcp.browser_owner(); matched integer;
begin
  with shown as (
    select s.* from neckardt_mcp.app_sessions(actor,p_client) s
    where s.session_id=p_session and s.consent_id=p_consent and s.granted_at=p_granted_at and s.callback_url=p_callback
  ), consented as (
    insert into neckardt_mcp.session_apps(owner_id,client_id,app,session_id,consent_id,granted_at,callback_url,receipt)
      select actor,p_client,app,p_session,p_consent,p_granted_at,p_callback,
        coalesce(receipt,gen_random_uuid())
      from shown where p_apps=(select array_agg(app order by app) from shown)
      on conflict (owner_id,client_id,app,session_id) do update set
        consent_id=excluded.consent_id, granted_at=excluded.granted_at, callback_url=excluded.callback_url,
        receipt=excluded.receipt
      returning 1
  ) select count(*) into matched from consented;
  if matched=0 then raise exception using errcode='PT409',message='Connection changed. Reload before allowing access.'; end if;
end $$;

revoke all on function neckardt_mcp.app_sessions(uuid,uuid), neckardt_mcp.browser_owner(),
  public.neckardt_mcp_connection_options(), public.neckardt_mcp_allow_apps(uuid,uuid,uuid,timestamptz,text,text[])
  from public, anon, authenticated, service_role;
grant execute on function public.neckardt_mcp_connection_options(),
  public.neckardt_mcp_allow_apps(uuid,uuid,uuid,timestamptz,text,text[]) to authenticated;

-- Only Auth may mint signed receipt claims. Keep the existing client, canary and first-party
-- issuance policies intact, and add receipts only after the suite grant has passed those checks.
alter function public.recall_canary_access_token_hook(jsonb) set schema neckardt_mcp;
create function neckardt_mcp.token_receipts(actor uuid,integration uuid,session uuid) returns uuid[]
language sql stable security definer set search_path = '' as $$
  select array_agg(s.receipt order by s.app) from neckardt_mcp.app_sessions(actor,integration) s
  where s.session_id=session and s.receipt is not null
$$;
create function public.recall_canary_access_token_hook(event jsonb) returns jsonb
language plpgsql stable security invoker set search_path = '' as $$
declare
  result jsonb := neckardt_mcp.recall_canary_access_token_hook(event);
  claims jsonb := result->'claims';
  receipts uuid[];
begin
  if claims->>'role'='neckardt_apps_oauth' and claims->'neckardt_mcp' is not null then
    receipts := neckardt_mcp.token_receipts((claims->>'sub')::uuid,(claims->>'client_id')::uuid,(claims->>'session_id')::uuid);
    if cardinality(receipts)>0 then
      result := jsonb_set(result,'{claims,neckardt_mcp,app_receipts}',to_jsonb(receipts));
    end if;
  end if;
  return result;
end $$;
revoke all on function neckardt_mcp.token_receipts(uuid,uuid,uuid),public.recall_canary_access_token_hook(jsonb)
  from public,anon,authenticated,service_role;
grant execute on function neckardt_mcp.token_receipts(uuid,uuid,uuid),public.recall_canary_access_token_hook(jsonb)
  to supabase_auth_admin;

drop function public.neckardt_mcp_data(uuid,uuid,text,jsonb);
create function public.neckardt_mcp_data(p_client uuid, p_actor uuid, operation text, args jsonb,
  p_session uuid default null, p_receipts uuid[] default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  allowed text[];
  cards jsonb;
  page_size integer;
begin
  select c.data_tools into allowed from neckardt_mcp.clients c where c.client_id = p_client and c.owner_id = p_actor;
  if p_session is not null and cardinality(p_receipts)>0 then
    select coalesce(allowed, '{}'::text[]) || coalesce(array_agg(t.tool order by t.tool), '{}'::text[])
      into allowed from neckardt_mcp.app_sessions(p_actor,p_client) s
      cross join lateral unnest(case s.app
        when 'habit_cards' then array['get_cards','create_cards']
        when 'tasks' then array['list_tasks','create_task','update_task','complete_task','set_task_focus'] end) t(tool)
      where s.session_id=p_session and s.receipt = any(p_receipts);
  end if;
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
revoke all on function public.neckardt_mcp_data(uuid,uuid,text,jsonb,uuid,uuid[]) from public, anon, authenticated, service_role;
grant execute on function public.neckardt_mcp_data(uuid,uuid,text,jsonb,uuid,uuid[]) to service_role;
notify pgrst, 'reload schema';
commit;
