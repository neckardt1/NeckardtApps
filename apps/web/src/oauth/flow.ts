import type { SupabaseClient } from '@supabase/supabase-js';

export type Connection = { clientId: string; callback: string } & (
  | { kind: 'suite' }
  | { kind: 'canary'; userDigest: string }
);
type Auth = Pick<SupabaseClient['auth'], 'signInWithPassword' | 'oauth'>;
type OAuth = Auth['oauth'];
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

export function configured(limits: Connection) {
  if (!uuid.test(limits.clientId) || (limits.kind === 'canary' && !sha256Hex.test(limits.userDigest))) return false;
  const url = URL.parse(limits.callback);
  if (!url) return false;
  const loopback = limits.kind === 'canary' && url.protocol === 'http:' && url.hostname === '127.0.0.1' && !!url.port;
  return (url.protocol === 'https:' || loopback) && !url.username && !url.password &&
    !url.search && !url.hash && url.href === limits.callback;
}

export async function openRequest(auth: Auth, id: string, connections: readonly Connection[], email: string, password: string) {
  if (!authorizationId.test(id) || !connections.some(configured)) throw new Error('Start a new connection from ChatGPT.');
  const login = await auth.signInWithPassword({ email, password });
  const user = login.data.user;
  if (login.error || !user || !uuid.test(user.id) || user.is_anonymous)
    throw new Error('Sign in with your Neckardt Apps account.');
  const { data, error } = await auth.oauth.getAuthorizationDetails(id);
  if (error || !data) throw new Error('This request has expired or is unavailable. Reconnect from ChatGPT.');
  // Previous consent may return only a redirect. Without client details we cannot verify this request.
  if ('redirect_url' in data) throw new Error('This account has already granted access. Revoke its prior grant and reconnect.');
  // Both ChatGPT clients may use the same callback. Select the policy by the ID supplied by Supabase.
  const matches = connections.filter(connection => connection.clientId === data.client.id);
  const connection = matches[0];
  if (matches.length !== 1 || !configured(connection) || data.redirect_uri !== connection.callback ||
      data.authorization_id !== id || data.user.id !== user.id)
    throw new Error('This request does not match a registered connection.');
  if (connection.kind === 'canary' && await ownerDigest(user.id) !== connection.userDigest)
    throw new Error('Sign in with the account authorized for the Recall canary.');
  if (data.scope !== 'openid') throw new Error('This connection supports only the openid scope.');
  return { ...data, kind: connection.kind };
}

export async function decide(oauth: OAuth, id: string, callback: string, action: Action) {
  const options = { skipBrowserRedirect: true };
  const { data, error } = action === 'approve'
    ? await oauth.approveAuthorization(id, options)
    : await oauth.denyAuthorization(id, options);
  if (error || !data) throw new Error('Could not confirm the decision. Reconnect from ChatGPT.');
  const dest = URL.parse(data.redirect_url);
  if (!dest || dest.hash || dest.username || dest.password || dest.origin + dest.pathname !== callback)
    throw new Error('The return address does not match the registered callback.');
  return dest.href;
}
