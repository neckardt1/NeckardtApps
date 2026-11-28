import { act } from 'react';
import type { Root } from 'react-dom/client';
import type { SupabaseClient } from '@supabase/supabase-js';
import { afterEach, expect, test, vi } from 'vitest';
import type { Round } from '../src/apps/habit-practice/durable-session.ts';

const captured = vi.hoisted(() => ({ clients: [] as SupabaseClient[], roots: [] as Root[] }));
// Capture cleanup handles, but run the actual SDK and actual React entry.
vi.mock('@supabase/supabase-js', async importOriginal => {
  const original = await importOriginal<typeof import('@supabase/supabase-js')>();
  return { ...original, createClient: (...args: Parameters<typeof original.createClient>) => {
    const client = original.createClient(...args); captured.clients.push(client); return client;
  } };
});
vi.mock('react-dom/client', async importOriginal => {
  const original = await importOriginal<typeof import('react-dom/client')>();
  return { ...original, createRoot: (...args: Parameters<typeof original.createRoot>) => {
    const root = original.createRoot(...args); captured.roots.push(root); return root;
  } };
});

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let stopAccount = () => {};
const originalUrl = location.href;
afterEach(async () => {
  stopAccount();
  await act(async () => { for (const root of captured.roots.splice(0)) root.unmount(); });
  for (const client of captured.clients.splice(0)) await client.auth.dispose();
  document.body.replaceChildren(); localStorage.clear(); sessionStorage.clear();
  history.replaceState({}, '', originalUrl);
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs();
});

const snapshot = (storage: Storage) => Object.fromEntries(
  Array.from({ length: storage.length }, (_, index) => storage.key(index)!).sort().map(key => [key, storage.getItem(key)])
);

