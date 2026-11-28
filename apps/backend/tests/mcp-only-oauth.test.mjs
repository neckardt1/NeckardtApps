import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { discoverOAuthServerInfo } from '@modelcontextprotocol/sdk/client/auth.js';
import { createBroker } from '../supabase/functions/neckardt-apps-mcp/oauth.ts';
import { consentOrigin, issuerMetadata, mcpIssuer } from '../supabase/functions/_shared/mcp-oauth-metadata.ts';
import { createHandler } from '../supabase/functions/neckardt-apps-mcp/server.ts';
import { createEvents } from '../supabase/functions/neckardt-apps-mcp/apps/habit-practice/events.ts';
import project from '../supabase/functions/_shared/public-config.json' with { type:'json' };

test('separate MCP-only grants through the public connection entry points', async t => {
  const db = new PGlite();
  t.after(() => db.close());
  await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
    create role supabase_auth_admin; create schema auth; create table auth.users(id uuid primary key);
    create function auth.uid() returns uuid language sql stable as $$ select null::uuid $$;
    grant usage on schema auth to authenticated;`);
  const migrations = new URL('../supabase/migrations/', import.meta.url);
  for (const name of (await readdir(migrations)).filter(n => n.endsWith('.sql')).sort())
    await db.exec(await readFile(new URL(name, migrations), 'utf8'));
  const owner = randomUUID(), other = randomUUID(), legacyId = randomUUID();
  const muse = 'neckardt-muse', chat = 'neckardt-chatgpt';
  const callbacks = { [muse]:'https://agent.meta.ai/api/hatch/oauth/callback', [chat]:'https://chatgpt.com/connector_platform_oauth_redirect' };
  await db.query('insert into auth.users values ($1),($2)', [owner, other]);
  await db.query('insert into mcp_oauth.pilot_owner(owner_id) values ($1)', [owner]);
  await assert.rejects(db.query('insert into mcp_oauth.pilot_owner(owner_id) values ($1)', [other]));
  await assert.rejects(db.query('insert into mcp_oauth.clients values ($1,$2,$3)', [muse,other,callbacks[muse]]));
  for (const [id, callback] of Object.entries(callbacks))
    await db.query('insert into mcp_oauth.clients values ($1,$2,$3)', [id,owner,callback]);
  for (const role of ['anon','authenticated','supabase_auth_admin']) {
    const { rows } = await db.query(`select has_schema_privilege($1,'mcp_oauth','usage') as storage,
      has_function_privilege($1,'public.mcp_oauth_grant(text,jsonb)','execute') as grants,
      has_function_privilege($1,'public.mcp_oauth_event(text,jsonb,uuid)','execute') as events`, [role]);
    assert.deepEqual(rows[0], { storage:false, grants:false, events:false });
  }
  await db.exec('set role service_role');
  const rpc = async (action,payload) => (await db.query('select public.mcp_oauth_grant($1,$2) as v', [action,JSON.stringify(payload)])).rows[0].v;
  const resource = project.url + '/functions/v1/neckardt-apps-mcp';
  const broker = createBroker(resource, rpc, async v => v === 'local-browser-session' ? owner : v === 'other-session' ? other : null);
  const { privateKey,publicKey } = await generateKeyPair('ES256');
  const keys = createLocalJWKSet({ keys:[{ ...await exportJWK(publicKey), kid:'fixture' }] });
  const events = createEvents(async (action,p,grant) => {
    if (!grant) {
      if (action === 'subscribe_automatic') return (await db.query('select public.habit_notify_subscribe_automatic($1) as v',[JSON.stringify(p)])).rows[0].v;
      return (await db.query('select public.habit_notify_rpc($1,$2) as v',[action,JSON.stringify(p)])).rows[0].v;
    }
    return (await db.query('select public.mcp_oauth_event($1,$2,$3) as v', [action, JSON.stringify(p), grant])).rows[0].v;
  }, undefined, async (_url,post) => ({ status:200, body:JSON.stringify({ challenge:JSON.parse(post.body).challenge }) }));
  const serve = createHandler(project.url, broker, legacyId, keys, events);
  const legacyIssuer = project.url + '/auth/v1';
  const legacy = await new SignJWT({ role:'neckardt_apps_oauth', sub:owner, session_id:randomUUID(), client_id:legacyId, is_anonymous:false })
    .setAudience(resource).setIssuer(legacyIssuer).setIssuedAt().setExpirationTime('5m').setProtectedHeader({ alg:'ES256',kid:'fixture' }).sign(privateKey);
  const call = (bearer, method='tools/call', params={name:'get_habit_practice_link',arguments:{}}) => serve(new Request(resource, {
    method:'POST', headers:{ 'Content-Type':'application/json', Accept:'application/json, text/event-stream', ...(bearer ? { Authorization:'Bearer ' + bearer } : {}) },
    body:JSON.stringify({ jsonrpc:'2.0', id:1, method, params }) }));
  async function accepts(bearer) {
    const res = await call(bearer);
    assert.equal(res.status, 200);
    assert.equal((await res.json()).result?.structuredContent?.url, 'https://apps.neckardt.com/recall/');
  }
  function form(route, data, hdr = {}) {
    return serve(new Request(resource + '/oauth/' + route, { method:'POST',headers:hdr, body:new URLSearchParams(data) }));
  }
  function flow(id, scope) {
    const verifier = randomBytes(32).toString('base64url');
    const a = { client_id:id, redirect_uri:callbacks[id], resource, response_type:'code', state:randomUUID(),
      code_challenge_method:'S256', code_challenge:createHash('sha256').update(verifier).digest('base64url'), scope };
    const consent = (decision, overrides={}, session='local-browser-session') => form('consent', { ...a, ...overrides, decision },
      { Origin:consentOrigin, Authorization:'Bearer ' + session });
    const exchange = (code,extra={}) => form('token', { client_id:id, redirect_uri:a.redirect_uri, resource, grant_type:'authorization_code',
      code, code_verifier:verifier, ...extra });
    async function approve() {
      const result = await (await consent('approve')).json();
      const dest = new URL(result.redirect_uri);
      assert.equal(dest.origin + dest.pathname, a.redirect_uri);
      assert.equal(dest.searchParams.get('state'), a.state);
      assert.equal(dest.searchParams.get('iss'), mcpIssuer);
      assert.deepEqual([...dest.searchParams.keys()].sort(), ['code','iss','state']);
      return dest.searchParams.get('code');
    }
    return { a, consent, exchange, approve, tokens:async () => (await exchange(await approve())).json() };
  }
  const refresh = (id,token,extra={}) => form('token', { grant_type:'refresh_token', client_id:id, refresh_token:token, resource, ...extra });
  const revoke = (id,token) => form('revoke', { client_id:id, token });
  const museFlow = flow(muse,'habit:link'), chatFlow = flow(chat,'habit:events habit:link offline_access');
  let museTokens, chatTokens;

  await t.test('shared discovery preserves the old issuer while the pinned entry finds the new one', async () => {
    const challenge = (await serve(new Request(resource))).headers.get('www-authenticate');
    assert.ok(challenge.includes(resource + '/.well-known/oauth-protected-resource'));
    assert.ok(!challenge.includes('scope='));
    const metadata = await (await serve(new Request(resource + '/.well-known/oauth-protected-resource'))).json();
    assert.deepEqual(metadata.authorization_servers, [legacyIssuer,mcpIssuer]);
    assert.equal(metadata.scopes_supported, undefined);
    const installed = JSON.parse(await readFile(new URL('../../../integrations/chatgpt/mcp.json.template', import.meta.url), 'utf8')).mcpServers['neckardt-apps'];
    const candidate = JSON.parse(await readFile(new URL('../../../integrations/chatgpt-mcp-only/mcp.json', import.meta.url), 'utf8')).mcpServers['neckardt-apps'];
    const setup = candidate.extensions['com.openai'].auth;
    assert.deepEqual(installed.extensions['com.openai'].auth.baseScopes,['openid']);
    assert.equal(setup.authorizationServerBase,mcpIssuer);
    assert.equal(setup.client.clientId,chat);
    assert.equal(setup.client.tokenEndpointAuthMethod,'none');
    assert.equal(setup.oidcEnabled,false);
    assert.deepEqual(setup.defaultScopes,[]);
    assert.deepEqual(setup.baseScopes,['habit:link','offline_access']);
    assert.equal(setup.tokenUrl,issuerMetadata(resource).token_endpoint);
    assert.equal(setup.authorizationUrl,issuerMetadata(resource).authorization_endpoint);
    assert.equal(candidate.url,resource);
    const requested = [];
    const info = await discoverOAuthServerInfo(new URL(resource), {
      resourceMetadataUrl:new URL(resource + '/oauth/resource'),
      fetchFn:async input => {
        const url = String(input);
        requested.push(url);
        if (url === resource + '/oauth/resource') return serve(new Request(url));
        assert.equal(url, consentOrigin + '/.well-known/oauth-authorization-server/mcp.json');
        return Response.json(issuerMetadata(resource));
      }
    });
    assert.equal(info.authorizationServerUrl, mcpIssuer);
    assert.equal(info.authorizationServerMetadata.token_endpoint, resource + '/oauth/token');
    assert.equal(requested.length, 2);
    await accepts(legacy);
  });
  await t.test('consent requires the bound account, exact callback, scopes and PKCE, and denial mints nothing', async () => {
    assert.deepEqual(await (await museFlow.consent('review')).json(), { name:'Muse', scope:'habit:link', redirect_uri:callbacks[muse] });
    for (const change of [{ redirect_uri:callbacks[chat] }, { resource:'https://elsewhere.invalid' }, { scope:'habit:events habit:link' },
      { scope:'openid email' }, { scope:'habit:link offline_access' }, { code_challenge_method:'plain' }, { response_type:'token' }, { client_id:'unregistered' }])
      assert.ok((await museFlow.consent('approve',change)).status >= 400);
    assert.equal((await museFlow.consent('approve',{},'other-session')).status,403);
    assert.equal((await museFlow.consent('approve',{},legacy)).status,403);
    assert.equal((await form('consent',{ ...museFlow.a, decision:'approve' },{ Origin:'https://elsewhere.invalid',Authorization:'Bearer local-browser-session' })).status,403);
    const denied = new URL((await (await museFlow.consent('deny')).json()).redirect_uri);
    assert.equal(denied.searchParams.get('error'),'access_denied');
    assert.equal((await db.query('select count(*)::int as n from mcp_oauth.grants')).rows[0].n,0);
  });
  await t.test('tokens are bound to code, client, verifier, callback and resource', async () => {
    const alternate = await chatFlow.consent('approve', { redirect_uri:'https://chatgpt.com/connector/oauth/AnotherValidShape' });
    assert.equal(alternate.status,403);
    const code = await museFlow.approve();
    for (const change of [{ client_id:chat }, { redirect_uri:callbacks[chat] }, { code_verifier:'a'.repeat(43) }, { resource:project.url }]) {
      const res = await museFlow.exchange(code,change);
      assert.equal(res.status,400);
    }
    museTokens = await (await museFlow.exchange(code)).json();
    assert.match(museTokens.access_token,/^nmc_a_[\w-]{43}$/);
    assert.equal(museTokens.scope,'habit:link');
    assert.equal(museTokens.expires_in,600);
    assert.equal(museTokens.refresh_token,undefined);
    assert.equal(museTokens.id_token,undefined);
    await accepts(museTokens.access_token);
    assert.equal((await call(code)).status,401);
    for (const method of ['events/list','events/subscribe','events/unsubscribe']) {
      assert.equal((await (await call(museTokens.access_token,method,{})).json()).error.code,-32601);
    }
    await accepts(legacy);
  });
  await t.test('the same locally issued MCP token is rejected by hosted Supabase Auth and Data', {
    skip:process.env.MCP_CHECK_HOSTED_DENIAL !== '1'
  }, async () => {
    const health = await fetch(project.url + '/auth/v1/health', { headers:{ apikey:project.publishableKey } });
    assert.equal(health.status,200);
    await health.body?.cancel();
    // The schema root requires a secret key even when the bearer is valid. A nonexistent
    // table lets us distinguish credential rejection from successful anonymous routing.
    const dataPath = '/rest/v1/mcp_oauth_boundary_check?limit=0';
    const baseline = await fetch(project.url + dataPath, { headers:{ apikey:project.publishableKey } });
    assert.equal(baseline.status,404);
    assert.equal((await baseline.json()).code, 'PGRST205');
    for (const [path, expected] of [['/auth/v1/user', [401,403]], [dataPath, [401]]]) {
      const res = await fetch(project.url + path, { redirect:'error', signal:AbortSignal.timeout(10000),
        headers:{ apikey:project.publishableKey, Authorization:'Bearer ' + museTokens.access_token } });
      assert.ok(expected.includes(res.status), path + ' returned ' + res.status);
      const data = await res.json();
      const code = res.headers.get('x-sb-error-code') ?? data.error_code ?? data.code;
      assert.match(String(code), /^(bad_jwt|invalid_jwt|PGRST30[013])$/i, path + ' rejection code: ' + code);
      t.diagnostic(path + ' returned HTTP ' + res.status + ' (' + code + ')');
    }
  });
  await t.test('ChatGPT reconnect and refresh leave Muse and legacy ChatGPT independent', async () => {
    chatTokens = await chatFlow.tokens();
    await accepts(chatTokens.access_token);
    assert.match(chatTokens.refresh_token,/^nmc_r_[\w-]{43}$/);
    assert.equal((await call(chatTokens.refresh_token)).status,401);
    assert.equal((await refresh(muse,chatTokens.refresh_token)).status,400);
    await revoke(muse,chatTokens.access_token);
    await accepts(chatTokens.access_token);
    const renewed = await (await refresh(chat,chatTokens.refresh_token)).json();
    assert.notEqual(renewed.refresh_token,chatTokens.refresh_token);
    assert.equal((await call(chatTokens.access_token)).status,401);
    await accepts(renewed.access_token);
    const pending = await chatFlow.approve();
    await accepts(renewed.access_token);
    chatTokens = await (await chatFlow.exchange(pending)).json();
    assert.equal((await refresh(chat,renewed.refresh_token)).status,400);
    await accepts(chatTokens.access_token);
    await accepts(museTokens.access_token);
    await accepts(legacy);
  });
  await t.test('explicit per-client disconnect revokes its family and leaves the other access and refresh valid', async () => {
    const disconnect = (id,decision,session) => form('consent', { client_id:id, decision }, {
      Origin:consentOrigin, Authorization:'Bearer ' + session });
    assert.equal((await disconnect(muse,'disconnect','other-session')).status,403);
    assert.equal((await disconnect(muse,'review_disconnect','local-browser-session')).status,200);
    await accepts(museTokens.access_token);
    assert.equal((await disconnect(muse,'disconnect','local-browser-session')).status,200);
    assert.equal((await call(museTokens.access_token)).status,401);
    chatTokens = await (await refresh(chat,chatTokens.refresh_token)).json();
    await accepts(chatTokens.access_token);
    museTokens = await museFlow.tokens();
    await revoke(chat,chatTokens.refresh_token);
    assert.equal((await call(chatTokens.access_token)).status,401);
    assert.equal((await refresh(chat,chatTokens.refresh_token)).status,400);
    await accepts(museTokens.access_token);
    await accepts(legacy);
  });
  await t.test('refresh replay revokes exactly one family; link-only ChatGPT has no event permission', async () => {
    const pair = await flow(chat,'habit:link offline_access').tokens();
    assert.equal((await (await call(pair.access_token,'events/list',{})).json()).error.code,-32601);
    const next = await (await refresh(chat,pair.refresh_token)).json();
    assert.equal((await refresh(chat,pair.refresh_token)).status,400);
    assert.equal((await call(next.access_token)).status,401);
    assert.equal((await refresh(chat,next.refresh_token)).status,400);
    await accepts(museTokens.access_token);
  });
  await t.test('expired, duplicated, and replayed grants fail closed without revoking the other client', async () => {
    const attempt = flow(chat,'habit:link offline_access');
    const expiredCode = await attempt.approve();
    await db.query("update mcp_oauth.grants set code_until = now() - interval '1 second' where client_id=$1 and not issued", [chat]);
    assert.equal((await attempt.exchange(expiredCode)).status,400);
    const code = await attempt.approve();
    const races = await Promise.all([attempt.exchange(code),attempt.exchange(code)]);
    assert.deepEqual(races.map(r => r.status).sort(),[200,400]);
    const { access_token,refresh_token } = await races.find(r => r.ok).json();
    assert.equal((await call(access_token)).status,401);
    assert.equal((await refresh(chat,refresh_token)).status,400);
    const valid = await attempt.tokens();
    await db.query("update mcp_oauth.grants set expires_at=now() - interval '1 second' where client_id=$1", [chat]);
    assert.equal((await call(valid.access_token)).status,401);
    assert.equal((await refresh(chat,valid.refresh_token)).status,400);
    await accepts(museTokens.access_token);
    await accepts(legacy);
  });
  await t.test('revoking an opted-in ChatGPT grant removes only its own listener', async () => {
    const pair = await chatFlow.tokens();
    const params = { name:'habit.practice.round.completed', arguments:{automatic:true},
      delivery:{ mode:'webhook',url:'https://connectors.api.openai.com/fixture',secret:'whsec_' + randomBytes(32).toString('base64') } };
    const old = await (await call(legacy,'events/subscribe',params)).json();
    assert.ok(old.result?.id);
    assert.ok((await (await call(pair.access_token,'events/subscribe',params)).json()).error);
    assert.deepEqual((await (await call(pair.access_token,'events/unsubscribe',params)).json()).result, {});
    await revoke(chat,pair.access_token);
    await db.exec('reset role');
    assert.equal((await db.query('select id from habit_notify.listeners where mcp_grant is null')).rows[0].id,old.result.id);
    await db.exec('set role service_role');
    assert.deepEqual((await (await call(legacy,'events/unsubscribe',params)).json()).result, {});
    const replacement = await chatFlow.tokens();
    const result = await (await call(replacement.access_token,'events/subscribe',params)).json();
    assert.ok(result.result?.id);
    const count = async () => {
      await db.exec('reset role');
      const n = (await db.query('select count(*)::int as n from habit_notify.listeners where mcp_grant is not null')).rows[0].n;
      await db.exec('set role service_role');
      return n;
    };
    assert.equal(await count(),1);
    await revoke(muse,museTokens.access_token);
    assert.equal(await count(),1);
    await revoke(chat,replacement.access_token);
    assert.equal(await count(),0);
    await accepts(legacy);
  });
});
