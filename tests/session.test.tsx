import { act, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const sdkFactory = vi.hoisted(() => vi.fn());
vi.mock('@supabase/supabase-js', () => ({ createClient: (...args: unknown[]) => sdkFactory(...args) }));
import { makeSiteSessionApi, SessionProvider, useSiteSession, type SessionApi, type SessionUser, type SiteSession } from '../shared/session';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
let sequence = 0;
const config = () => ({ url: `https://${(`fixture${++sequence}`).padEnd(20, 'a')}.supabase.co`, publishableKey: 'sb_publishable_synthetic' });
type AuthCallback = (event: string, session: { user: SessionUser } | null) => void;
function sdk() {
  const callbacks = new Set<AuthCallback>(), history: AuthCallback[] = [];
  const cleanup: ReturnType<typeof vi.fn>[] = [];
  const auth = {
    onAuthStateChange: vi.fn((callback: AuthCallback) => {
      callbacks.add(callback); history.push(callback);
      const unsubscribe = vi.fn(() => { callbacks.delete(callback); });
      cleanup.push(unsubscribe);
      return { data: { subscription: { unsubscribe } } };
    }),
    getSession: vi.fn().mockResolvedValue({ data: { session: null }, error: null }),
    signInWithPassword: vi.fn().mockResolvedValue({ data: { session: null }, error: null }),
    signOut: vi.fn().mockResolvedValue({ error: null })
  };
  return { auth, history, cleanup, callbacks,
    emit(event: string, user: SessionUser | null) { for (const callback of callbacks) callback(event, user ? { user } : null); }
  };
}
function manualApi() {
  let change: (user: SessionUser | null) => void = () => {};
  let fail: (error: unknown) => void = () => {};
  const unsubscribe = vi.fn();
  const api: SessionApi = {
    observe: vi.fn((onChange, onError) => { change = onChange; fail = onError ?? (() => {}); return unsubscribe; }),
    signIn: vi.fn().mockResolvedValue(undefined), signOut: vi.fn().mockResolvedValue(undefined)
  };
  return { api, unsubscribe, emit: (user: SessionUser | null) => change(user), fail: (error: unknown) => fail(error) };
}
const mounted: { root: Root; host: HTMLDivElement; active: boolean }[] = [];
async function mount(api: SessionApi | null, strict = false) {
  const host = document.createElement('div'); document.body.append(host);
  const entry = { root: createRoot(host), host, active: true }; mounted.push(entry);
  let session!: SiteSession;
  function Consumer() {
    session = useSiteSession();
    return <><a href="./">Public launcher</a><output>{session.status}:{session.user?.id ?? 'none'}</output></>;
  }
  async function render(next: SessionApi | null) {
    await act(async () => {
      const content = <SessionProvider api={next}><Consumer /></SessionProvider>;
      entry.root.render(strict ? <StrictMode>{content}</StrictMode> : content);
    });
  }
  await render(api);
  return { host, session: () => session, render, async unmount() {
    if (entry.active) { await act(async () => entry.root.unmount()); entry.active = false; host.remove(); }
  } };
}
let forbiddenFetch: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  sdkFactory.mockReset();
  localStorage.clear();
  forbiddenFetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => { throw Error('Network forbidden in synthetic session tests'); });
});
afterEach(async () => {
  for (const entry of mounted.splice(0)) {
    if (entry.active) await act(async () => entry.root.unmount());
    entry.host.remove();
  }
  expect(forbiddenFetch).not.toHaveBeenCalled();
  vi.restoreAllMocks();
});

