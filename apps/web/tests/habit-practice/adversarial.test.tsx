import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, test, vi } from 'vitest';
import { ReviewFixture, makeSessionFixture } from './site-fixture.tsx';
import { makeDurableSession, type Lock } from '../../src/apps/habit-practice/durable-session.ts';
import { RecallApiError, type RecallApi } from '../../src/apps/habit-practice/recall-api.ts';
import type { DueCard, ReviewEvent } from '../../src/apps/habit-practice/review-session.ts';
const cards: DueCard[] = ['a', 'b'].map(card_id => ({ card_id, front: `Synthetic question ${card_id}`, back: `Synthetic answer ${card_id}`, revision: 0 }));
function memory() {
  const entries = new Map<string, string>();
  return { fail: false, get length() { return entries.size; }, key(i: number) { return [...entries.keys()][i] ?? null; },
    getItem(key: string) { return entries.get(key) ?? null; },
    setItem(key: string, value: string) { if (this.fail) throw new DOMException('Quota exceeded', 'QuotaExceededError'); entries.set(key, value); },
    removeItem(key: string) { entries.delete(key); } };
}
function locks(): Lock {
  const pending = new Map<string, Promise<unknown>>();
  return <T,>(name: string, run: () => Promise<T>) => {
    const result = (pending.get(name) ?? Promise.resolve()).then(run, run);
    pending.set(name, result.catch(() => {})); return result;
  };
}
const fakeApi = (grade: (event: ReviewEvent) => Promise<void> = async () => {}): RecallApi => ({
  origin: 'https://synthetic.invalid', async due() { return cards; }, grade
});
function deferred() { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; }

test('stale tabs share atomic progress and serialize duplicate network drains', async () => {
  const storage = memory(), lock = locks(), send = vi.fn(async () => {}), api = fakeApi(send);
  const a = makeDurableSession({ storage, lock, key: 'concurrent', api });
  const b = makeDurableSession({ storage, lock, key: 'concurrent', api });
  const r = (await a.initialize(cards, []))!;
  await a.start(r.id);
  await Promise.all([a.reveal(r.id, 'a'), b.reveal(r.id, 'a')]);
  await Promise.all([a.rate(r.id, 'a', 'easy'), b.rate(r.id, 'a', 'miss')]);
  expect(a.read()?.cardIndex).toBe(1); expect(a.read()?.saves).toHaveLength(1);
  await Promise.all([a.flush(), b.flush()]);
  expect(send).toHaveBeenCalledTimes(1); expect(a.read()?.saves[0].status).toBe('saved');
});

test('reload restores the exact revealed card while an earlier grade is still pending', async () => {
  const storage = memory(), lock = locks(), hold = deferred(), api = fakeApi(async () => hold.promise);
  const a = makeDurableSession({ storage, lock, key: 'resume', api });
  const r = (await a.initialize(cards, []))!;
  await a.start(r.id); await a.reveal(r.id, 'a'); await a.rate(r.id, 'a', 'medium');
  const draining = a.flush(); await a.reveal(r.id, 'b');
  const snapshot = a.read()!;
  const b = makeDurableSession({ storage, lock, key: 'resume', api });
  expect(await b.initialize([], [])).toEqual(snapshot);
  expect(b.read()).toMatchObject({ cardIndex: 1, revealed: true, finished: false });
  expect(b.read()?.saves[0]).toMatchObject({ status: 'pending', event: { card_id: 'a', grade: 'medium' } });
  hold.release(); await draining;
  expect(b.read()).toMatchObject({ cardIndex: 1, revealed: true, finished: false });
});

test('storage failure after server acknowledgement preserves the exact event for idempotent retry', async () => {
  const storage = memory(), lock = locks(), requests: ReviewEvent[] = [], committed = new Set<string>();
  const api = fakeApi(async event => { requests.push(event); committed.add(event.review_id); storage.fail = true; });
  const session = makeDurableSession({ storage, lock, key: 'ack', api });
  const r = (await session.initialize(cards.slice(0, 1), []))!;
  await session.start(r.id); await session.reveal(r.id, 'a'); await session.rate(r.id, 'a', 'hard');
  await expect(session.flush()).rejects.toThrow();
  expect(session.read()?.saves[0].status).toBe('pending'); expect(session.read()?.finished).toBe(false);
  storage.fail = false;
  api.grade = async event => { requests.push(event); committed.add(event.review_id); };
  await session.retry();
  expect(requests).toHaveLength(2); expect(requests[1]).toEqual(requests[0]); expect(committed.size).toBe(1);
  expect(session.read()?.saves[0].status).toBe('saved'); expect(session.read()?.finished).toBe(false);
  await session.finish(r.id); expect(session.read()?.finished).toBe(true);
});

test('storage quota failure never consumes a revealed card', async () => {
  const storage = memory(), session = makeDurableSession({ storage, lock: locks(), key: 'quota', api: fakeApi() });
  const r = (await session.initialize(cards, []))!;
  await session.start(r.id); await session.reveal(r.id, 'a'); storage.fail = true;
  await expect(session.rate(r.id, 'a', 'medium')).rejects.toThrow();
  expect(session.read()).toMatchObject({ cardIndex: 0, revealed: true, saves: [] });
  storage.fail = false; await session.rate(r.id, 'a', 'medium');
  expect(session.read()).toMatchObject({ cardIndex: 1, revealed: false }); expect(session.read()?.saves).toHaveLength(1);
});

test('Finish cannot bypass a pending or permanently rejected final grade', async () => {
  const storage = memory(), session = makeDurableSession({ storage, lock: locks(), key: 'finish', api: fakeApi(async () => { throw new RecallApiError('Conflict', 409); }) });
  const r = (await session.initialize(cards.slice(0, 1), []))!;
  await session.start(r.id); await session.reveal(r.id, 'a'); await session.rate(r.id, 'a', 'easy');
  await session.finish(r.id); expect(session.read()?.finished).toBe(false);
  await session.flush(); await session.finish(r.id);
  expect(session.read()?.saves[0].status).toBe('conflict'); expect(session.read()?.finished).toBe(false);
});

test('Check again fetches cards that became due after an initially empty round', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const lock = locks();
  Object.defineProperty(navigator, 'locks', { configurable: true, value: { request: (name: string, run: () => Promise<unknown>) => lock(name, run) } });
  localStorage.clear(); const api = fakeApi(); let loads = 0;
  const due = vi.fn(async () => ++loads === 1 ? [] : cards.slice(0, 1)); api.due = due;
  const target = document.createElement('div'); document.body.append(target); const root = createRoot(target);
  try {
    await act(async () => root.render(<ReviewFixture sessionApi={makeSessionFixture('synthetic-owner').api} api={api} />)); expect(target.textContent).toContain('Nothing due');
    const check = [...target.querySelectorAll('button')].find(button => button.textContent === 'Check again');
    expect(check).toBeDefined(); await act(async () => check!.click());
    expect(due).toHaveBeenCalledTimes(2); expect(target.textContent).toContain('1 card');
  } finally { await act(async () => root.unmount()); target.remove(); localStorage.clear(); }
});
