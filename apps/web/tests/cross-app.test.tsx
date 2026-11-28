import { act, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { SiteRoot } from '../src/shell/SiteRoot.tsx';
import type { SessionApi, SessionUser } from '../src/shell/session.tsx';
import { BrowserRouter } from 'react-router';
import { PracticeDeck } from '../src/apps/habit-practice/PracticeDeck.tsx';
import type { RecallApi } from '../src/apps/habit-practice/recall-api.ts';
import type { DueCard, ReviewEvent } from '../src/apps/habit-practice/review-session.ts';
import type { Lock, Round } from '../src/apps/habit-practice/durable-session.ts';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const origin = 'https://cross-app.synthetic.invalid';
const firstOwner = { id: 'synthetic-owner-a', email: 'first@example.invalid' };
const otherOwner = { id: 'synthetic-owner-b', email: 'second@example.invalid' };
const storageKey = (owner: string) => `recall.round.v2.${origin}.${owner}`;
const stored = (owner = firstOwner.id): Round | null => JSON.parse(localStorage.getItem(storageKey(owner)) ?? 'null');
const cards = (owner: string, count = 2): DueCard[] => Array.from({ length: count }, (_, index) => ({
  card_id: `${owner}-card-${index + 1}`, front: `${owner} question ${index + 1}`,
  back: `${owner} answer ${index + 1}`, revision: 7
}));

let root: Root | null, host: HTMLDivElement;
let forbiddenFetch: ReturnType<typeof vi.spyOn>;
let releaseRequests: Array<() => void>;
const locks = new Map<string, Promise<unknown>>();
const lock: Lock = (name, run) => {
  const next = (locks.get(name) ?? Promise.resolve()).catch(() => {}).then(run);
  locks.set(name, next);
  return next;
};
function deferred<T>(cleanupValue: T) {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  releaseRequests.push(() => resolve(cleanupValue));
  return { promise, resolve };
}
const button = (label: string) => [...host.querySelectorAll('button')].find(el => el.textContent?.trim() === label);
async function tap(label: string) {
  const target = button(label);
  expect(target, `button ${label}`).toBeDefined();
  await act(async () => target!.click());
}
async function openProfile() {
  await act(async () => host.querySelector<HTMLAnchorElement>('.account-link')!.click());
  expect(host.querySelector('h1')?.textContent).toBe('Profile');
}
async function press(key: string, target: EventTarget = document.activeElement ?? document) {
  await act(async () => { target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })); });
}
async function signIn(user: SessionUser) {
  const form = host.querySelector<HTMLFormElement>('.account-form');
  expect(form).not.toBeNull();
  form!.querySelector<HTMLInputElement>('input[name="email"]')!.value = user.email!;
  form!.querySelector<HTMLInputElement>('input[name="password"]')!.value = 'synthetic-password';
  await act(async () => { form!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
}

function session(initial: SessionUser | null = firstOwner) {
  let current = initial;
  const listeners = new Set<(user: SessionUser | null) => void>();
  function emit(user: SessionUser | null) { current = user; for (const listener of listeners) listener(user); }
  const api: SessionApi = {
    observe(onChange) { listeners.add(onChange); onChange(current); return () => { listeners.delete(onChange); }; },
    signIn: vi.fn(async (email: string) => { emit(email === otherOwner.email ? otherOwner : firstOwner); }),
    signOut: vi.fn(async () => { emit(null); })
  };
  return { api, listeners, emit, current: () => current };
}
type Send = { owner: string | null; event: ReviewEvent };
function fixture({ count = 2, send, due }: {
  count?: number;
  send?: (request: Send, attempt: number) => Promise<void>;
  due?: (owner: string) => Promise<DueCard[]>;
} = {}) {
  const auth = session();
  const calls: Send[] = [];
  const persisted = new Map<string, ReviewEvent>();
  const api: RecallApi = {
    origin,
    roundPreview: async () => ({ due_reviews: count, check_ins: 0, next_review_at: null }),
    due: vi.fn(async () => {
      const owner = auth.current()?.id;
      if (!owner) throw Error('Synthetic signed-out read');
      return due ? due(owner) : cards(owner, count);
    }),
    grade: vi.fn(async (event: ReviewEvent) => {
      const request = { owner: auth.current()?.id ?? null, event: { ...event } };
      calls.push(request);
      if (!request.owner) throw Error('Synthetic signed-out write');
      await send?.(request, calls.length);
      persisted.set(`${request.owner}:${event.review_id}`, { ...event });
    })
  };
  return { auth, api, calls, persisted };
}
async function mount(page: 'launcher' | 'recall', auth: SessionApi, api: RecallApi, base = '/') {
  if (root) await act(async () => root!.unmount());
  window.history.replaceState(null, '', `${base}${page === 'recall' ? 'recall/' : 'apps/'}`);
  root = createRoot(host);
  await act(async () => root!.render(<StrictMode>
    <BrowserRouter basename={base}><SiteRoot api={auth} practice={<PracticeDeck api={api} />} /></BrowserRouter>
  </StrictMode>));
}
async function follow(page: 'launcher' | 'recall', base = '/') {
  const link = page === 'launcher'
    ? [...host.querySelectorAll<HTMLAnchorElement>('a')].find(el => el.textContent?.trim() === 'All apps')
    : host.querySelector<HTMLAnchorElement>('main a.app-tile');
  expect(link).toBeDefined();
  expect(link).not.toBeNull();
  expect(new URL(link!.href).pathname).toBe(`${base}${page === 'recall' ? 'recall/' : 'apps/'}`);
  await act(async () => link!.click());
  expect(window.location.pathname).toBe(new URL(link!.href).pathname);
}

beforeEach(() => {
  root = null; releaseRequests = []; locks.clear(); localStorage.clear();
  host = document.createElement('div'); document.body.append(host);
  Object.defineProperty(navigator, 'locks', { configurable: true, value: { request: lock } });
  vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
  forbiddenFetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => { throw Error('Network forbidden in synthetic cross-app tests'); });
});
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  await act(async () => { releaseRequests.forEach(resolve => resolve()); });
  host.remove();
  expect(forbiddenFetch).not.toHaveBeenCalled();
  vi.restoreAllMocks();
});