describe('shared session adapter', () => {
  it('reuses one project client and its default session key across consumers', async () => {
    const client = sdk(); sdkFactory.mockReturnValue(client);
    const settings = config();
    const first = makeSiteSessionApi(settings)!, second = makeSiteSessionApi({ ...settings })!;
    expect(first).toBe(second);
    expect(sdkFactory).toHaveBeenCalledExactlyOnceWith(settings.url, settings.publishableKey, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false }
    });
    const a = vi.fn(), b = vi.fn();
    const stopA = first.observe(a), stopB = second.observe(b);
    client.emit('INITIAL_SESSION', { id: 'synthetic-user', email: 'fixture@example.invalid' });
    expect(a).toHaveBeenCalledWith({ id: 'synthetic-user', email: 'fixture@example.invalid' });
    expect(b).toHaveBeenCalledWith({ id: 'synthetic-user', email: 'fixture@example.invalid' });
    stopA(); stopB();
    expect(client.callbacks.size).toBe(0);
    expect(client.cleanup.every(cleanup => cleanup.mock.calls.length === 1)).toBe(true);
    makeSiteSessionApi(config());
    expect(sdkFactory).toHaveBeenCalledTimes(2);
  });

  it('leaves public children available without valid config or when client construction fails', async () => {
    expect(makeSiteSessionApi(null)).toBeNull();
    expect(makeSiteSessionApi({ url: 'https://invalid.example', publishableKey: 'secret_invalid' })).toBeNull();
    expect(sdkFactory).not.toHaveBeenCalled();
    sdkFactory.mockImplementation(() => { throw Error('Synthetic blocked browser storage'); });
    const screen = await mount(makeSiteSessionApi(config()));
    expect(screen.session()).toMatchObject({ status: 'unavailable', user: null, busy: false });
    expect(screen.host.querySelector('a')?.textContent).toBe('Public launcher');
    await act(async () => { await screen.session().signIn('fixture@example.invalid', 'synthetic'); await screen.session().signOut(); });
    expect(screen.session().status).toBe('unavailable');
  });

  it('uses only the observer for identity, never a getSession result', async () => {
    const client = sdk();
    client.auth.getSession.mockResolvedValue({ data: { session: { user: { id: 'stale-read' } } }, error: null });
    sdkFactory.mockReturnValue(client);
    const screen = await mount(makeSiteSessionApi(config()));
    expect(screen.session().status).toBe('loading');
    expect(screen.host.querySelector('a')).not.toBeNull();
    await act(async () => client.emit('INITIAL_SESSION', null));
    expect(screen.session()).toMatchObject({ status: 'signed-out', user: null });
    await act(async () => client.emit('SIGNED_IN', { id: 'observed-user' }));
    expect(screen.session()).toMatchObject({ status: 'signed-in', user: { id: 'observed-user' } });
    await act(async () => client.emit('SIGNED_OUT', null));
    expect(screen.session()).toMatchObject({ status: 'signed-out', user: null });
  });

  it('ignores an initial-session callback that arrives after a newer sign-out', async () => {
    const client = sdk(); sdkFactory.mockReturnValue(client);
    const screen = await mount(makeSiteSessionApi(config()));
    await act(async () => client.emit('SIGNED_OUT', null));
    await act(async () => client.emit('INITIAL_SESSION', { id: 'stale-initial-user' }));
    expect(screen.session()).toMatchObject({ status: 'signed-out', user: null, error: null });
    await act(async () => client.emit('SIGNED_IN', { id: 'new-sign-in' }));
    expect(screen.session()).toMatchObject({ status: 'signed-in', user: { id: 'new-sign-in' } });
  });

  it.each(['rejection', 'throw', 'returned error'])('contains initialization %s without hiding public content', async mode => {
    const client = sdk(), error = Error('Synthetic private diagnostic');
    if (mode === 'rejection') client.auth.getSession.mockRejectedValue(error);
    else if (mode === 'throw') client.auth.getSession.mockImplementation(() => { throw error; });
    else client.auth.getSession.mockResolvedValue({ data: { session: null }, error });
    sdkFactory.mockReturnValue(client);
    const screen = await mount(makeSiteSessionApi(config()));
    expect(screen.session()).toMatchObject({ status: 'unavailable', user: null, busy: false });
    expect(screen.session().error).toContain('Unable to check your session');
    expect(screen.session().error).not.toContain('private diagnostic');
    expect(screen.host.querySelector('a')).not.toBeNull();
  });

  it('ignores a late initialization failure after a newer auth event or unsubscription', async () => {
    const client = sdk(), read = deferred<unknown>();
    client.auth.getSession.mockReturnValue(read.promise); sdkFactory.mockReturnValue(client);
    const api = makeSiteSessionApi(config())!;
    const screen = await mount(api);
    await act(async () => client.emit('SIGNED_IN', { id: 'newer-user' }));
    await act(async () => read.reject(Error('Late synthetic failure')));
    expect(screen.session()).toMatchObject({ status: 'signed-in', user: { id: 'newer-user' }, error: null });
    const afterUnmount = deferred<unknown>();
    client.auth.getSession.mockReturnValue(afterUnmount.promise);
    const observer = vi.fn(), onError = vi.fn();
    const stop = api.observe(observer, onError); stop();
    await act(async () => afterUnmount.reject(Error('Already unsubscribed')));
    expect(onError).not.toHaveBeenCalled();
    expect(observer).not.toHaveBeenCalled();
  });

  it('passes credentials to the SDK but does not trust the request result as session state', async () => {
    const client = sdk(); sdkFactory.mockReturnValue(client);
    client.auth.signInWithPassword.mockResolvedValue({ data: { session: { user: { id: 'response-only-user' } } }, error: null });
    const screen = await mount(makeSiteSessionApi(config()));
    await act(async () => screen.session().signIn('fixture@example.invalid', 'too-early'));
    expect(client.auth.signInWithPassword).not.toHaveBeenCalled();
    await act(async () => client.emit('INITIAL_SESSION', null));
    await act(async () => screen.session().signIn('fixture@example.invalid', 'synthetic-password'));
    expect(client.auth.signInWithPassword).toHaveBeenCalledExactlyOnceWith({ email: 'fixture@example.invalid', password: 'synthetic-password' });
    expect(screen.session()).toMatchObject({ status: 'signed-out', user: null, busy: false });
    client.auth.signInWithPassword.mockResolvedValue({ data: { session: null }, error: Error('Synthetic sensitive diagnostic') });
    await act(async () => screen.session().signIn('fixture@example.invalid', 'synthetic-password'));
    expect(screen.session().error).toMatch(/^Sign-in failed/);
    expect(screen.session().error).not.toContain('sensitive');
  });

  it('uses local sign-out and preserves unrelated review and browser storage', async () => {
    const client = sdk(), settings = config();
    sdkFactory.mockReturnValue(client);
    const authKey = 'sb-synthetic-project-auth-token';
    localStorage.setItem(authKey, 'synthetic-session');
    localStorage.setItem('recall.round.v2.synthetic', 'synthetic-pending-response');
    localStorage.setItem('unrelated.preference', 'retained');
    const clear = vi.spyOn(Storage.prototype, 'clear');
    const remove = vi.spyOn(Storage.prototype, 'removeItem');
    client.auth.signOut.mockImplementation(async () => {
      localStorage.removeItem(authKey);
      client.emit('SIGNED_OUT', null);
      return { error: Error('Best-effort remote revocation failed after local sign-out') };
    });
    const screen = await mount(makeSiteSessionApi(settings));
    await act(async () => client.emit('INITIAL_SESSION', { id: 'synthetic-user' }));
    await act(async () => screen.session().signOut());
    expect(client.auth.signOut).toHaveBeenCalledExactlyOnceWith({ scope: 'local' });
    expect(screen.session()).toMatchObject({ status: 'signed-out', user: null, error: null, busy: false });
    expect(localStorage.getItem('recall.round.v2.synthetic')).toBe('synthetic-pending-response');
    expect(localStorage.getItem('unrelated.preference')).toBe('retained');
    expect(remove).toHaveBeenCalledExactlyOnceWith(authKey);
    expect(clear).not.toHaveBeenCalled();
  });
});

