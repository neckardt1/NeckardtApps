import { StrictMode, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { ReviewFixture, makeSessionFixture } from './site-fixture.tsx';
import { FormattedText } from '../../src/apps/habit-practice/FormattedText.tsx';
import { makeDurableSession, type Lock } from '../../src/apps/habit-practice/durable-session.ts';
import { MissingRoundRpc, RecallApiError, type RoundItem, type RecallApi, type Opportunity, type ActionEvent } from '../../src/apps/habit-practice/recall-api.ts';
import type { DueCard, ReviewEvent } from '../../src/apps/habit-practice/review-session.ts';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root, target: HTMLElement;
let session: ReturnType<typeof makeSessionFixture>;
const locks = new Map<string, Promise<unknown>>();
const lock: Lock = (name, run) => {
  const result = (locks.get(name) ?? Promise.resolve()).catch(() => {}).then(run);
  locks.set(name, result);
  return result;
};
beforeEach(() => {
  localStorage.clear(); locks.clear(); session = makeSessionFixture();
  Object.defineProperty(navigator, 'locks', { configurable: true, value: { request: lock } });
  vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
  target = document.createElement('div'); document.body.append(target); root = createRoot(target);
});
afterEach(async () => { await act(async () => root.unmount()); target.remove(); vi.restoreAllMocks(); });
const cards = (): DueCard[] => ['A', 'B', 'C'].map(id => ({ card_id: id, front: `Question ${id}`, back: `Answer ${id}`, revision: 0 }));
const opportunities = (): Opportunity[] => [{ opportunity_id: 'occasion', card_id: 'habit', revision: 0, prompt: 'Did you take a short walk without a reminder?', cue: 'After lunch today' }];
const button = (label: string) => [...target.querySelectorAll('button')].find(el => el.textContent === label);
const tap = async (label: string) => { const el = button(label); expect(el, label).toBeDefined(); await act(async () => el!.click()); };
const key = async (value: string) => { await act(async () => document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: value, bubbles: true }))); };
const deferred = <T,>() => { let finish!: (v: T) => void; const promise = new Promise<T>(r => { finish = r; }); return { promise, finish }; };
function api(overrides: Partial<RecallApi> = {}): RecallApi {
  return { origin: 'https://fixture.invalid', async due() { return cards(); }, async grade() {}, ...overrides };
}
async function remount(client: RecallApi) {
  await act(async () => root.unmount()); root = createRoot(target);
  await act(async () => root.render(<ReviewFixture sessionApi={session.api} api={client} />));
}

test.each(['signed-out', 'loading', 'unavailable'] as const)('shared %s session keeps navigation public without loading review data', async status => {
  session.emit(null);
  const due = vi.fn(async () => cards()); const client = api({ due });
  const sessionApi = status === 'unavailable' ? null : status === 'loading'
    ? { ...session.api, observe: () => () => {} } : session.api;
  await act(async () => root.render(<ReviewFixture sessionApi={sessionApi} api={client} />));
  expect(due).not.toHaveBeenCalled();
  expect(target.querySelectorAll('main')).toHaveLength(1);
  expect(target.querySelectorAll('.topbar')).toHaveLength(1);
  expect(target.querySelector('.habit-practice form')).toBeNull();
  expect(target.textContent).not.toContain('Question A');
  expect(button('Account')).toBeDefined();
  await tap('Apps');
  expect(target.querySelector('a[href="/"]')).not.toBeNull();
  await key('Escape');
  if (status === 'signed-out') {
    expect(target.textContent).toContain('Open Account to sign in');
    expect(button('Sign in')).toBeUndefined();
    await tap('Account');
    expect(target.querySelectorAll('form')).toHaveLength(1);
    expect(button('Sign in')).toBeDefined();
  }
});

