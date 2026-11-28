import { createClient } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';
import type { Database } from '@neckardt/backend/database';
import { openRequest, decide, ownerDigest, readAuthorizationId } from '../src/oauth/flow';

const userId = '11111111-1111-4111-8111-111111111111';
const clientId = '22222222-2222-4222-8222-222222222222';
const id = 'jp5ugn7b3fsj6wmgveqvbni7ynxl7yag';
const callback = 'https://chat.example/return';
const scope = 'openid';
const userDigest = '30ffc7cc343265aa0f8bf7c138b8d3d8752630a527e66c95eafbe261f1c48d06';
const limits = { userDigest, clientId, callback };
const user = { id: userId, email: 'canary@example.test' };
const details = { authorization_id: id, user, client: { id: clientId, name: 'Recall canary' }, scope, redirect_uri: callback };
const endpoint = '/auth/v1/oauth/authorizations/' + id;

function fixture(options: { loginId?: string; anonymous?: boolean; authorization?: unknown; redirect?: string; policy?: { display_name: string; callback_url: string; subscriptions: boolean } | null } = {}) {
  const calls: { path: string; body: Record<string, unknown> }[] = [];
  // Exercise the pinned SDK against the same HTTP contract the hosted server uses.
  const client = createClient<Database>('https://abcdefghijklmnopqrst.supabase.co', 'sb_publishable_fixture', {
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
      if (url.pathname === '/rest/v1/rpc/neckardt_mcp_client') {
        return Response.json(options.policy ? [options.policy] : []);
      }
      if (url.pathname === endpoint && init?.method === 'GET') return Response.json(options.authorization ?? details);
      if (url.pathname === endpoint + '/consent' && init?.method === 'POST') {
        return Response.json({ redirect_url: options.redirect ?? callback + '?state=fake&code=fixture' });
      }
      throw new Error('Unexpected synthetic request');
    } }
  });
  return { client, calls };
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
      const { client, calls } = fixture();
      expect(readAuthorizationId(new URLSearchParams({ authorization_id: invalid }).toString())).toBeNull();
      await expect(openRequest(client, invalid, limits, user.email, 'fixture')).rejects.toThrow('Start a new connection');
      expect(calls).toEqual([]);
    }
  );
  it.each(['approve', 'deny'] as const)('submits %s only after an explicit decision', async action => {
    const { client, calls } = fixture();
    const info = await openRequest(client, id, limits, user.email, 'fixture');
    expect(info.scope).toBe(scope);
    expect(calls.map(c => c.path)).toEqual(['/auth/v1/token?grant_type=password', endpoint]);
    expect(await decide(client.auth.oauth, id, callback, action)).toBe(callback + '?state=fake&code=fixture');
    expect(calls.at(-1)).toEqual({ path: endpoint + '/consent', body: { action } });
  });
  it.each(['openid email offline_access', 'openid email', 'profile', ''])('refuses consent for unsupported scopes', async scope => {
    const { client, calls } = fixture({ authorization: { ...details, scope } });
    await expect(openRequest(client, id, limits, user.email, 'fixture')).rejects.toThrow('openid');
    expect(calls.map(call => call.path)).toEqual(['/auth/v1/token?grant_type=password', endpoint]);
  });
  it('refuses another signed-in user after identifying the canary', async () => {
    const { client, calls } = fixture({ loginId: clientId, authorization: { ...details, user: { ...user, id: clientId } } });
    await expect(openRequest(client, id, limits, user.email, 'fixture')).rejects.toThrow('account authorized');
    expect(calls).toHaveLength(2);
  });
  it('refuses a different configured canary owner digest', async () => {
    const { client, calls } = fixture();
    await expect(openRequest(client, id, { ...limits, userDigest: '0'.repeat(64) }, user.email, 'fixture'))
      .rejects.toThrow('account authorized');
    expect(calls).toHaveLength(2);
  });
  it.each(['', userId, userDigest.toUpperCase()])('rejects an absent or invalid canary digest', async invalid => {
    const { client, calls } = fixture();
    await expect(openRequest(client, id, { ...limits, userDigest: invalid }, user.email, 'fixture'))
      .rejects.toThrow('account authorized');
    expect(calls).toHaveLength(2);
  });
  it.each([
    { ...details, client: { ...details.client, id: userId } },
    { ...details, user: { ...user, id: clientId } },
    { ...details, authorization_id: 'a' + id.slice(1) },
    { ...details, redirect_uri: callback + '-other' },
    { redirect_url: callback + '?code=fixture' }
  ])('refuses mismatched or unverifiable details', async authorization => {
    const { client, calls } = fixture({ authorization });
    await expect(openRequest(client, id, limits, user.email, 'fixture')).rejects.toThrow();
    expect(calls.some(call => call.path.endsWith('/consent'))).toBe(false);
  });
  it('accepts only the registered loopback pilot URL and supports a later HTTPS callback', async () => {
    const pilot = 'http://127.0.0.1:45381/callback';
    const request = { ...details, redirect_uri: pilot };
    const { client } = fixture({ authorization: request, redirect: pilot + '?code=fixture' });
    await openRequest(client, id, { ...limits, callback: pilot }, user.email, 'fixture');
    expect(await decide(client.auth.oauth, id, pilot, 'approve')).toBe(pilot + '?code=fixture');
    for (const unsafe of ['http://chat.example/callback', 'http://127.0.0.1.example:45381/callback']) {
      const bad = fixture({ authorization: { ...details, redirect_uri: unsafe } });
      await expect(openRequest(bad.client, id, { ...limits, callback: unsafe }, user.email, 'fixture')).rejects.toThrow('registered');
    }
    const differentPort = { ...limits, callback: 'http://127.0.0.1:45382/callback' };
    await expect(openRequest(client, id, differentPort, user.email, 'fixture')).rejects.toThrow('registered');
  });
  it('rejects a response redirect outside the registered callback', async () => {
    const { client } = fixture({ redirect: 'https://chat.example.invalid/return?code=fake' });
    await openRequest(client, id, limits, user.email, 'fixture');
    await expect(decide(client.auth.oauth, id, callback, 'approve')).rejects.toThrow('return address');
  });

});

