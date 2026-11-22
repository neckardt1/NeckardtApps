// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PublicSupabaseConfig } from '../shared/browser-auth.mts';
import type { SessionUser } from '../shared/session';

const sdkFactory = vi.hoisted(() => vi.fn());
vi.mock('@supabase/supabase-js', () => ({ createClient: (...args: unknown[]) => sdkFactory(...args) }));

const config: PublicSupabaseConfig = {
  url: 'https://abcdefghijklmnopqrst.supabase.co', publishableKey: 'sb_publishable_synthetic'
};
const expectedOptions = { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false } };
const syntheticUser = { id: 'synthetic-user', email: 'fixture@example.invalid' };
type Callback = (event: string, session: { user: SessionUser } | null) => void;

// This fake models only the SDK's default project storage convention. It does
// not claim to exercise Supabase network authentication or browser tab events.
function syntheticSdk(url: string, storage: Map<string, string>) {
  const storageKey = `sb-${new URL(url).hostname.split('.')[0]}-auth-token`;
  const callbacks = new Set<Callback>();
  const storedUser = () => {
    const stored = storage.get(storageKey);
    return stored ? JSON.parse(stored) as SessionUser : null;
  };
  const emit = (event: string, user: SessionUser | null) => {
    for (const callback of callbacks) callback(event, user ? { user } : null);
  };
  const auth = {
    onAuthStateChange: vi.fn((callback: Callback) => {
      callbacks.add(callback);
      const user = storedUser();
      callback('INITIAL_SESSION', user ? { user } : null);
      return { data: { subscription: { unsubscribe: vi.fn(() => callbacks.delete(callback)) } } };
    }),
    getSession: vi.fn(async () => ({ data: { session: storedUser() ? { user: storedUser() } : null }, error: null })),
    signInWithPassword: vi.fn(async () => {
      storage.set(storageKey, JSON.stringify(syntheticUser)); emit('SIGNED_IN', syntheticUser);
      return { data: { session: { user: syntheticUser } }, error: null };
    }),
    signOut: vi.fn(async () => {
      storage.delete(storageKey); emit('SIGNED_OUT', null);
      return { error: null };
    })
  };
  return { auth, storageKey, callbacks,
    rpc: vi.fn().mockResolvedValue({ data: [], error: null }),
    functions: { invoke: vi.fn() }
  };
}
async function pageModules() {
  const [client, session, feature] = await Promise.all([
    import('../shared/site-client'), import('../shared/session'), import('../apps/recall/src/recall-api')
  ]);
  return { ...client, ...session, ...feature };
}
let forbiddenFetch: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  vi.resetModules(); sdkFactory.mockReset();
  forbiddenFetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => { throw Error('Network forbidden in shared-client tests'); });
});
afterEach(() => {
  expect(forbiddenFetch).not.toHaveBeenCalled(); vi.restoreAllMocks();
});