test('exact revealed card resumes while an earlier original grade is pending; finish requires explicit tap', async () => {
  const hold = deferred<void>(); const calls: ReviewEvent[] = []; const saved = new Set<string>();
  const client = api({ async grade(event) { calls.push(event); if (calls.length === 1) await hold.promise; saved.add(event.review_id); } });
  await act(async () => root.render(<StrictMode><ReviewFixture sessionApi={session.api} api={client} /></StrictMode>));
  expect(target.textContent).toContain('Today');
  expect(target.textContent).not.toContain('Question A');
  await tap('Start review'); expect(target.textContent).toContain('Question A');
  await key('3'); expect(calls).toHaveLength(0);
  await tap('Reveal answer'); expect(target.textContent).toContain('Answer A');
  await tap('Good'); expect(target.textContent).toContain('Question B'); expect(saved.size).toBe(0);
  await tap('Reveal answer'); expect(target.textContent).toContain('Answer B');
  const originalId = calls[0].review_id;
  await remount(client); await tap('Resume review');
  expect(target.textContent).toContain('Question B'); expect(target.textContent).toContain('Answer B');
  expect(target.textContent).not.toContain('Question A');
  await act(async () => hold.finish());
  expect(calls.filter(c => c.card_id === 'A').every(c => c.review_id === originalId)).toBe(true);
  await tap('Hard'); await tap('Reveal answer'); await tap('Easy');
  expect(target.textContent).toContain('Ready to finish.'); expect(target.textContent).not.toContain('Saved.');
  const finishTime = new Date('2026-01-10T03:15:00Z');
  vi.useFakeTimers({ toFake: ['Date'] });
  try {
    vi.setSystemTime(finishTime);
    await tap('Finish'); expect(target.textContent).toContain('Saved.'); expect(saved.size).toBe(3);
    const displayed = finishTime.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
    expect(target.querySelector('time')?.textContent).toBe(displayed);
    vi.setSystemTime(new Date('2026-01-12T12:30:00Z'));
    await remount(client);
    expect(target.querySelector('time')?.dateTime).toBe(finishTime.toISOString());
    expect(target.querySelector('time')?.textContent).toBe(displayed);
  } finally { vi.useRealTimers(); }
});

test('uncertain final save retries the same event, blocks Finish, and never auto-completes', async () => {
  const hold = deferred<void>(); const calls: ReviewEvent[] = []; const persisted = new Set<string>();
  const client = api({ async due() { return cards().slice(0, 1); }, async grade(event) {
    calls.push(event); persisted.add(event.review_id);
    if (calls.length === 1) { await hold.promise; throw Error('response lost'); }
  } });
  await act(async () => root.render(<ReviewFixture sessionApi={session.api} api={client} />));
  await tap('Start review'); await tap('Reveal answer'); await tap('Again');
  expect(button('Finish')?.disabled).toBe(true);
  await act(async () => hold.finish()); expect(button('Finish')?.disabled).toBe(true);
  await tap('Retry save'); expect(calls).toHaveLength(2); expect(calls[1]).toEqual(calls[0]); expect(persisted.size).toBe(1);
  expect(button('Finish')?.disabled).toBe(false); expect(target.textContent).not.toContain('Saved.');
  await tap('Finish'); expect(target.textContent).toContain('Saved.');
});

test('Apps and Account suppress grades, Escape restores trigger, sign-out hides all private content', async () => {
  const grade = vi.fn(async () => {});
  await act(async () => root.render(<ReviewFixture sessionApi={session.api} api={api({ grade })} />));
  expect(button('Sign out')).toBeUndefined();
  await tap('Start review'); await tap('Reveal answer');
  for (const label of ['Apps', 'Account']) {
    await tap(label); await key('3'); await key(' '); expect(grade).not.toHaveBeenCalled();
    await key('Escape'); expect(document.activeElement).toBe(button(label));
    expect(target.querySelector('[data-popover-open]')).toBeNull();
  }
  await tap('Account'); await tap('Sign out');
  expect(target.textContent).toContain('Welcome back.'); expect(target.textContent).not.toContain('Answer A');
});

