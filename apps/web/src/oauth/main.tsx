import { useRef, useState, type FormEvent } from 'react';
import { createRoot } from 'react-dom/client';
import { createClient } from '@supabase/supabase-js';
import type { PublicSupabaseConfig } from '../shell/browser-auth.mts';
import { configured, decide, openRequest, readAuthorizationId, type Connection } from './flow';
import { brokerFlow, type BrokerReview } from './broker';
import '../shell/shell.css';
import './consent.css';

declare const __SITE_PUBLIC_CONFIG__: PublicSupabaseConfig;
const connections: Connection[] = [
  {
    kind: 'suite',
    clientId: import.meta.env.VITE_SUITE_CLIENT_ID ?? '',
    callback: import.meta.env.VITE_SUITE_CALLBACK_URL ?? ''
  },
  {
    kind: 'canary',
    clientId: import.meta.env.VITE_CANARY_CLIENT_ID ?? '',
    userDigest: import.meta.env.VITE_CANARY_USER_DIGEST ?? '',
    callback: import.meta.env.VITE_CANARY_CALLBACK_URL ?? ''
  }
];
// Consent has its own in-memory session and never replaces the site's normal Account session.
const auth = createClient(__SITE_PUBLIC_CONFIG__.url, __SITE_PUBLIC_CONFIG__.publishableKey, {
  auth: { storageKey: 'neckardt-apps-oauth-consent', persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }
}).auth;
const id = readAuthorizationId(location.search);
const broker = brokerFlow(location.search, __SITE_PUBLIC_CONFIG__.url);

function Consent() {
  const [request, setRequest] = useState<Awaited<ReturnType<typeof openRequest>> | BrokerReview | null>(null);
  const [message, setMessage] = useState('');
  const [done, setDone] = useState('');
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

  function signIn(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const fields = new FormData(form);
    form.reset();
    void run(async () => {
      const email = String(fields.get('email')), password = String(fields.get('password'));
      setRequest(broker ? await broker.review(auth, email, password) : await openRequest(auth, id!, connections, email, password));
    });
  }

  async function respond(action: 'approve' | 'deny') {
    if (!request) return;
    // Require a fresh request after an ambiguous response rather than submitting the decision twice.
    setRequest(null);
    if (request.kind === 'broker' || request.kind === 'disconnect') {
      const returnTo = await broker!.decide(auth, action, request);
      if (returnTo) window.location.replace(returnTo);
      else setDone(action === 'approve' ? request.client.name + ' disconnected.' : 'Disconnection cancelled.');
    } else if ('authorization_id' in request) {
      window.location.replace(await decide(auth.oauth, request.authorization_id, request.redirect_uri, action));
    }
  }

  if (window.top !== window.self) return <p>Open Neckardt Apps in its own browser window to review this request.</p>;
  if (done) return <p role="status">{done}</p>;
  const disconnect = request?.kind === 'disconnect';
  return <section className="consent">
    <h1>{disconnect ? 'Disconnect ' + request.client.name + '?' : request ? 'Allow access?' : 'Connect to Neckardt Apps'}</h1>
    {!id && !broker ? <p>Start the connection in the requesting app to review its request.</p>
      : !broker && !connections.some(configured) ? <p>OAuth connections have not been configured.</p>
      : request ? <>
        <p>{disconnect ? <>Disconnect this app for <strong>{request.user.email}</strong>?</> :
          <><strong>{request.client.name}</strong> is requesting access as {request.user.email}.</>}</p>
        {!disconnect && <dl>
          <dt>Requested permissions</dt>
          <dd>
            {request.kind === 'broker' && <>
              Get the link to Habit Practice.
              {request.scope.split(' ').includes('habit:events') && <p>Allow this ChatGPT connection to subscribe to new round counts. A detailed subscription also shares card names, prompts, answers, grades and due dates.</p>}
              {request.scope.split(' ').includes('offline_access') && <p>Refresh this connection for up to 30 days. You can disconnect it earlier.</p>}
            </>}
            {request.kind === 'suite' ? 'Identify your account and get the link to Habit Practice. You can subscribe in your Dot chat to receive counts from new rounds. If you also enable card details, that chat receives the card names, prompts, answers, grades and due dates until you unsubscribe.' : request.kind === 'canary' && request.scope}
            {request.kind === 'suite' && request.scope !== 'openid' &&
              <p>ChatGPT can read your email address and its verification status, and refresh this connection while you’re away.</p>}
          </dd>
          <dt>Return address</dt><dd>{request.redirect_uri}</dd>
        </dl>}
        <div className="decisions">
          <button type="button" disabled={busy} onClick={() => void run(() => respond('deny'))}>{disconnect ? 'Cancel' : 'Deny'}</button>
          <button className="primary" type="button" disabled={busy} onClick={() => void run(() => respond('approve'))}>{disconnect ? 'Disconnect' : 'Allow'}</button>
        </div>
      </> : <form className="account-form" onSubmit={signIn}>
        <p>Sign in with your Neckardt Apps account to review the request.</p>
        <label>Email<input name="email" type="email" autoComplete="username" required disabled={busy}/></label>
        <label>Password<input name="password" type="password" autoComplete="current-password" required disabled={busy}/></label>
        <button className="account-action" disabled={busy}>{busy ? 'Please wait…' : 'Continue'}</button>
      </form>}
    {message && <p className="account-error" role="alert">{message}</p>}
  </section>;
}
createRoot(document.getElementById('root')!).render(<Consent/>);