test.each(['/', '/NeckardtApps/'])('launcher navigation preserves exact revealed card and original pending grade under %s', async base => {
  const hold = deferred<void>(undefined);
  const f = fixture({ send: async (_request, attempt) => { if (attempt === 1) await hold.promise; } });
  await mount('recall', f.auth.api, f.api, base);
  expect(f.api.due).not.toHaveBeenCalled();
  await tap('Start round');
  expect(f.auth.listeners.size).toBe(1);
  await tap('Reveal answer'); await tap('Good'); await tap('Reveal answer');
  const before = stored()!;
  expect(before).toMatchObject({ cardIndex: 1, revealed: true, finished: false });
  expect(before.saves).toHaveLength(1);
  expect(before.saves[0].status).toBe('pending');
  expect(f.calls).toHaveLength(1);
  await tap('Apps'); await follow('launcher', base);
  expect(host.textContent).toContain('All apps');
  expect(host.textContent).not.toContain(firstOwner.id);
  expect(stored()).toEqual(before);
  await follow('recall', base);
  expect(stored()).toEqual(before);
  await tap('Continue round');
  expect(f.auth.listeners.size).toBe(1);
  expect(button('Resume review')).toBeUndefined();

  expect(host.textContent).toContain(`${firstOwner.id} question 2`);
  expect(host.textContent).toContain(`${firstOwner.id} answer 2`);
  expect(host.textContent).not.toContain(`${firstOwner.id} question 1`);
  expect(stored()?.saves[0]).toEqual(before.saves[0]);
  await act(async () => hold.resolve());
  expect(f.calls).toHaveLength(2);
  expect(f.calls[1]).toEqual(f.calls[0]);
  expect(f.persisted.size).toBe(1);
  expect(stored()?.saves[0].status).toBe('saved');
  expect(stored()?.revealed).toBe(true);
});

