import type { SupabaseClient } from '@supabase/supabase-js';

type Auth = SupabaseClient['auth'];
export type BrokerReview = {
  kind: 'broker' | 'disconnect'; client: { name: string }; user: { email?: string };
  scope: string; redirect_uri: string;
};

export function brokerFlow(search: string, projectUrl: string) {
  const query = new URLSearchParams(search);
  if (query.has('authorization_id') || query.has('decision') ||
      new Set(query.keys()).size !== query.size) return null;
  const disconnect = query.has('disconnect');
  if (disconnect && query.size !== 1) return null;
  const id = query.get(disconnect ? 'disconnect' : 'client_id');
  if (id !== 'neckardt-muse' && id !== 'neckardt-chatgpt') return null;
  const params = disconnect ? new URLSearchParams({ client_id:id }) : query;
  const endpoint = new URL('/functions/v1/neckardt-apps-mcp/oauth/consent', projectUrl).href;

  async function send(auth: Auth, decision: string) {
    const session = (await auth.getSession()).data.session;
    if (!session) throw Error('Sign in again to review this connection.');
    const body = new URLSearchParams(params);
    body.set('decision', decision);
    const res = await fetch(endpoint, { method:'POST', body, redirect:'error', credentials:'omit',
      cache:'no-store', referrerPolicy:'no-referrer', headers:{ Authorization:'Bearer ' + session.access_token } });
    if (!res.ok) throw Error('This account or request does not match the registered connection. Start again in the requesting app.');
    return res.json();
  }
  async function review(auth: Auth, email:string, password:string): Promise<BrokerReview> {
    const login = await auth.signInWithPassword({ email, password });
    if (login.error || !login.data.session || !login.data.user || login.data.user.is_anonymous)
      throw Error('Sign in with your Neckardt Apps account.');
    const info = await send(auth, disconnect ? 'review_disconnect' : 'review');
    if (info.name !== (id === 'neckardt-muse' ? 'Muse' : 'ChatGPT') ||
        (!disconnect && (typeof info.scope !== 'string' || info.redirect_uri !== params.get('redirect_uri'))))
      throw Error('The connection details could not be verified.');
    return { kind:disconnect ? 'disconnect' : 'broker', client:{ name:info.name }, user:{ email:login.data.user.email },
      scope:info.scope ?? '', redirect_uri:info.redirect_uri ?? '' };
  }
  async function decide(auth: Auth, action:'approve'|'deny', request:BrokerReview) {
    if (disconnect) {
      if (action === 'approve' && (await send(auth, 'disconnect')).disconnected !== true) throw Error('Could not confirm disconnection.');
      return null;
    }
    const data = await send(auth, action);
    const dest = typeof data.redirect_uri === 'string' && URL.parse(data.redirect_uri);
    if (!dest || dest.protocol !== 'https:' || dest.username || dest.password || dest.hash ||
        dest.origin + dest.pathname !== request.redirect_uri || dest.searchParams.size !== 3 ||
        dest.searchParams.get('state') !== params.get('state') ||
        dest.searchParams.get('iss') !== 'https://apps.neckardt.com/mcp.json' ||
        (action === 'approve' ? !/^nmc_c_[A-Za-z0-9_-]{43}$/.test(dest.searchParams.get('code') ?? '') :
          dest.searchParams.get('error') !== 'access_denied')) throw Error('The return address could not be verified.');
    return dest.href;
  }
  return { review, decide };
}