test.each([
  { kind: 'canary', scope: 'openid' },
  { kind: 'suite', scope: 'openid' },
  { kind: 'suite', scope: 'openid email offline_access' }
])('the $kind entry explains and approves $scope while preserving Account identity', async ({ kind, scope }) => {
  vi.resetModules();
  const { getSiteClient } = await import('../src/shell/site-client');
  const { makeSiteSessionApi } = await import('../src/shell/session');
  const config = { url: 'https://abcdefghijklmnopqrst.supabase.co', publishableKey: 'sb_publishable_entry_fixture' };
  const account = { id: '44444444-4444-4444-8444-444444444444', email: 'owner@example.invalid' };
  const member = kind === 'suite'
    ? { id: '33333333-3333-4333-8333-333333333333', email: 'member@example.invalid' }
    : { id: '11111111-1111-4111-8111-111111111111', email: 'canary@example.invalid' };
  const canaryClientId = '22222222-2222-4222-8222-222222222222';
  const suiteClientId = '55555555-5555-4555-8555-555555555555';
  const clientId = kind === 'suite' ? suiteClientId : canaryClientId;
  const authorizationId = 'unfpzwemgihdvyhaj5kl3xqfysfnmsyg';
  const canaryCallback = 'https://chat.example.invalid/canary';
  const suiteCallback = 'https://chat.example.invalid/suite';
  const callback = kind === 'suite' ? suiteCallback : canaryCallback;
  const authKey = 'sb-abcdefghijklmnopqrst-auth-token';
  const roundKey = `recall.round.v2.${config.url}.${account.id}`;
  const pending: Round = {
    version: 2, id: 'synthetic-round', cards: [{ card_id: 'synthetic-card', front: 'Synthetic question', back: 'Synthetic answer', revision: 0 }],
    opportunities: [], cardIndex: 1, opportunityIndex: 0, revealed: false, started: true, finished: false,
    saves: [{ kind: 'review', status: 'pending', event: {
      review_id: 'synthetic-review', card_id: 'synthetic-card', revision: 0, grade: 'medium', reviewed_at: '2026-01-01T00:00:00Z'
    } }]
  };
  localStorage.clear(); sessionStorage.clear();
  localStorage.setItem(authKey, JSON.stringify({ access_token: 'synthetic-account-access', refresh_token: 'synthetic-account-refresh',
    token_type: 'bearer', expires_at: Math.floor(Date.now() / 1000) + 3600, user: account }));
  localStorage.setItem(roundKey, JSON.stringify(pending));
  sessionStorage.setItem('unrelated-browser-state', 'preserved');
  vi.stubGlobal('__SITE_PUBLIC_CONFIG__', config);
  vi.stubEnv('VITE_CANARY_USER_DIGEST', '30ffc7cc343265aa0f8bf7c138b8d3d8752630a527e66c95eafbe261f1c48d06');
  vi.stubEnv('VITE_CANARY_CLIENT_ID', canaryClientId);
  vi.stubEnv('VITE_CANARY_CALLBACK_URL', canaryCallback);
  vi.stubEnv('VITE_SUITE_CLIENT_ID', suiteClientId);
  vi.stubEnv('VITE_SUITE_CALLBACK_URL', suiteCallback);
  history.replaceState({}, '', `/oauth/consent/?authorization_id=${authorizationId}`);
  const redirect = vi.spyOn(window.location, 'replace').mockImplementation(() => {});
  const calls: { path: string; body: unknown; bearer: string | null }[] = [];
  // Every SDK request is served locally; unknown destinations fail closed.
  const network = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = new URL(String(input));
    expect(url.origin).toBe(config.url);
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : null;
    const bearer = new Headers(init?.headers).get('authorization');
    calls.push({ path: url.pathname + url.search, body, bearer });
    if (url.pathname === '/auth/v1/token' && url.search === '?grant_type=password') {
      expect(body).toMatchObject({ email: member.email, password: 'synthetic-consent-password' });
      return Response.json({ access_token: 'synthetic-consent-access', refresh_token: 'synthetic-consent-refresh',
        token_type: 'bearer', expires_in: 3600, user: member });
    }
    expect(bearer).toBe('Bearer synthetic-consent-access');
    if (url.pathname === `/auth/v1/oauth/authorizations/${authorizationId}` && init?.method === 'GET') {
      return Response.json({ authorization_id: authorizationId, user: member, client: { id: clientId, name: kind === 'suite' ? 'Neckardt Apps MCP' : 'Synthetic canary' },
        scope, redirect_uri: callback });
    }
    if (url.pathname === `/auth/v1/oauth/authorizations/${authorizationId}/consent` && init?.method === 'POST') {
      expect(body).toEqual({ action: 'approve' });
      return Response.json({ redirect_url: `${callback}?code=synthetic-code&state=synthetic-state` });
    }
    throw Error('Unexpected network request in synthetic OAuth entry test');
  });
  const normalClient = getSiteClient(config);
  expect((await normalClient.auth.getSession()).data.session?.user.id).toBe(account.id);
  const observed = vi.fn(); stopAccount = makeSiteSessionApi(config)!.observe(observed);
  await vi.waitFor(() => expect(observed).toHaveBeenCalledWith(account));
  expect(network).not.toHaveBeenCalled();
  const localBefore = snapshot(localStorage), sessionBefore = snapshot(sessionStorage);
  const writes = vi.spyOn(Storage.prototype, 'setItem');
  const host = document.createElement('main'); host.id = 'root'; document.body.append(host);
  await act(async () => { await import('../src/oauth/main'); });
  expect(host.textContent).toContain('Connect to Neckardt Apps');
  expect(host.textContent).toContain('Sign in with your Neckardt Apps account');
  const form = host.querySelector('form')!;
  form.querySelector<HTMLInputElement>('[name="email"]')!.value = member.email;
  form.querySelector<HTMLInputElement>('[name="password"]')!.value = 'synthetic-consent-password';
  await act(async () => {
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(calls).toHaveLength(2));
  });
  expect(host.textContent).toContain('Allow access?');
  expect(host.textContent).toContain(member.email);
  if (kind === 'suite') expect(host.textContent).toContain('get the link to Habit Practice');
  expect(host.textContent?.includes('email address and its verification status')).toBe(scope.includes('email'));
  expect(host.textContent?.includes('refresh this connection')).toBe(scope.includes('offline_access'));
  expect(calls.map(call => call.path)).toEqual([
    '/auth/v1/token?grant_type=password', `/auth/v1/oauth/authorizations/${authorizationId}`
  ]);
  expect(redirect).not.toHaveBeenCalled();
  expect(snapshot(localStorage)).toEqual(localBefore);
  expect(snapshot(sessionStorage)).toEqual(sessionBefore);
  const allow = [...host.querySelectorAll('button')].find(button => button.textContent === 'Allow')!;
  await act(async () => {
    allow.click();
    await vi.waitFor(() => expect(redirect).toHaveBeenCalledExactlyOnceWith(`${callback}?code=synthetic-code&state=synthetic-state`));
  });
  expect(calls).toHaveLength(3);
  expect((await normalClient.auth.getSession()).data.session?.user.id).toBe(account.id);
  expect(observed.mock.calls.every(([user]) => user?.id === account.id)).toBe(true);
  const consentClient = captured.clients.find(client => client !== normalClient)!;
  expect((await consentClient.auth.getSession()).data.session?.user.id).toBe(member.id);
  expect(snapshot(localStorage)).toEqual(localBefore);
  expect(snapshot(sessionStorage)).toEqual(sessionBefore);
  expect(JSON.parse(localStorage.getItem(roundKey)!)).toEqual(pending);
  expect(writes.mock.calls.some(([key, value]) => key === 'neckardt-apps-oauth-consent'
    || /synthetic-consent-(?:access|refresh|password)/.test(value) || value.includes(member.email))).toBe(false);
});