test('Profile sign-out preserves pending review, isolates another owner, and restores the original owner', async () => {
  const hold = deferred<void>(undefined);
  const f = fixture({ send: async (_request, attempt) => { if (attempt === 1) await hold.promise; } });
  await mount('recall', f.auth.api, f.api);
  await tap('Start round');
  await tap('Reveal answer'); await tap('Hard'); await tap('Reveal answer');
  const original = stored()!;
  await tap('Apps'); await follow('launcher');
  expect(button('Sign out')).toBeUndefined();
  await openProfile(); await tap('Sign out');
  expect(f.auth.api.signOut).toHaveBeenCalledTimes(1);
  expect(f.auth.current()).toBeNull();
  expect(host.querySelector('form')).not.toBeNull();
  expect(host.textContent).not.toContain(firstOwner.id);
  expect(stored()).toEqual(original);
  await act(async () => { hold.resolve(); window.dispatchEvent(new Event('online')); });
  expect(f.calls).toHaveLength(1);
  expect(stored()).toEqual(original);

  await signIn(otherOwner);
  await tap('Apps'); await follow('launcher');
  await follow('recall');
  await tap('Start round');
  expect(button('Resume review')).toBeUndefined();
  await tap('Reveal answer');
  expect(host.textContent).toContain(`${otherOwner.id} answer 1`);
  expect(host.textContent).not.toContain(firstOwner.id);
  expect(f.calls).toHaveLength(1);
  expect(stored()).toEqual(original);
  await tap('Good');
  expect(f.calls[1].owner).toBe(otherOwner.id);
  expect(f.calls[1].event.card_id).toBe(`${otherOwner.id}-card-1`);
  const otherRound = stored(otherOwner.id)!;

  await openProfile(); await tap('Sign out');
  expect(host.textContent).not.toContain(otherOwner.id);
  expect(host.textContent).not.toContain(firstOwner.id);
  expect(stored()).toEqual(original);
  await signIn(firstOwner);
  await tap('Apps'); await follow('launcher'); await follow('recall');
  await tap('Continue round');

  expect(host.textContent).toContain(`${firstOwner.id} answer 2`);
  expect(host.textContent).not.toContain(otherOwner.id);
  expect(stored(otherOwner.id)).toEqual(otherRound);
  expect(f.calls.filter(call => call.event.card_id === original.cards[0].card_id)).toEqual([f.calls[0], f.calls[0]]);
  expect(f.calls.every(call => call.owner !== null && call.event.card_id.startsWith(call.owner))).toBe(true);
});

test('the Apps popover suppresses all grade shortcuts and Escape returns focus to Apps', async () => {
  const f = fixture();
  await mount('recall', f.auth.api, f.api);
  await tap('Start round');
  expect(host.querySelectorAll('header')).toHaveLength(1);
  await tap('Reveal answer');
  const before = stored();
  const trigger = button('Apps')!;
  await tap('Apps');
  const popover = host.querySelector<HTMLElement>('[role="dialog"][aria-label="Apps"]')!;
  expect(popover).not.toBeNull();
  expect(popover.contains(document.activeElement)).toBe(true);
  for (const value of ['1', '2', '3', '4', ' ', 'Enter']) await press(value);
  // Suppression follows popover state, including document-targeted shortcuts.
  await press('3', document);
  expect(f.calls).toHaveLength(0);
  expect(stored()).toEqual(before);
  await press('Escape');
  expect(host.querySelector('[data-popover-open]')).toBeNull();
  expect(document.activeElement).toBe(trigger);
  await press('3', document);
  expect(f.calls).toHaveLength(1);
  expect(f.calls[0].event.grade).toBe('medium');
  expect(host.textContent).toContain(`${firstOwner.id} question 2`);
});