describe('shell and feature client integration', () => {
  it.each(['session-first', 'feature-first'] as const)('shares one configured project SDK client (%s)', async order => {
    const client = syntheticSdk(config.url, new Map()); sdkFactory.mockReturnValue(client);
    const page = await pageModules();
    if (order === 'session-first') page.makeSiteSessionApi(config);
    else page.makeRecallApi(config);
    const session = page.makeSiteSessionApi({ ...config })!;
    const feature = page.makeRecallApi({ ...config });
    expect(page.getSiteClient(config)).toBe(client);
    expect(sdkFactory).toHaveBeenCalledExactlyOnceWith(config.url, config.publishableKey, expectedOptions);
    expect(feature).not.toHaveProperty('observeOwner');
    expect(feature).not.toHaveProperty('signIn');
    expect(feature).not.toHaveProperty('signOut');
    const observed = vi.fn(); const stop = session.observe(observed);
    await session.signIn('fixture@example.invalid', 'synthetic-password');
    await expect(feature.due()).resolves.toEqual([]);
    expect(observed).toHaveBeenLastCalledWith(syntheticUser);
    expect(client.auth.onAuthStateChange).toHaveBeenCalledTimes(1);
    expect(client.rpc).toHaveBeenCalledExactlyOnceWith('recall_due', { p_limit: 100 });
    stop(); expect(client.callbacks.size).toBe(0);
  });

  it('keeps shared authenticated identity separate from feature backend access', async () => {
    const client = syntheticSdk(config.url, new Map()); sdkFactory.mockReturnValue(client);
    client.rpc.mockResolvedValue({ data: null, error: { code: '42501' } });
    const page = await pageModules();
    const session = page.makeSiteSessionApi(config)!; const feature = page.makeRecallApi(config);
    const observed = vi.fn(); const stop = session.observe(observed);
    await session.signIn('fixture@example.invalid', 'synthetic-password');
    expect(observed).toHaveBeenLastCalledWith(syntheticUser);
    await expect(feature.due()).rejects.toMatchObject({ status: 403, message: 'Unable to load due cards' });
    expect(observed).toHaveBeenLastCalledWith(syntheticUser);
    expect(client.auth.signOut).not.toHaveBeenCalled();
    expect(client.functions.invoke).not.toHaveBeenCalled();
    // Only the synthetic backend response changes access; no identity shortcut.
    client.rpc.mockResolvedValue({ data: [{ card_id: 'synthetic-card', front: 'Front', back: 'Back', revision: 0 }], error: null });
    await expect(feature.due()).resolves.toHaveLength(1);
    stop();
  });

  it('retains the project session convention across independent page module instances', async () => {
    const storage = new Map<string, string>([['recall:synthetic-owner:pending', 'synthetic-pending-review']]);
    const clients: ReturnType<typeof syntheticSdk>[] = [];
    sdkFactory.mockImplementation((url: string) => {
      const client = syntheticSdk(url, storage); clients.push(client); return client;
    });
    const launcherPage = await pageModules();
    const launcherSession = launcherPage.makeSiteSessionApi(config)!;
    const launcherObserved = vi.fn(); const stopLauncher = launcherSession.observe(launcherObserved);
    await launcherSession.signIn('fixture@example.invalid', 'synthetic-password');
    expect(storage.has('sb-abcdefghijklmnopqrst-auth-token')).toBe(true);
    // A second page has its own module graph and client, while persistent
    // session storage belongs to the same project, not an application path.
    vi.resetModules();
    const practicePage = await pageModules();
    const practiceSession = practicePage.makeSiteSessionApi(config)!;
    const feature = practicePage.makeRecallApi(config);
    const practiceObserved = vi.fn(); const stopPractice = practiceSession.observe(practiceObserved);
    expect(practiceObserved).toHaveBeenLastCalledWith(syntheticUser);
    expect(clients).toHaveLength(2); expect(clients[0]).not.toBe(clients[1]);
    expect(practicePage.getSiteClient(config)).toBe(clients[1]);
    expect(clients[0].storageKey).toBe(clients[1].storageKey);
    expect(sdkFactory.mock.calls).toEqual([
      [config.url, config.publishableKey, expectedOptions],
      [config.url, config.publishableKey, expectedOptions]
    ]);
    await feature.due();
    expect(clients[0].rpc).not.toHaveBeenCalled(); expect(clients[1].rpc).toHaveBeenCalledTimes(1);
    await practiceSession.signOut();
    expect(practiceObserved).toHaveBeenLastCalledWith(null);
    expect(clients[1].auth.signOut).toHaveBeenCalledExactlyOnceWith({ scope: 'local' });
    expect(storage.has(clients[1].storageKey)).toBe(false);
    expect(storage.get('recall:synthetic-owner:pending')).toBe('synthetic-pending-review');
    stopLauncher(); stopPractice();
  });

  it('keeps separate projects on separate clients and default session keys', async () => {
    const storage = new Map<string, string>();
    sdkFactory.mockImplementation((url: string) => syntheticSdk(url, storage));
    const page = await pageModules();
    const firstSession = page.makeSiteSessionApi(config)!;
    const secondConfig = { ...config, url: 'https://tsrqponmlkjihgfedcba.supabase.co' };
    const secondSession = page.makeSiteSessionApi(secondConfig)!;
    const observed = vi.fn(); const stop = secondSession.observe(observed);
    await firstSession.signIn('fixture@example.invalid', 'synthetic-password');
    expect(observed).toHaveBeenLastCalledWith(null);
    expect(page.getSiteClient(config)).not.toBe(page.getSiteClient(secondConfig));
    expect(sdkFactory).toHaveBeenCalledTimes(2);
    expect([...storage.keys()]).toEqual(['sb-abcdefghijklmnopqrst-auth-token']);
    stop();
  });
});