test.each(['yes', 'no', 'no_opportunity', 'skip'] as const)('habit %s is distinct from recall and precedes answer reveal', async outcome => {
  const action = vi.fn(async (_: ActionEvent) => {}); const grade = vi.fn(async () => {});
  await act(async () => root.render(<ReviewFixture sessionApi={session.api} api={api({ opportunities: async () => opportunities(), action, grade })} />));
  await tap('Start review'); expect(target.textContent).toContain('After lunch today');
  expect(target.textContent).not.toContain('Question A'); expect(button('Reveal answer')).toBeUndefined();
  await tap(({ yes: 'Yes', no: 'No', no_opportunity: 'No opportunity', skip: 'Skip' })[outcome]);
  expect(action).toHaveBeenCalledTimes(1); expect(action.mock.calls[0][0].outcome).toBe(outcome);
  expect(grade).not.toHaveBeenCalled(); expect(target.textContent).toContain('Question A');
});

test('a failed durable write cannot advance or send a grade', async () => {
  const grade = vi.fn(async () => {}); let rejectWrite = false;
  const storage = { get length() { return localStorage.length; }, key: (i: number) => localStorage.key(i),
    getItem: (key: string) => localStorage.getItem(key), removeItem: (key: string) => localStorage.removeItem(key),
    setItem(key: string, value: string) { if (rejectWrite) throw Error('quota'); localStorage.setItem(key, value); } };
  const store = makeDurableSession({ storage, key: 'round', api: api({ grade }), lock });
  const r = (await store.initialize(cards(), []))!; await store.start(r.id); await store.reveal(r.id, 'A');
  rejectWrite = true;
  await expect(store.rate(r.id, 'A', 'medium')).rejects.toThrow('quota');
  expect(store.read()?.cardIndex).toBe(0); expect(store.read()?.revealed).toBe(true);
  await store.flush(); expect(grade).not.toHaveBeenCalled();
  rejectWrite = false; await store.rate(r.id, 'A', 'medium'); expect(store.read()?.cardIndex).toBe(1);
});

test('late due responses cannot reveal another owner’s data', async () => {
  const late = deferred<DueCard[]>();
  const client = api({ due: () => late.promise });
  await act(async () => root.render(<ReviewFixture sessionApi={session.api} api={client} />));
  await act(async () => session.emit(null)); await act(async () => late.finish(cards()));
  expect(target.textContent).toContain('Welcome back.'); expect(target.textContent).not.toContain('Question A');
});

test('a late Start completion cannot open a replacement owner’s review', async () => {
  const gate = deferred<void>(); let holdNextMutation = false;
  Object.defineProperty(navigator, 'locks', { configurable: true, value: { async request<T>(name: string, run: () => Promise<T>) {
    const shouldHold = holdNextMutation && !name.endsWith('.network');
    if (shouldHold) holdNextMutation = false;
    const result = await lock(name, run);
    if (shouldHold) await gate.promise;
    return result;
  } } });
  const client = api();
  await act(async () => root.render(<ReviewFixture sessionApi={session.api} api={client} />));
  holdNextMutation = true; await tap('Start review');
  await act(async () => session.emit('other-owner'));
  expect(button('Start review')).toBeDefined();
  await act(async () => gate.finish());
  expect(button('Start review')).toBeDefined();
  expect(target.textContent).not.toContain('Question A');
});

test('a late Done completion cannot reload or leave a replacement owner’s revealed card', async () => {
  const gate = deferred<void>(); let holdNextMutation = false;
  Object.defineProperty(navigator, 'locks', { configurable: true, value: { async request<T>(name: string, run: () => Promise<T>) {
    const shouldHold = holdNextMutation && !name.endsWith('.network');
    if (shouldHold) holdNextMutation = false;
    const result = await lock(name, run);
    if (shouldHold) await gate.promise;
    return result;
  } } });
  const due = vi.fn(async () => cards().slice(0, 1)); const client = api({ due });
  await act(async () => root.render(<ReviewFixture sessionApi={session.api} api={client} />));
  await tap('Start review'); await tap('Reveal answer'); await tap('Good'); await tap('Finish');
  holdNextMutation = true; await tap('Done');
  await act(async () => session.emit('other-owner'));
  await tap('Start review'); await tap('Reveal answer');
  expect(due).toHaveBeenCalledTimes(2);
  await act(async () => gate.finish());
  expect(due).toHaveBeenCalledTimes(2);
  expect(target.textContent).toContain('Answer A');
  expect(button('Good')).toBeDefined();
});