test('unverified final save survives navigation, retries one original event, and finishes automatically after acknowledgement', async () => {
  const hold = deferred<void>(undefined);
  const remotelySaved = new Set<string>();
  const f = fixture({ count: 1, send: async ({ event }, attempt) => {
    remotelySaved.add(event.review_id);
    if (attempt === 1) { await hold.promise; throw Error('Synthetic response lost after save'); }
  } });
  await mount('recall', f.auth.api, f.api);
  await tap('Start round');
  await tap('Reveal answer'); await tap('Again');
  expect(button('Finish')).toBeUndefined();
  expect(stored()?.finished).toBe(false);
  await act(async () => hold.resolve());
  expect(stored()?.saves[0].status).toBe('failed');
  expect(button('Finish')).toBeUndefined();
  await tap('Apps'); await follow('launcher');
  await follow('recall');
  await tap('Continue round');
  expect(stored()?.finished).toBe(false);
  expect(button('Finish')).toBeUndefined();
  await tap('Retry save');
  expect(f.calls).toHaveLength(2);
  expect(f.calls[1]).toEqual(f.calls[0]);
  expect(remotelySaved.size).toBe(1);
  expect(host.textContent).toContain('Saved.');
  expect(stored()?.finished).toBe(true);
  await tap('Apps'); await follow('launcher');
  await follow('recall');
  await tap('Start round');
  expect(host.textContent).toContain(firstOwner.id + ' question 1');
  expect(button('Resume review')).toBeUndefined();
  expect(f.calls).toHaveLength(2);
});

test('a late due response after account replacement cannot seed or display the previous owner’s review', async () => {
  const oldCards = deferred<DueCard[]>(cards(firstOwner.id));
  const f = fixture({ due: owner => owner === firstOwner.id ? oldCards.promise : Promise.resolve(cards(owner)) });
  await mount('recall', f.auth.api, f.api);
  await tap('Start round');
  await openProfile(); await tap('Sign out');
  await signIn(otherOwner);
  await tap('Apps'); await follow('launcher'); await follow('recall');
  await tap('Start round');
  await act(async () => oldCards.resolve(cards(firstOwner.id)));
  await tap('Reveal answer');
  expect(host.textContent).toContain(`${otherOwner.id} answer 1`);
  expect(host.textContent).not.toContain(firstOwner.id);
  expect(stored()).toBeNull();
  expect(stored(otherOwner.id)?.cards.every(card => card.card_id.startsWith(otherOwner.id))).toBe(true);
  expect(f.calls).toHaveLength(0);
});

test.each([null, otherOwner])('a synchronous auth change to %s stops a pending drain before React commits', async nextOwner => {
  const hold = deferred<void>(undefined);
  const f = fixture({ send: async (_request, attempt) => { if (attempt === 1) await hold.promise; } });
  await mount('recall', f.auth.api, f.api);
  await tap('Start round');
  await tap('Reveal answer'); await tap('Good');
  await tap('Reveal answer'); await tap('Hard');
  const original = stored()!;
  expect(original.saves).toHaveLength(2);
  expect(original.saves.every(save => save.status === 'pending')).toBe(true);
  expect(f.calls).toHaveLength(1);
  const pendingDrain = locks.get(storageKey(firstOwner.id) + '.network');
  expect(pendingDrain).toBeDefined();
  // The SDK identity changes synchronously. The acknowledgement may settle
  // before React processes the provider update and cleans up App's effects.
  await act(async () => {
    f.auth.emit(nextOwner);
    hold.resolve();
    await pendingDrain;
  });
  expect(f.calls).toHaveLength(1);
  expect(host.textContent).not.toContain(firstOwner.id);
  expect(stored()?.finished).toBe(false);
  expect(stored()?.saves[1]).toEqual(original.saves[1]);
  if (nextOwner) {
    expect(button('Start round')).toBeDefined();
    expect(stored(otherOwner.id)).toBeNull();
  } else expect(stored(otherOwner.id)).toBeNull();
});

