import { useRef, useState, type FormEvent } from 'react';
import { createRoot } from 'react-dom/client';
import type { Database } from '@neckardt/backend/database';
import { createClient, type OAuthGrant } from '@supabase/supabase-js';
import type { PublicSupabaseConfig } from '../shell/browser-auth.mts';
import { clientPolicy, decide, openRequest, readAuthorizationId, signIn } from './flow';
import '../shell/shell.css';
import './consent.css';

declare const __SITE_PUBLIC_CONFIG__: PublicSupabaseConfig;
const canary = {
  clientId: import.meta.env.VITE_CANARY_CLIENT_ID ?? '',
  userDigest: import.meta.env.VITE_CANARY_USER_DIGEST ?? '',
  callback: import.meta.env.VITE_CANARY_CALLBACK_URL ?? ''
};
// Consent has its own in-memory session and never replaces the site's normal Account session.
const client = createClient<Database>(__SITE_PUBLIC_CONFIG__.url, __SITE_PUBLIC_CONFIG__.publishableKey, {
  auth: { storageKey: 'neckardt-apps-oauth-consent', persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }
});
const id = readAuthorizationId(location.search);

const manage = location.search === '?manage';

function Consent() {
  const [grants, setGrants] = useState<OAuthGrant[] | null>(null);
  const [request, setRequest] = useState<Awaited<ReturnType<typeof openRequest>> | null>(null);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);

  async function run(action: () => Promise<void>) {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setMessage('');
    try { await action(); }
    catch (error) { setMessage(error instanceof Error ? error.message : 'Connection failed. Try again.'); }
    finally { pending.current = false; setBusy(false); }
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const fields = new FormData(form);
    form.reset();
    void run(async () => {
      const email = String(fields.get('email')), password = String(fields.get('password'));
      if (manage) {
        const user = await signIn(client.auth, email, password);
        const { data, error } = await client.auth.oauth.listGrants();
        if (error) throw new Error('Could not load your connections. Try again.');
        setGrants(await Promise.all(data.map(async grant => {
          const { data: policy, error } = await clientPolicy(client, grant.client.id, user.id, 'openid');
          if (error) throw new Error('Could not load the connection names. Try again.');
          return policy ? { ...grant, client: { ...grant.client, name: policy.display_name } } : grant;
        })));
      } else {
        setRequest(await openRequest(client, id!, canary, email, password));
      }
    });
  }

  async function respond(action: 'approve' | 'deny') {
    if (!request) return;
    // Require a fresh request after an ambiguous response rather than submitting the decision twice.
    setRequest(null);
    const returnTo = await decide(client.auth.oauth, request.authorization_id, request.redirect_uri, action);
    window.location.replace(returnTo);
  }

  return <section className="consent">
    <h1>{manage ? 'Manage connections' : request ? 'Allow access?' : 'Connect to Neckardt Apps'}</h1>
    {grants ? <>
      {grants.length === 0 && <p>You have no connected apps.</p>}
      {grants.map(grant => <div key={grant.client.id}>
        <strong>{grant.client.name}</strong>
        <p>Connected {new Date(grant.granted_at).toLocaleDateString()}.</p>
        <button className="account-action" type="button" disabled={busy} onClick={() => void run(async () => {
          const { error } = await client.auth.oauth.revokeGrant({ clientId: grant.client.id });
          if (error) throw new Error('Could not confirm the disconnect. Reload to check your connections.');
          setGrants(grants.filter(item => item.client.id !== grant.client.id));
        })}>Disconnect {grant.client.name}</button>
      </div>)}
      <p>If you use Habit Practice notifications, unsubscribe in the receiving chat to stop those deliveries.</p>
      <p>Disconnecting stops future token refreshes for that app. Its current MCP access token works until it expires.</p>
    </> : !id && !manage ? <p>Start a connection from the app you want to connect.</p>
      : request ? <>
        <p><strong>{request.name}</strong> is requesting access as {request.user.email}.</p>
        <dl>
          <dt>Requested permissions</dt>
          <dd>
            {request.kind === 'suite' ? <>
              <p>{request.name} can get the link to Habit Practice.</p>
              {request.subscriptions && <p>You can subscribe in your chat to receive counts from new rounds. If you enable card details, that chat receives card names, prompts, answers, grades and due dates until you unsubscribe.</p>}
              <p>{request.name} can also read your Supabase account profile, including your email and any profile details saved there.</p>
              {request.scope.split(' ').includes('email') && <p>The identity grant includes your email address and its verification status.</p>}
              <p>The app can refresh this connection until you disconnect it.</p>
            </> : request.scope}
          </dd>
          <dt>Return address</dt><dd>{request.redirect_uri}</dd>
        </dl>
        <div className="decisions">
          <button type="button" disabled={busy} onClick={() => void run(() => respond('deny'))}>Deny</button>
          <button className="primary" type="button" disabled={busy} onClick={() => void run(() => respond('approve'))}>Allow</button>
        </div>
      </> : <form className="account-form" onSubmit={submit}>
        <p>Sign in with your Neckardt Apps account to {manage ? 'manage your connections' : 'review the request'}.</p>
        <label>Email<input name="email" type="email" autoComplete="username" required disabled={busy}/></label>
        <label>Password<input name="password" type="password" autoComplete="current-password" required disabled={busy}/></label>
        <button className="account-action" disabled={busy}>{busy ? 'Please wait…' : 'Continue'}</button>
      </form>}
    {!manage && <p><a href="?manage">Manage connections</a></p>}
    {message && <p className="account-error" role="alert">{message}</p>}
  </section>;
}
createRoot(document.getElementById('root')!).render(window.self === window.top
  ? <Consent/>
  : <p>Open Neckardt Apps in its own tab to manage or approve connections.</p>);
