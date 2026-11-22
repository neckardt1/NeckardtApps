-- Run on a disposable Supabase-compatible Postgres after the migrations.
begin;
insert into recall_canary.oauth_clients (client_id, subject_id, audience) values
  ('f0620723-ae17-441c-a052-2ca208ed723c', '0e5377be-73fc-4df4-90cc-fee224a4031a',
   'https://aaaaaaaaaaaaaaaaaaaa.supabase.co/functions/v1/recall-events/web/mcp'),
  ('96fc159c-14e2-4182-a902-a3c4d02efaf7', null,
   'https://aaaaaaaaaaaaaaaaaaaa.supabase.co/functions/v1/recall-events/web/mcp');

set local role supabase_auth_admin;
do $$
declare
  subject text := '0e5377be-73fc-4df4-90cc-fee224a4031a';
  other_subject text := '9b516c2b-6f59-415a-b670-de8d926aa861';
  client text := 'f0620723-ae17-441c-a052-2ca208ed723c';
  audience text := 'https://aaaaaaaaaaaaaaaaaaaa.supabase.co/functions/v1/recall-events/web/mcp';
  claims jsonb := jsonb_build_object('role', 'authenticated', 'sub', subject, 'aud', 'authenticated',
                                     'is_anonymous', false, 'scope', 'openid', 'session_id', 'fixture');
  event jsonb := jsonb_build_object('claims',claims,'user_id',subject);
  error_path text[] := '{error,http_code}';
  result jsonb;
begin
  assert public.recall_canary_access_token_hook(event)->'claims' = claims, 'first-party login changed';
  claims := claims || '{"client_id":"08b951b3-ee26-49e1-b680-fd45d34253fc"}';
  event := jsonb_set(event,'{claims}',claims);
  assert public.recall_canary_access_token_hook(event)->'claims' = claims, 'other OAuth client changed';
  claims := claims || jsonb_build_object('client_id', client);
  event := jsonb_set(event,'{claims}',claims);
  result := public.recall_canary_access_token_hook(event || '{"authentication_method":"oauth_provider/authorization_code"}');
  assert result->'claims' = claims || jsonb_build_object('role','recall_canary_oauth','aud',audience),
         'code exchange claims mismatch';
  assert public.recall_canary_access_token_hook(event || '{"authentication_method":"token_refresh"}') = result,
         'refresh changed audience or role';
  assert (public.recall_canary_access_token_hook(event || jsonb_build_object('user_id', other_subject))
          #>> error_path) = '403', 'wrong session subject accepted';
  assert (public.recall_canary_access_token_hook(jsonb_set(event,'{claims,sub}',to_jsonb(other_subject)))
          #>> error_path) = '403', 'wrong token subject accepted';
  assert (public.recall_canary_access_token_hook(jsonb_set(event,'{claims,is_anonymous}','true'))
          #>> error_path) = '403', 'anonymous user accepted';
  assert (public.recall_canary_access_token_hook(jsonb_set(event,'{claims,client_id}',
          '"96fc159c-14e2-4182-a902-a3c4d02efaf7"')) #>> error_path) = '403', 'disabled client accepted';
  assert not has_function_privilege('authenticated','public.recall_canary_access_token_hook(jsonb)','execute');
  assert not has_function_privilege('anon','public.recall_canary_access_token_hook(jsonb)','execute');
  assert not has_table_privilege('authenticated','recall_canary.oauth_clients','select');
  assert not has_table_privilege('supabase_auth_admin','recall_canary.oauth_clients','update');
  assert to_regrole('recall_canary_oauth') is null, 'resource token role exists';
  begin
    execute 'set local role recall_canary_oauth';
    raise exception 'resource token acquired a database role';
  exception when invalid_parameter_value or insufficient_privilege then
    null;
  end;
end;
$$;
rollback;