test('a queued reveal cannot advance or replace the next owner’s screen', async () => {
  const gate = deferred<void>(undefined);
  let holdNextMutation = false;
  const controlledLock: Lock = (name, run) => lock(name, async () => {
    if (name === storageKey(firstOwner.id) && holdNextMutation) {
      holdNextMutation = false;
      await gate.promise;
    }
    return run();
  });
  Object.defineProperty(navigator, 'locks', { configurable: true, value: { request: controlledLock } });
  const f = fixture();
  await mount('recall', f.auth.api, f.api);
  await tap('Start round');
  const before = stored();
  const callCount = f.calls.length;
  holdNextMutation = true;
  await tap('Reveal answer');
  expect(button('← Practice home')?.disabled).toBe(true);
  const pendingReveal = locks.get(storageKey(firstOwner.id));
  expect(pendingReveal).toBeDefined();
  await act(async () => {
    f.auth.emit(otherOwner);
    gate.resolve();
    await pendingReveal;
    await Promise.resolve();
  });
  expect(button('Start review')).toBeUndefined();
  expect(host.textContent).not.toContain(firstOwner.id);
  expect(button('Start round')).toBeDefined();
  await tap('Start round');
  expect(host.textContent).toContain(`${otherOwner.id} question 1`);
  expect(stored()).toEqual(before);
  expect(stored(otherOwner.id)).toMatchObject({ started: false, cardIndex: 0, revealed: false });
  expect(f.calls).toHaveLength(callCount);
});

test('an A to B to A auth change invalidates the old drain and replays original records only in the new A generation', async () => {
  const hold = deferred<void>(undefined);
  const f = fixture({ send: async (_request, attempt) => { if (attempt === 1) await hold.promise; } });
  await mount('recall', f.auth.api, f.api);
  await tap('Start round');
  await tap('Reveal answer'); await tap('Good');
  await tap('Reveal answer'); await tap('Easy');
  const before = stored()!;
  const pendingDrain = locks.get(storageKey(firstOwner.id) + '.network');
  expect(pendingDrain).toBeDefined();
  await act(async () => {
    f.auth.emit(otherOwner);
    f.auth.emit(firstOwner);
    hold.resolve();
    await pendingDrain;
    // Same owner ID is insufficient: the old observation was invalidated
    // between these emissions and cannot continue sending before a remount.
    expect(f.calls).toHaveLength(1);
    expect(stored()?.saves[1].status).toBe('pending');
  });
  expect(f.calls).toHaveLength(3);
  expect(f.calls.map(call => call.event)).toEqual([before.saves[0].event, before.saves[0].event, before.saves[1].event]);
  expect(f.calls.every(call => call.owner === firstOwner.id)).toBe(true);
  expect(f.persisted.size).toBe(2);
  expect(stored(otherOwner.id)).toBeNull();
  expect(stored()?.saves.every(save => save.status === 'saved')).toBe(true);
  expect(stored()?.finished).toBe(true);
  expect(host.textContent).toContain('Saved.');
});

test('the card browser drops a late catalog when the identity changes away and back', async () => {
  const f = fixture();
  const card = { card_id: 'sample', front: 'Old catalog', back: 'answer', active: true, kind: 'fact', due_at: '2026-11-28', cue_card_id: null, check_in_available: false };
  const pending = deferred([card]);
  const browse = vi.fn<NonNullable<RecallApi['browse']>>()
    .mockReturnValue(pending.promise);
  await mount('recall', f.auth.api, { ...f.api, browse });
  await tap('Browse all cards →');
  const firstLoad = browse.mock.calls.at(-1)!;
  const initialLoads = browse.mock.calls.length;
  browse.mockResolvedValue([{ ...card, front: 'Current catalog' }]);
  await act(async () => {
    f.auth.emit(otherOwner);
    f.auth.emit(firstOwner);
    expect(firstLoad[1]()).toBe(false);
    pending.resolve([card]);
  });
  expect(browse).toHaveBeenCalledTimes(initialLoads + 1);
  expect(firstLoad[0].aborted).toBe(true);
  expect(host.textContent).toContain('Current catalog');
  expect(host.textContent).not.toContain('Old catalog');
});
