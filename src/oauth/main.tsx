import { useRef, useState, type FormEvent } from 'react';
import { createRoot } from 'react-dom/client';
import { createClient } from '@supabase/supabase-js';
import type { PublicSupabaseConfig } from '../../shared/browser-auth.mts';
import { configured, decide, openRequest, uuid, type ConsentLimits } from './flow';
import '../../shared/shell.css';
import './consent.css';

declare const __SITE_PUBLIC_CONFIG__: PublicSupabaseConfig;
const limits: ConsentLimits = {
  clientId: import.meta.env.VITE_CANARY_CLIENT_ID ?? '',
  userId: import.meta.env.VITE_CANARY_USER_ID ?? '',
  callback: import.meta.env.VITE_CANARY_CALLBACK_URL ?? ''
};
// The test identity has its own in-memory session and never replaces the site's normal Account session.
const auth = createClient(__SITE_PUBLIC_CONFIG__.url, __SITE_PUBLIC_CONFIG__.publishableKey, {
  auth: { storageKey: 'recall-canary-consent', persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }
}).auth;
const ids = new URLSearchParams(location.search).getAll('authorization_id');
const id = ids.length === 1 && uuid.test(ids[0]) ? ids[0] : null;

function Consent() {
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

  function signIn(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const fields = new FormData(form);
    form.reset();
    void run(async () => {
      setRequest(await openRequest(auth, id!, limits, String(fields.get('email')), String(fields.get('password'))));
    });
  }

  async function respond(action: 'approve' | 'deny') {
    if (!request) return;
    // Require a fresh request after an ambiguous response rather than submitting the decision twice.
    setRequest(null);
    const returnTo = await decide(auth.oauth, request.authorization_id, limits.callback, action);
    window.location.replace(returnTo);
  }

  return <section className="consent">
    <h1>{request ? 'Allow access?' : 'Connect Recall canary'}</h1>
    {!id ? <p>Start the connection from ChatGPT to review its request.</p>
      : !configured(limits) ? <p>This canary connection has not been configured.</p>
      : request ? <>
        <p><strong>{request.client.name}</strong> is requesting access as {request.user.email}.</p>
        <dl>
          <dt>Requested permissions</dt><dd>{request.scope.trim() || 'No scopes requested'}</dd>
          <dt>Return address</dt><dd>{request.redirect_uri}</dd>
        </dl>
        <div className="decisions">
          <button type="button" disabled={busy} onClick={() => void run(() => respond('deny'))}>Deny</button>
          <button className="primary" type="button" disabled={busy} onClick={() => void run(() => respond('approve'))}>Allow</button>
        </div>
      </> : <form className="account-form" onSubmit={signIn}>
        <p>Sign in with the dedicated canary account to review this request.</p>
        <label>Email<input name="email" type="email" autoComplete="username" required disabled={busy}/></label>
        <label>Password<input name="password" type="password" autoComplete="current-password" required disabled={busy}/></label>
        <button className="account-action" disabled={busy}>{busy ? 'Please wait…' : 'Continue'}</button>
      </form>}
    {message && <p className="account-error" role="alert">{message}</p>}
  </section>;
}
createRoot(document.getElementById('root')!).render(<Consent/>);