test.each([
  { id:'neckardt-muse', scope:'habit:link', callback:'https://agent.meta.ai/api/hatch/oauth/callback', name:'Muse' },
  { id:'neckardt-chatgpt', scope:'habit:events habit:link offline_access', callback:'https://chatgpt.com/connector_platform_oauth_redirect', name:'ChatGPT' }
])('the $name MCP-only entry shares only the approved code and shows the actual scope', async ({ id,scope,callback,name }) => {
  vi.resetModules();
  const config = { url:'https://abcdefghijklmnopqrst.supabase.co', publishableKey:'sb_publishable_entry_fixture' };
  const resource = config.url + '/functions/v1/neckardt-apps-mcp';
  const issuer = 'https://apps.neckardt.com/mcp.json';
  const query = new URLSearchParams({ client_id:id, redirect_uri:callback, resource, state:'synthetic-state',
    scope, response_type:'code', code_challenge_method:'S256', code_challenge:'a'.repeat(43) });
  const dest = new URL(callback);
  dest.search = new URLSearchParams({ code:'nmc_c_' + 'a'.repeat(43), state:'synthetic-state', iss:issuer }).toString();
  history.replaceState({}, '', '/oauth/consent/?' + query);
  vi.stubGlobal('__SITE_PUBLIC_CONFIG__', config);
  const redirect = vi.spyOn(window.location, 'replace').mockImplementation(() => {});
  const dbCalls: string[] = [];
  const storageBefore = [snapshot(localStorage),snapshot(sessionStorage)];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input,init) => {
    if (String(input) === config.url + '/auth/v1/token?grant_type=password') {
      return Response.json({ access_token:'synthetic-first-party-access', refresh_token:'synthetic-first-party-refresh', token_type:'bearer',
        expires_in:3600, user:{ id:'11111111-1111-4111-8111-111111111111',email:'person@example.invalid' } });
    }
    expect(String(input)).toBe(resource + '/oauth/consent');
    expect(init?.redirect).toBe('error');
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer synthetic-first-party-access');
    const body = new URLSearchParams(String(init?.body));
    const decision = body.get('decision')!;
    body.delete('decision');
    expect(body.toString()).toBe(query.toString());
    dbCalls.push(decision);
    return Response.json(decision === 'review' ? { name,scope,redirect_uri:callback } : { redirect_uri:dest.href });
  });
  const host = document.createElement('main'); host.id = 'root'; document.body.append(host);
  await act(async () => { await import('../src/oauth/main'); });
  const form = host.querySelector('form')!;
  form.querySelector<HTMLInputElement>('[name="email"]')!.value = 'person@example.invalid';
  form.querySelector<HTMLInputElement>('[name="password"]')!.value = 'synthetic-consent-password';
  await act(async () => {
    form.dispatchEvent(new Event('submit', { bubbles:true, cancelable:true }));
    await vi.waitFor(() => expect(dbCalls).toEqual(['review']));
  });
  expect(host.textContent).toContain('Allow access?');
  expect(host.textContent).toContain('Get the link to Habit Practice');
  expect(host.textContent?.includes('card names')).toBe(scope.includes('habit:events'));
  expect(host.textContent?.includes('Refresh this connection')).toBe(scope.includes('offline_access'));
  expect(redirect).not.toHaveBeenCalled();
  const allow = [...host.querySelectorAll('button')].find(b => b.textContent === 'Allow')!;
  await act(async () => {
    allow.click();
    await vi.waitFor(() => expect(redirect).toHaveBeenCalledExactlyOnceWith(dest.href));
  });
  expect(dbCalls).toEqual(['review','approve']);
  expect([snapshot(localStorage),snapshot(sessionStorage)]).toEqual(storageBefore);
  expect(dest.search).not.toContain('first-party');
});
