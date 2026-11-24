import { createClient } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';
import { configured, openRequest, decide, ownerDigest, readAuthorizationId } from '../src/oauth/flow';

const userId = '11111111-1111-4111-8111-111111111111';
const clientId = '22222222-2222-4222-8222-222222222222';
const id = 'jp5ugn7b3fsj6wmgveqvbni7ynxl7yag';
const callback = 'https://chat.example/return';
const scope = 'openid';
const userDigest = '30ffc7cc343265aa0f8bf7c138b8d3d8752630a527e66c95eafbe261f1c48d06';
const limits = { kind: 'canary' as const, userDigest, clientId, callback };
const user = { id: userId, email: 'canary@example.test' };
const details = { authorization_id: id, user, client: { id: clientId, name: 'Recall canary' }, scope, redirect_uri: callback };
const endpoint = '/auth/v1/oauth/authorizations/' + id;

function fixture(options: { loginId?: string; anonymous?: boolean; authorization?: unknown; redirect?: string } = {}) {
  const calls: { path: string; body: Record<string, unknown> }[] = [];
  // Exercise the pinned SDK against the same HTTP contract the hosted server uses.
  const client = createClient('https://abcdefghijklmnopqrst.supabase.co', 'sb_publishable_fixture', {
    auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false, storageKey: crypto.randomUUID() },
    global: { fetch: async (resource, init) => {
      const url = new URL(String(resource));
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) : {};
      calls.push({ path: url.pathname + url.search, body });
      if (url.pathname === '/auth/v1/token') {
        expect(url.search).toBe('?grant_type=password');
        return Response.json({ access_token: 'fixture-access', refresh_token: 'fixture-refresh', token_type: 'bearer',
          expires_in: 3600, user: { ...user, id: options.loginId ?? userId, is_anonymous: options.anonymous ?? false } });
      }
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer fixture-access');
      if (url.pathname === endpoint && init?.method === 'GET') return Response.json(options.authorization ?? details);
      if (url.pathname === endpoint + '/consent' && init?.method === 'POST') {
        return Response.json({ redirect_url: options.redirect ?? callback + '?state=fake&code=fixture' });
      }
      throw new Error('Unexpected synthetic request');
    } }
  });
  return { auth: client.auth, calls };
}
describe('canary authorization', () => {
  it('hashes the canonical lowercase UUID with the owner domain separator', async () => {
    expect(await ownerDigest('ABCDEFAB-CDEF-4ABC-8DEF-ABCDEFABCDEF'))
      .toBe('5526f90eb30cf09ec0bf857ee82f3ce4999b81d97365c877acba9fe58849b077');
    await expect(ownerDigest('')).rejects.toThrow('Invalid account identifier');
  });
  it('requires exactly one authorization ID in the query', () => {
    expect(readAuthorizationId('')).toBeNull();
    expect(readAuthorizationId(`?authorization_id=${id}`)).toBe(id);
    expect(readAuthorizationId(`?authorization_id=${id}&authorization_id=${id}`)).toBeNull();
  });
  it.each(['', userId, id.slice(1), id + 'a', id.toUpperCase(), '0' + id.slice(1), id + '\n'])(
    'rejects malformed authorization IDs before sign-in', async invalid => {
      const { auth, calls } = fixture();
      expect(readAuthorizationId(new URLSearchParams({ authorization_id: invalid }).toString())).toBeNull();
      await expect(openRequest(auth, invalid, [limits], user.email, 'fixture')).rejects.toThrow('Start a new connection');
      expect(calls).toEqual([]);
    }
  );
  it.each(['approve', 'deny'] as const)('submits %s only after an explicit decision', async action => {
    const { auth, calls } = fixture();
    const info = await openRequest(auth, id, [limits], user.email, 'fixture');
    expect(info.scope).toBe(scope);
    expect(calls.map(c => c.path)).toEqual(['/auth/v1/token?grant_type=password', endpoint]);
    expect(await decide(auth.oauth, id, callback, action)).toBe(callback + '?state=fake&code=fixture');
    expect(calls.at(-1)).toEqual({ path: endpoint + '/consent', body: { action } });
  });
  it.each(['openid email offline_access', 'openid email', 'profile', ''])('refuses consent for unsupported scopes', async scope => {
    const { auth, calls } = fixture({ authorization: { ...details, scope } });
    await expect(openRequest(auth, id, [limits], user.email, 'fixture')).rejects.toThrow('openid');
    expect(calls.map(call => call.path)).toEqual(['/auth/v1/token?grant_type=password', endpoint]);
  });
  it('refuses another signed-in user after identifying the canary', async () => {
    const { auth, calls } = fixture({ loginId: clientId, authorization: { ...details, user: { ...user, id: clientId } } });
    await expect(openRequest(auth, id, [limits], user.email, 'fixture')).rejects.toThrow('account authorized');
    expect(calls).toHaveLength(2);
  });
  it('refuses a different configured canary owner digest', async () => {
    const { auth, calls } = fixture();
    await expect(openRequest(auth, id, [{ ...limits, userDigest: '0'.repeat(64) }], user.email, 'fixture'))
      .rejects.toThrow('account authorized');
    expect(calls).toHaveLength(2);
  });
  it.each(['', userId, userDigest.toUpperCase()])('rejects an absent or invalid digest before login', async invalid => {
    const { auth, calls } = fixture();
    await expect(openRequest(auth, id, [{ ...limits, userDigest: invalid }], user.email, 'fixture'))
      .rejects.toThrow('Start a new connection');
    expect(calls).toEqual([]);
  });
  it.each([
    { ...details, client: { ...details.client, id: userId } },
    { ...details, user: { ...user, id: clientId } },
    { ...details, authorization_id: 'a' + id.slice(1) },
    { ...details, redirect_uri: callback + '-other' },
    { redirect_url: callback + '?code=fixture' }
  ])('refuses mismatched or unverifiable details', async authorization => {
    const { auth, calls } = fixture({ authorization });
    await expect(openRequest(auth, id, [limits], user.email, 'fixture')).rejects.toThrow();
    expect(calls).toHaveLength(2);
  });
  it('accepts only the registered loopback pilot URL and supports a later HTTPS callback', async () => {
    const pilot = 'http://127.0.0.1:45381/callback';
    const request = { ...details, redirect_uri: pilot };
    const { auth } = fixture({ authorization: request, redirect: pilot + '?code=fixture' });
    await openRequest(auth, id, [{ ...limits, callback: pilot }], user.email, 'fixture');
    expect(await decide(auth.oauth, id, pilot, 'approve')).toBe(pilot + '?code=fixture');
    expect(configured({ ...limits, callback: 'http://chat.example/callback' })).toBe(false);
    expect(configured({ ...limits, callback: 'http://127.0.0.1.example:45381/callback' })).toBe(false);
    const differentPort = { ...limits, callback: 'http://127.0.0.1:45382/callback' };
    await expect(openRequest(auth, id, [differentPort], user.email, 'fixture')).rejects.toThrow('registered');
    expect(configured(limits)).toBe(true);
  });
  it('rejects a response redirect outside the registered callback', async () => {
    const { auth } = fixture({ redirect: 'https://chat.example.invalid/return?code=fake' });
    await openRequest(auth, id, [limits], user.email, 'fixture');
    await expect(decide(auth.oauth, id, callback, 'approve')).rejects.toThrow('return address');
  });
  it('requires a valid authorization ID and complete configuration before sign-in', async () => {
    const { auth, calls } = fixture();
    await expect(openRequest(auth, '../x', [limits], user.email, 'fixture')).rejects.toThrow();
    await expect(openRequest(auth, id, [{ ...limits, clientId: '' }], user.email, 'fixture')).rejects.toThrow();
    expect(calls).toEqual([]);
  });
});

