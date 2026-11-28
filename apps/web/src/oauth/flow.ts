import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@neckardt/backend/database';

export type Canary = { clientId: string; callback: string; userDigest: string };
type Client = SupabaseClient<Database>;
type OAuth = Client['auth']['oauth'];
type Action = 'approve' | 'deny';

const uuid = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
export const sha256Hex = /^[0-9a-f]{64}$/;

export async function ownerDigest(userId: string) {
  if (!uuid.test(userId)) throw new Error('Invalid account identifier.');
  const input = new TextEncoder().encode('neckardtapps:recall-consent:owner:v1:' + userId.toLowerCase());
  const digest = await crypto.subtle.digest('SHA-256', input);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

// Supabase Auth generates the public request ID from 20 bytes using lowercase, unpadded base32.
const authorizationId = /^[a-z2-7]{32}$/;
export function readAuthorizationId(search: string) {
  const ids = new URLSearchParams(search).getAll('authorization_id');
  return ids.length === 1 && authorizationId.test(ids[0]) ? ids[0] : null;
}

function validCallback(callback: string, allowLoopback = false) {
  const url = URL.parse(callback);
  if (!url) return false;
  const loopback = allowLoopback && url.protocol === 'http:' && url.hostname === '127.0.0.1' && !!url.port;
  return (url.protocol === 'https:' || loopback) && !url.username && !url.password &&
    !url.search && !url.hash && url.href === callback;
}

export async function signIn(auth: Client['auth'], email: string, password: string) {
  const { data, error } = await auth.signInWithPassword({ email, password });
  if (error || !data.user || !uuid.test(data.user.id) || data.user.is_anonymous)
    throw new Error('Sign in with your Neckardt Apps account.');
  return data.user;
}

export function clientPolicy(client: Client, id: string, user: string, scope: string) {
  return client.rpc('neckardt_mcp_client', {
    requested_client: id, requested_user: user, requested_scope: scope
  }).maybeSingle();
}

export async function openRequest(client: Client, id: string, canary: Canary, email: string, password: string) {
  if (!authorizationId.test(id)) throw new Error('Start a new connection from your integration.');
  const user = await signIn(client.auth, email, password);
  const { data, error } = await client.auth.oauth.getAuthorizationDetails(id);
  if (error || !data) throw new Error('This request has expired or is unavailable. Start a new connection.');
  // Previous consent returns just a code redirect, without the client ID needed to verify its destination.
  if ('redirect_url' in data) throw new Error('You already granted access. Disconnect that app in Manage connections, then reconnect.');
  const mismatch = 'This request does not match a registered connection.';
  if (data.authorization_id !== id || data.user.id !== user.id || !uuid.test(data.client.id)) throw new Error(mismatch);
  if (data.client.id === canary.clientId) {
    if (!validCallback(canary.callback, true) || data.redirect_uri !== canary.callback) throw new Error(mismatch);
    if (!sha256Hex.test(canary.userDigest) || await ownerDigest(user.id) !== canary.userDigest)
      throw new Error('Sign in with the account authorized for the Recall canary.');
    if (data.scope !== 'openid') throw new Error('This connection supports only the openid scope.');
    return { ...data, kind: 'canary' as const, name: data.client.name, subscriptions: false };
  }
  const { data: policy, error: lookupError } = await clientPolicy(client, data.client.id, user.id, data.scope);
  if (lookupError) throw new Error('Could not load the connection settings. Start a new connection to try again.');
  if (!policy || !validCallback(policy.callback_url) || policy.callback_url !== data.redirect_uri) throw new Error(mismatch);
  return { ...data, kind: 'suite' as const, name: policy.display_name, subscriptions: policy.subscriptions };
}

export async function decide(oauth: OAuth, id: string, callback: string, action: Action) {
  const options = { skipBrowserRedirect: true };
  const { data, error } = action === 'approve'
    ? await oauth.approveAuthorization(id, options)
    : await oauth.denyAuthorization(id, options);
  if (error || !data) throw new Error('Could not confirm the decision. Start a new connection.');
  const dest = URL.parse(data.redirect_url);
  if (!dest || dest.hash || dest.username || dest.password || dest.origin + dest.pathname !== callback)
    throw new Error('The return address does not match the registered callback.');
  return dest.href;
}
