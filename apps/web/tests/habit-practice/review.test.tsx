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

test('exact revealed card resumes while an earlier original grade is pending and the last saved grade completes it', async () => {
  const hold = deferred<void>(); const calls: ReviewEvent[] = []; const saved = new Set<string>();
  const client = api({ async grade(event) { calls.push(event); if (calls.length === 1) await hold.promise; saved.add(event.review_id); } });
  await act(async () => root.render(<StrictMode><ReviewFixture sessionApi={session.api} api={client} /></StrictMode>));
  expect(button('Start review')).toBeUndefined();
  expect(target.textContent).toContain('Question A');
  await key('3'); expect(calls).toHaveLength(0);
  await tap('Reveal answer'); expect(target.textContent).toContain('Answer A');
  await tap('Good'); expect(target.textContent).toContain('Question B'); expect(saved.size).toBe(0);
  await tap('Reveal answer'); expect(target.textContent).toContain('Answer B');
  const originalId = calls[0].review_id;
  await remount(client);
  expect(target.textContent).toContain('Question B'); expect(target.textContent).toContain('Answer B');
  expect(target.textContent).not.toContain('Question A');
  await act(async () => hold.finish());
  expect(calls.filter(c => c.card_id === 'A').every(c => c.review_id === originalId)).toBe(true);
  await tap('Hard'); await tap('Reveal answer'); await tap('Easy');
  expect(target.textContent).toContain('Saved.'); expect(saved.size).toBe(3);
  await remount(client); expect(target.textContent).toContain('Question A');
});

test('uncertain final save retries the same event, and completes only after acknowledgement', async () => {
  const hold = deferred<void>(); const calls: ReviewEvent[] = []; const persisted = new Set<string>();
  const client = api({ async due() { return cards().slice(0, 1); }, async grade(event) {
    calls.push(event); persisted.add(event.review_id);
    if (calls.length === 1) { await hold.promise; throw Error('response lost'); }
  } });
  await act(async () => root.render(<ReviewFixture sessionApi={session.api} api={client} />));
  await tap('Reveal answer'); await tap('Again');
  expect(target.textContent).not.toContain('Saved.');
  await act(async () => hold.finish()); expect(target.textContent).not.toContain('Saved.');
  await tap('Retry save'); expect(calls).toHaveLength(2); expect(calls[1]).toEqual(calls[0]); expect(persisted.size).toBe(1);
  expect(target.textContent).toContain('Saved.');
});

test('Apps and Account suppress grades, Escape restores trigger, sign-out hides all private content', async () => {
  const grade = vi.fn(async () => {});
  await act(async () => root.render(<ReviewFixture sessionApi={session.api} api={api({ grade })} />));
  expect(button('Sign out')).toBeUndefined();
  await tap('Reveal answer');
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
  expect(target.textContent).toContain('After lunch today');
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
  const r = (await store.initialize(cards(), []))!; await store.reveal(r.id, 'A');
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

test('a late Check again completion cannot reload or leave a replacement owner’s revealed card', async () => {
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
  await tap('Reveal answer'); await tap('Good');
  holdNextMutation = true; await tap('Check again');
  await act(async () => session.emit('other-owner'));
  await tap('Reveal answer');
  expect(due).toHaveBeenCalledTimes(2);
  await act(async () => gate.finish());
  expect(due).toHaveBeenCalledTimes(2);
  expect(target.textContent).toContain('Answer A');
  expect(button('Good')).toBeDefined();
});

test('two tabs cannot grade the same cursor twice or overwrite each other’s progress', async () => {
  const client = api(); const a = makeDurableSession({ storage: localStorage, key: 'round', api: client, lock });
  const b = makeDurableSession({ storage: localStorage, key: 'round', api: client, lock });
  const r = (await a.initialize(cards(), []))!; await a.reveal(r.id, 'A');
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
  await tap('Reveal answer'); await tap('Good');
  expect(grade).toHaveBeenCalledTimes(1);
  expect(rounds.finish).not.toHaveBeenCalled();
  // The hosted backend acquires the new RPCs while this legacy round is open.
  latest.mockResolvedValue([]);
  open.mockResolvedValue([]);
  await tap('Check again');
  expect(open).toHaveBeenCalledTimes(2);
  expect(latest).toHaveBeenCalledTimes(1);
  expect(due).toHaveBeenCalledTimes(1);
  expect(target.textContent).toContain('No cards due');
});

test.each([new Error('offline'), new RecallApiError('Not authorized', 403)])('a failed round request never falls back on transport or authorization errors', async failure => {
  const due = vi.fn(async () => cards());
  await remount(api({ due, rounds: {
    latest: async () => [], open: async () => { throw failure; }, finish: async () => []
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
  open.mockResolvedValueOnce([remote]);
  const client = api({ due, rounds: { latest: async () => [], open, finish: async () => [] } });
  await remount(client);
  await remount(client);
  expect(open).toHaveBeenCalledWith('server-round');
  expect(due).not.toHaveBeenCalled();
  const saved = JSON.parse(localStorage.getItem('recall.round.v3.https://fixture.invalid.owner')!);
  expect(saved.cards[0].event_id).toBe('server-event');
});

test.each(['/recall/', '/recall/?dot=1'])('review completes directly at %s, with replay after a lost completion response', async entry => {
  const item: RoundItem = {
    round_id: 'round-A', event_id: 'event-A', item_kind: 'review', paired_action: false,
    position: 0, card_id: 'A', revision: 0, front: 'Question', back: 'Answer',
    opportunity_id: null, due_at: null, answer: null, answered_at: null, finished_at: null
  };
  let at = '';
  const finish = vi.fn(async (_id: string) => [{ ...item, answer: 'medium', answered_at: at, finished_at: at }]);
  finish.mockRejectedValueOnce(new Error('Response lost'));
  const grade = vi.fn(async (event: ReviewEvent) => { at = event.reviewed_at; });
  const client = api({ grade, rounds: { latest: async () => [item], open: async () => [item], finish } });
  await act(async () => root.render(<ReviewFixture api={client} sessionApi={session.api} entry={entry} />));
  expect(target.textContent).toContain('Question');
  expect(button('Request Dot debrief')).toBeUndefined();
  expect(button('Start review')).toBeUndefined();
  await tap('Reveal answer'); await tap('Good');
  expect(button('Finish')).toBeUndefined();
  expect(target.textContent).not.toContain('Saved.');
  await tap('Retry save');
  expect(finish.mock.calls).toEqual([['round-A'], ['round-A']]);
  expect(grade).toHaveBeenCalledTimes(1);
  expect(target.textContent).toContain('Saved.');
});

test('a late or unavailable preview does not block grading or carry intervals to the next card', async () => {
  const hold = deferred<Record<ReviewEvent['grade'], number>>();
  const preview = vi.fn().mockReturnValueOnce(hold.promise).mockRejectedValue(Error('offline'));
  const grade = vi.fn(async () => {});
  await remount(api({ preview, grade }));
  expect(preview).toHaveBeenCalledExactlyOnceWith('A', 0);
  await tap('Reveal answer');
  expect(preview).toHaveBeenCalledTimes(1);
  await key('3');
  expect(preview).toHaveBeenNthCalledWith(2, 'B', 0);
  await tap('Reveal answer');
  expect(target.textContent).toContain('Review intervals unavailable.');
  await act(async () => hold.finish({ miss: 1, hard: 6, medium: 10, easy: 11520 }));
  expect(target.querySelector('.ratings small')).toBeNull();
  await tap('Easy');
  expect(grade.mock.calls).toHaveLength(2);
});
