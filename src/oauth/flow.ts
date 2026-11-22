import type { SupabaseClient } from '@supabase/supabase-js';

export interface ConsentLimits { userId: string; clientId: string; callback: string }
type Auth = Pick<SupabaseClient['auth'], 'signInWithPassword' | 'oauth'>;
type OAuth = Auth['oauth'];
type Action = 'approve' | 'deny';

const uuid = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;

// Supabase Auth generates the public request ID from 20 bytes using lowercase, unpadded base32.
const authorizationId = /^[a-z2-7]{32}$/;

export function readAuthorizationId(search: string) {
  const ids = new URLSearchParams(search).getAll('authorization_id');
  return ids.length === 1 && authorizationId.test(ids[0]) ? ids[0] : null;
}

export function configured(limits: ConsentLimits) {
  if (!uuid.test(limits.userId) || !uuid.test(limits.clientId)) return false;
  const url = URL.parse(limits.callback);
  if (!url) return false;
  const loopback = url.protocol === 'http:' && url.hostname === '127.0.0.1' && !!url.port;
  return (url.protocol === 'https:' || loopback) && !url.username && !url.password &&
    !url.search && !url.hash && url.href === limits.callback;
}

export async function openRequest(auth: Auth, id: string, limits: ConsentLimits, email: string, password: string) {
  if (!authorizationId.test(id) || !configured(limits)) throw new Error('Start a new connection from ChatGPT.');
  const login = await auth.signInWithPassword({ email, password });
  if (login.error || login.data.user?.id !== limits.userId)
    throw new Error('Sign in with the dedicated canary account.');
  const { data, error } = await auth.oauth.getAuthorizationDetails(id);
  if (error || !data) throw new Error('This request has expired or is unavailable. Reconnect from ChatGPT.');
  // Previous consent may return only a redirect. Without client details we cannot verify this request.
  if ('redirect_url' in data) throw new Error('This account has already granted access. Revoke its prior grant and reconnect.');
  if (data.authorization_id !== id || data.user.id !== limits.userId ||
      data.client.id !== limits.clientId || data.redirect_uri !== limits.callback)
    throw new Error('This request does not match the registered canary connection.');
  return data;
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