describe('SessionProvider lifecycle and operations', () => {
  it('does not infer signed-in identity from a completed sign-in request', async () => {
    const mock = manualApi(), request = deferred<void>();
    vi.mocked(mock.api.signIn).mockReturnValue(request.promise);
    const screen = await mount(mock.api);
    await act(async () => mock.emit(null));
    let pending!: Promise<void>;
    await act(async () => {
      pending = screen.session().signIn('fixture@example.invalid', 'synthetic-password');
      void screen.session().signIn('fixture@example.invalid', 'duplicate');
    });
    expect(mock.api.signIn).toHaveBeenCalledExactlyOnceWith('fixture@example.invalid', 'synthetic-password');
    expect(screen.session()).toMatchObject({ busy: true, status: 'signed-out', user: null });
    await act(async () => { request.resolve(); await pending; });
    expect(screen.session()).toMatchObject({ busy: false, status: 'signed-out', user: null });
    await act(async () => mock.emit({ id: 'observed', email: 'fixture@example.invalid' }));
    expect(screen.session()).toMatchObject({ status: 'signed-in', user: { id: 'observed' } });
    await act(async () => screen.session().signOut());
    expect(screen.session()).toMatchObject({ status: 'signed-in', user: { id: 'observed' }, busy: false });
  });

  it('reports sanitized sign-in and sign-out failures while retaining observed identity', async () => {
    const mock = manualApi();
    vi.mocked(mock.api.signIn).mockRejectedValue(Error('Private server diagnostic'));
    vi.mocked(mock.api.signOut).mockRejectedValue(Error('Private server diagnostic'));
    const screen = await mount(mock.api);
    await act(async () => mock.emit(null));
    await act(async () => screen.session().signIn('fixture@example.invalid', 'synthetic-password'));
    expect(screen.session()).toMatchObject({ status: 'signed-out', busy: false });
    expect(screen.session().error).toMatch(/^Sign-in failed/);
    expect(screen.session().error).not.toContain('Private');
    await act(async () => mock.emit({ id: 'still-observed' }));
    await act(async () => screen.session().signOut());
    expect(screen.session()).toMatchObject({ status: 'signed-in', user: { id: 'still-observed' }, busy: false });
    expect(screen.session().error).toMatch(/^Sign-out failed/);
  });

  it('does not overwrite a newer auth change with an older operation failure', async () => {
    const mock = manualApi(), request = deferred<void>();
    vi.mocked(mock.api.signIn).mockReturnValue(request.promise);
    const screen = await mount(mock.api);
    await act(async () => mock.emit(null));
    let pending!: Promise<void>;
    await act(async () => { pending = screen.session().signIn('fixture@example.invalid', 'synthetic'); });
    await act(async () => mock.emit({ id: 'newer-session' }));
    await act(async () => { request.reject(Error('Stale sign-in failure')); await pending; });
    expect(screen.session()).toMatchObject({ status: 'signed-in', user: { id: 'newer-session' }, error: null, busy: false });
  });

  it('unsubscribes and rejects stale callbacks/results when the configured API changes', async () => {
    const first = manualApi(), second = manualApi(), request = deferred<void>();
    vi.mocked(first.api.signIn).mockReturnValue(request.promise);
    const screen = await mount(first.api);
    await act(async () => first.emit(null));
    let pending!: Promise<void>;
    await act(async () => { pending = screen.session().signIn('fixture@example.invalid', 'synthetic'); });
    await screen.render(second.api);
    expect(first.unsubscribe).toHaveBeenCalledTimes(1);
    expect(screen.session()).toMatchObject({ status: 'loading', user: null, busy: false });
    await act(async () => { second.emit({ id: 'second-project-user' }); first.emit({ id: 'stale-first-project' }); request.reject(Error('Stale first-project failure')); await pending; });
    expect(screen.session()).toMatchObject({ status: 'signed-in', user: { id: 'second-project-user' }, error: null, busy: false });
    await screen.render(null);
    expect(second.unsubscribe).toHaveBeenCalledTimes(1);
    expect(screen.session()).toMatchObject({ status: 'unavailable', user: null });
    expect(screen.host.querySelector('a')).not.toBeNull();
  });

  it('cleans up StrictMode subscriptions and ignores callbacks after unmount', async () => {
    const client = sdk(); sdkFactory.mockReturnValue(client);
    const screen = await mount(makeSiteSessionApi(config()), true);
    expect(client.auth.onAuthStateChange).toHaveBeenCalledTimes(2);
    expect(client.cleanup[0]).toHaveBeenCalledTimes(1);
    expect(client.callbacks.size).toBe(1);
    await act(async () => client.history[0]('SIGNED_IN', { user: { id: 'stale-strict-mount' } }));
    expect(screen.session().status).toBe('loading');
    await act(async () => client.emit('INITIAL_SESSION', null));
    expect(screen.session().status).toBe('signed-out');
    await screen.unmount();
    expect(client.callbacks.size).toBe(0);
    expect(client.cleanup.every(cleanup => cleanup.mock.calls.length === 1)).toBe(true);
    await act(async () => client.history.at(-1)!('SIGNED_IN', { user: { id: 'after-unmount' } }));
    expect(screen.host.textContent).toBe('');
  });

  it('contains observer and cleanup failures, and settles operations after unmount', async () => {
    const broken = manualApi();
    vi.mocked(broken.api.observe).mockImplementation(() => { throw Error('Synthetic subscription failure'); });
    const screen = await mount(broken.api);
    expect(screen.session().status).toBe('unavailable');
    expect(screen.host.querySelector('a')).not.toBeNull();
    const mock = manualApi(), request = deferred<void>();
    vi.mocked(mock.api.signOut).mockReturnValue(request.promise);
    mock.unsubscribe.mockImplementation(() => { throw Error('Synthetic cleanup failure'); });
    await screen.render(mock.api);
    await act(async () => mock.emit({ id: 'synthetic-user' }));
    let pending!: Promise<void>;
    await act(async () => { pending = screen.session().signOut(); });
    await screen.unmount();
    await act(async () => { request.reject(Error('Late failure')); await pending; });
    expect(mock.unsubscribe).toHaveBeenCalledTimes(1);
    expect(screen.host.textContent).toBe('');
  });
});
