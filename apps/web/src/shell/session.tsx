import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { profileStore, type ProfileStore } from './profile';
import { getSiteClient } from './site-client';
import { readPublicSupabaseConfig, type PublicSupabaseConfig } from './browser-auth.mts';

export interface SessionUser { id: string; email?: string }
export type SessionStatus = 'loading' | 'signed-out' | 'signed-in' | 'unavailable';
export interface SessionApi {
  profiles?: ProfileStore;
  observe(onChange: (user: SessionUser | null) => void, onError?: (error: unknown) => void): () => void;
  signIn(email: string, password: string): Promise<void>;
  signOut(): Promise<void>;
}
export interface SiteSession {
  status: SessionStatus;
  user: SessionUser | null;
  busy: boolean;
  error: string | null;
  /** Whether this observed identity generation is still active, before React rerenders. */
  isCurrent(): boolean;
  signIn(email: string, password: string): Promise<void>;
  signOut(): Promise<void>;
}

const apis = new Map<string, SessionApi>();

// This is a browser session display/transport adapter, never an app access check.
// The existing getter retains the SDK's project-based session key and one client
// per configured origin. No review data or app-specific storage is accessed.
export function makeSiteSessionApi(input: PublicSupabaseConfig | null): SessionApi | null {
  const config = readPublicSupabaseConfig(input);
  if (!config) return null;
  const existing = apis.get(config.url);
  if (existing) return existing;
  try {
    const client = getSiteClient(config);
    const api: SessionApi = {
      profiles: profileStore(client),
      observe(onChange, onError) {
        let active = true;
        let changedSinceInitialization = false;
        const { data } = client.auth.onAuthStateChange((event, session) => {
          if (!active || (event === 'INITIAL_SESSION' && changedSinceInitialization)) return;
          if (event !== 'INITIAL_SESSION') changedSinceInitialization = true;
          const user = session?.user;
          onChange(user ? { id: user.id, ...(user.email ? { email: user.email } : {}) } : null);
        });
        const failedInitialization = (error: unknown) => {
          if (active && !changedSinceInitialization) onError?.(error);
        };
        // The observer (including INITIAL_SESSION) supplies identity. This read
        // only surfaces initialization errors; a stale result never sets a user.
        try {
          void client.auth.getSession().then(({ error }) => {
            if (error) failedInitialization(error);
          }, failedInitialization);
        } catch (error) { failedInitialization(error); }
        return () => { active = false; data.subscription.unsubscribe(); };
      },
      async signIn(email, password) {
        const { error } = await client.auth.signInWithPassword({ email, password });
        if (error) throw new Error('Sign-in failed');
      },
      async signOut() {
        const { error } = await client.auth.signOut({ scope: 'local' });
        if (error) throw new Error('Sign-out failed');
      }
    };
    apis.set(config.url, api);
    return api;
  } catch { return null; }
}

type Snapshot = Pick<SiteSession, 'status' | 'user' | 'busy' | 'error'> & { api: SessionApi | null; identityToken: object | null };
type Runtime = Snapshot & { api: SessionApi; identityToken: object; active: boolean; revision: number };
const initial = (api: SessionApi | null): Snapshot => ({ api, identityToken: null, status: api ? 'loading' : 'unavailable', user: null, busy: false, error: null });
const Context = createContext<SiteSession | null>(null);

export function SessionProvider({ api, children }: { api: SessionApi | null; children: ReactNode }) {
  const [snapshot, setSnapshot] = useState<Snapshot>(() => initial(api));
  const runtime = useRef<Runtime | null>(null);
  const configuredApi = useRef(api);
  configuredApi.current = api;
  useEffect(() => {
    setSnapshot(initial(api));
    if (!api) { runtime.current = null; return; }
    const state: Runtime = { ...initial(api), api, identityToken: {}, active: true, revision: 0 };
    runtime.current = state;
    const publish = () => {
      if (state.active && runtime.current === state) setSnapshot({
        api, identityToken: state.identityToken, status: state.status, user: state.user, busy: state.busy, error: state.error
      });
    };
    let unsubscribe = () => {};
    const unavailable = () => {
      if (!state.active) return;
      state.revision++; state.identityToken = {};
      state.status = 'unavailable'; state.user = null;
      state.error = 'Unable to check your session. Reload to try again.';
      publish();
    };
    try {
      unsubscribe = api.observe(user => {
        if (!state.active) return;
        state.revision++;
        const status = user ? 'signed-in' : 'signed-out';
        if (state.status !== status || state.user?.id !== user?.id) state.identityToken = {};
        state.user = user; state.status = status; state.error = null;
        publish();
      }, unavailable);
    } catch { unavailable(); }
    return () => {
      state.active = false;
      if (runtime.current === state) runtime.current = null;
      try { unsubscribe(); } catch { /* Cleanup must not disrupt public children. */ }
    };
  }, [api]);

  const operate = useCallback(async (action: (client: SessionApi) => Promise<void>, failure: string) => {
    const state = runtime.current;
    if (!state?.active || state.api !== api || state.busy || state.status === 'loading' || state.status === 'unavailable') return;
    const revision = state.revision;
    const publish = () => {
      if (state.active && runtime.current === state) setSnapshot({
        api: state.api, identityToken: state.identityToken, status: state.status, user: state.user, busy: state.busy, error: state.error
      });
    };
    state.busy = true; state.error = null; publish();
    try { await action(state.api); }
    catch {
      // A newer auth event wins over an older request's result or failure.
      if (state.active && runtime.current === state && state.revision === revision) state.error = failure;
    } finally {
      if (state.active && runtime.current === state) { state.busy = false; publish(); }
    }
  }, [api]);
  const signIn = useCallback((email: string, password: string) => operate(client => client.signIn(email, password),
    'Sign-in failed. Check your email and password, then try again.'), [operate]);
  const signOut = useCallback(() => operate(client => client.signOut(), 'Sign-out failed. Please try again.'), [operate]);
  // Do not briefly display the previous project's identity while effects switch.
  const current = snapshot.api === api ? snapshot : initial(api);
  const identityToken = current.identityToken;
  const isCurrent = useCallback(() => {
    const state = runtime.current;
    return !!state?.active && configuredApi.current === api && state.api === api
      && state.status !== 'loading' && state.status !== 'unavailable'
      && identityToken !== null && state.identityToken === identityToken;
  }, [api, identityToken]);
  const value = useMemo<SiteSession>(() => ({ status: current.status, user: current.user, busy: current.busy,
    error: current.error, isCurrent, signIn, signOut }), [current.status, current.user, current.busy, current.error, isCurrent, signIn, signOut]);
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

export function useSiteSession(): SiteSession {
  const value = useContext(Context);
  if (!value) throw new Error('useSiteSession requires a SessionProvider');
  return value;
}