const suite = { kind: 'suite' as const, clientId: '33333333-3333-4333-8333-333333333333', callback };
const otherUser = '44444444-4444-4444-8444-444444444444';

function suiteDetails(subject: string) {
  return { ...details, user: { ...user, id: subject }, client: { id: suite.clientId, name: 'Neckardt Apps MCP' } };
}

describe('suite authorization', () => {
  it('recognizes the ChatGPT identity scopes in any order', async () => {
    const authorization = { ...suiteDetails(userId), scope: 'offline_access openid email' };
    const { auth, calls } = fixture({ authorization });
    expect((await openRequest(auth, id, [suite], user.email, 'fixture')).kind).toBe('suite');
    expect(calls).toHaveLength(2);
  });

  it.each([userId, otherUser])('accepts an explicit decision by signed-in user %s', async subject => {
    const { auth, calls } = fixture({ loginId: subject, authorization: suiteDetails(subject) });
    const request = await openRequest(auth, id, [limits, suite], user.email, 'fixture');
    expect(request.kind).toBe('suite');
    expect(request.user.id).toBe(subject);
    expect(calls).toHaveLength(2);
    await decide(auth.oauth, request.authorization_id, request.redirect_uri, 'approve');
    expect(calls.at(-1)?.body).toEqual({ action: 'approve' });
  });

  it('works independently of canary configuration', async () => {
    const { auth } = fixture({ loginId: otherUser, authorization: suiteDetails(otherUser) });
    expect((await openRequest(auth, id, [suite, { ...limits, userDigest: '' }], user.email, 'fixture')).kind).toBe('suite');
    expect(configured({ ...suite, callback: 'http://127.0.0.1:1234/callback' })).toBe(false);
  });

  it('keeps the canary owner check even when the callback is shared', async () => {
    const { auth, calls } = fixture({ loginId: otherUser, authorization: { ...details, user: { ...user, id: otherUser } } });
    await expect(openRequest(auth, id, [suite, limits], user.email, 'fixture')).rejects.toThrow('account authorized');
    expect(calls).toHaveLength(2);
  });

  it.each([
    { ...suiteDetails(userId), user: { id: otherUser } },
    { ...suiteDetails(userId), scope: 'openid profile' },
    { ...suiteDetails(userId), scope: 'openid email offline_access profile' },
    { ...suiteDetails(userId), scope: 'openid email' },
    { ...suiteDetails(userId), scope: 'openid offline_access' },
    { ...suiteDetails(userId), scope: 'openid email email' },
    { ...suiteDetails(userId), redirect_uri: 'https://elsewhere.example/return' },
    { ...suiteDetails(userId), client: { id: otherUser, name: 'Neckardt Apps MCP' } }
  ])('declines mismatched suite requests before consent', async authorization => {
    const { auth, calls } = fixture({ authorization });
    await expect(openRequest(auth, id, [suite, limits], user.email, 'fixture')).rejects.toThrow();
    expect(calls).toHaveLength(2);
  });

  it('rejects an ambiguous client ID and anonymous sign-in', async () => {
    const { auth } = fixture({ authorization: suiteDetails(userId) });
    await expect(openRequest(auth, id, [suite, { ...limits, clientId: suite.clientId }], user.email, 'fixture'))
      .rejects.toThrow('registered');
    const anonymous = fixture({ anonymous: true });
    await expect(openRequest(anonymous.auth, id, [suite], user.email, 'fixture')).rejects.toThrow('Sign in');
    expect(anonymous.calls).toHaveLength(1);
  });
});