test('two tabs cannot grade the same cursor twice or overwrite each other’s progress', async () => {
  const client = api(); const a = makeDurableSession({ storage: localStorage, key: 'round', api: client, lock });
  const b = makeDurableSession({ storage: localStorage, key: 'round', api: client, lock });
  const r = (await a.initialize(cards(), []))!; await a.start(r.id); await a.reveal(r.id, 'A');
  await Promise.all([a.rate(r.id, 'A', 'medium'), b.rate(r.id, 'A', 'easy')]);
  expect(a.read()?.cardIndex).toBe(1); expect(a.read()?.saves).toHaveLength(1);
  await b.reveal(r.id, 'B'); expect(a.read()?.revealed).toBe(true);
});

test('safe formatted answers never execute HTML or fetch embedded images', async () => {
  await act(async () => root.render(<FormattedText text={'**Bold**\n- One\n- Two\n<script>bad()</script>\n![tracking](https://example.invalid/pixel)\n[bad](javascript:bad())\n`code`'} />));
  expect(target.querySelector('strong')?.textContent).toBe('Bold'); expect(target.querySelectorAll('li')).toHaveLength(2);
  expect(target.querySelector('script,img,iframe')).toBeNull();
  expect(target.querySelector('a[href^="javascript:"]')).toBeNull();
});

test.each(['latest', 'open'] as const)('a missing %s RPC allows ordinary reviews and probes again after completion', async missing => {
  const latest = vi.fn(async (): Promise<RoundItem[]> => {
    if (missing === 'latest') throw new MissingRoundRpc();
    return [];
  });
  const open = vi.fn(async (): Promise<RoundItem[]> => { throw new MissingRoundRpc(); });
  const due = vi.fn(async () => cards().slice(0, 1));
  const grade = vi.fn(async () => {});
  const rounds = { latest, open, finish: vi.fn(async () => []) };
  const client = api({ due, grade, rounds });
  await remount(client);
  expect(due).toHaveBeenCalledTimes(1);
  await tap('Start review'); await tap('Reveal answer'); await tap('Good'); await tap('Finish');
  expect(grade).toHaveBeenCalledTimes(1);
  expect(rounds.finish).not.toHaveBeenCalled();
  // The hosted backend acquires the new RPCs while this legacy round is open.
  latest.mockResolvedValue([]);
  open.mockResolvedValue([]);
  await tap('Done');
  expect(latest).toHaveBeenCalledTimes(2);
  expect(due).toHaveBeenCalledTimes(1);
  expect(target.textContent).toContain('No cards due');
});

test.each([new Error('offline'), new RecallApiError('Not authorized', 403)])('a failed round request never falls back on transport or authorization errors', async failure => {
  const due = vi.fn(async () => cards());
  await remount(api({ due, rounds: {
    latest: async () => { throw failure; }, open: async () => [], finish: async () => []
  } }));
  expect(due).not.toHaveBeenCalled();
  expect(button('Start review')).toBeUndefined();
});

test('a cached server round keeps its server event IDs when the backend becomes unavailable', async () => {
  const remote: RoundItem = { round_id: 'server-round', event_id: 'server-event', item_kind: 'review',
    card_id: 'server-card', revision: 0, front: 'Server prompt', back: 'Answer', paired_action: false,
    position: 0, opportunity_id: null, answer: null, answered_at: null, due_at: null, finished_at: null };
  const due = vi.fn(async () => cards());
  const open = vi.fn(async (): Promise<RoundItem[]> => { throw new MissingRoundRpc(); });
  const client = api({ due, rounds: { latest: async () => [remote], open, finish: async () => [] } });
  await remount(client);
  await remount(client);
  expect(open).toHaveBeenCalledWith('server-round');
  expect(due).not.toHaveBeenCalled();
  const saved = JSON.parse(localStorage.getItem('recall.round.v3.https://fixture.invalid.owner')!);
  expect(saved.cards[0].event_id).toBe('server-event');
});