const suiteId = '33333333-3333-4333-8333-333333333333';
const suite = { ...details, client: { id: suiteId, name: 'Provider registration' } };
const policy = { display_name: 'Approved integration', callback_url: callback, subscriptions: false };

describe('suite authorization', () => {
  it('uses the signed-in identity, provider client ID and requested scope to load policy', async () => {
    const { client, calls } = fixture({ authorization: suite, policy });
    const request = await openRequest(client, id, limits, user.email, 'fixture');
    expect(request.name).toBe(policy.display_name);
    expect(request.subscriptions).toBe(false);
    expect(calls.at(-1)).toEqual({ path: '/rest/v1/rpc/neckardt_mcp_client',
      body: { requested_user: userId, requested_client: suiteId, requested_scope: scope } });
    await decide(client.auth.oauth, id, callback, 'approve');
    expect(calls.at(-1)?.body).toEqual({ action: 'approve' });
  });

  it.each([null, { ...policy, callback_url: callback + '-other' }, { ...policy, callback_url: 'http://chat.example/return' }])(
    'declines an unavailable binding or a mismatched callback', async binding => {
      const { client, calls } = fixture({ authorization: suite, policy: binding });
      await expect(openRequest(client, id, limits, user.email, 'fixture')).rejects.toThrow('registered');
      expect(calls.some(call => call.path.endsWith('/consent'))).toBe(false);
    }
  );

  it('rejects anonymous sign-in before requesting authorization details', async () => {
    const { client, calls } = fixture({ anonymous: true });
    await expect(openRequest(client, id, limits, user.email, 'fixture')).rejects.toThrow('Sign in');
    expect(calls).toHaveLength(1);
  });
});
