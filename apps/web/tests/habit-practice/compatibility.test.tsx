// @vitest-environment node
// Legacy fixture: public neckardt1/NeckardtApps main commit
// 4985c9aeadc20712a1d3f4eff3517596060a10e7, adapter blob
// 708f5114b896326633a35dc6b817b7fd041790c6. Only relative imports relocate.
// This is adapter/session compatibility, not browser UI coverage. The SDK
// transport seam is mocked; SQL, the Edge handler, and FSRS are production code.
import { createHash, randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import * as fsrsLib from 'ts-fsrs';
import { expect, test, vi } from 'vitest';

const transport = vi.hoisted(() => ({ rpc: vi.fn(), invoke: vi.fn() }));
vi.mock('@supabase/supabase-js', () => ({ createClient: () => ({
  rpc: transport.rpc, functions: { invoke: transport.invoke }, auth: {}
}) }));
import { makeRecallApi as makeLegacyApi } from './fixtures/main-4985c9a-recall-api.ts';
import { makeRecallApi } from '../../src/apps/habit-practice/recall-api.ts';
import { makeDurableSession, type Lock } from '../../src/apps/habit-practice/durable-session.ts';
import { makeOutbox, makeReviewSession, type ReviewEvent } from '../../src/apps/habit-practice/review-session.ts';
import { gradeHandler, schedulerFor } from '../../../backend/supabase/functions/recall-grade/grade.ts';
import type { AnswerRow, CommitRow, PrepareArgs } from '../../../backend/supabase/functions/recall-grade/rpc-args.ts';

const baseline = '4985c9aeadc20712a1d3f4eff3517596060a10e7';
const gitBlob = (source: string) => createHash('sha1').update(`blob ${Buffer.byteLength(source)}\0`).update(source).digest('hex');

test(`legacy client fixture matches public main ${baseline} except relocated imports`, async () => {
  const fixture = await readFile(new URL('./fixtures/main-4985c9a-recall-api.ts', import.meta.url), 'utf8');
  const original = fixture.replace('"../../../src/shell/browser-auth.mts"', '"../../../shared/browser-auth.mts"')
    .replace('"../../../src/apps/habit-practice/review-session.ts"', '"./review-session.ts"');
  expect(gitBlob(original)).toBe('708f5114b896326633a35dc6b817b7fd041790c6');
  // The existing production session/outbox is the exact V1 implementation, too.
  expect(gitBlob(await readFile(new URL('../../src/apps/habit-practice/review-session.ts', import.meta.url), 'utf8')))
    .toBe('92097c5daca051585c4472720a66afecf8e6cd70');
});

function memory() {
  const values = new Map<string, string>();
  return {
    failKey: null as string | null,
    get length() { return values.size; }, key(i: number) { return [...values.keys()][i] ?? null; },
    getItem(key: string) { return values.get(key) ?? null; },
    setItem(key: string, value: string) { if (key === this.failKey) throw Error('Synthetic storage quota'); values.set(key, value); },
    removeItem(key: string) { values.delete(key); }
  };
}
const lock: Lock = async (_name, run) => run();

test('actual V1 and V2 clients preserve unsupported cached grades and replay supported saves across the migration', async () => {
  const db = new PGlite();
  const owner = randomUUID();
  const unsupported = randomUUID(), oldMemory = randomUUID(), newMemory = randomUUID();
  const q = async <T extends Record<string, unknown> = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
    (await db.query<T>(sql, params)).rows;
  const role = async (name: 'authenticated' | 'service_role') => {
    await db.exec('reset role; set role ' + name);
    await q("select set_config('request.jwt.claim.sub',$1,false)", [owner]);
  };
  const migration = async (name: string) => {
    await db.exec('reset role');
    await db.exec(await readFile(new URL('../../../backend/supabase/migrations/' + name + '.sql', import.meta.url), 'utf8'));
  };
  const count = async (table: 'reviews' | 'action_responses') => {
    await db.exec('reset role');
    return Number((await q<{ count: number }>('select count(*) as count from flashcards_private.' + table))[0].count);
  };
  let forbidFetch: ReturnType<typeof vi.spyOn> | undefined;
  try {
    await db.exec(`create role anon nologin; create role authenticated nologin; create role service_role nologin; create role supabase_auth_admin nologin;
      create schema auth; create table auth.users(id uuid primary key);
      create function auth.uid() returns uuid stable language sql as $$
        select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid
      $$; grant usage on schema auth to anon,authenticated,service_role;`);
    await migration('20261121000000_demo_flashcards');
    await migration('20261121000100_recall_fsrs_synthetic');
    await q('insert into auth.users values($1)', [owner]);
    await q('insert into flashcards_private.app_owner(owner_id) values($1)', [owner]);
    for (const [id, seconds] of [[unsupported, 3], [oldMemory, 2], [newMemory, 1]] as const) {
      await q(`insert into flashcards_private.cards(id,owner_id,front,back,due_at)
        values($1,$2,'Synthetic prompt','Synthetic answer',now()-$3*interval '1 hour')`, [id, owner, seconds]);
    }
    await db.exec(`create table flashcards_private.notion_imports(owner_id uuid,card_id uuid,kind text,source_doc jsonb);
      alter table flashcards_private.notion_imports enable row level security;
      revoke all on flashcards_private.notion_imports from public,anon,authenticated,service_role;`);
    await q("insert into flashcards_private.notion_imports values($1,$2,'habit-action','{}')", [owner, unsupported]);
    for (const id of [oldMemory, newMemory]) await q("insert into flashcards_private.notion_imports values($1,$2,'fact','{}')", [owner, id]);

    // Only the SDK transport seam is mocked. Both adapters call the real SQL
    // functions, and grade requests run the production Edge handler and FSRS.
    forbidFetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => { throw Error('Network forbidden in compatibility fixture'); });
    transport.rpc.mockImplementation(async (name: string, params: { p_limit: number }) => {
      if (!['demo_flashcards_due', 'recall_due', 'recall_opportunities'].includes(name)) throw Error('Unexpected synthetic RPC');
      await role('authenticated');
      try { return { data: await q('select * from public.' + name + '($1)', [params.p_limit]), error: null }; }
      catch (error) { return { data: null, error }; }
    });
    const args = (p: PrepareArgs) => [p.p_owner,p.p_review_id,p.p_card_id,p.p_revision,p.p_grade,p.p_reviewed_at];
    const handler = gradeHandler({
      getOwner: async () => owner,
      // PostgREST serializes typed rows (including timestamps) to JSON on the wire.
      prepare: async p => (await q<{ value: AnswerRow }>(
        'select to_jsonb(answer) as value from public.recall_prepare_answer($1,$2,$3,$4,$5,$6) as answer',
        args(p)))[0].value,
      commit: async p => (await q<{ value: CommitRow }>(
        'select to_jsonb(answer) as value from public.recall_commit_answer($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) as answer',
        [...args(p),p.p_due_at,p.p_state,p.p_log,p.p_scheduler_build,p.p_scheduler_config]))[0].value,
      schedule: schedulerFor(fsrsLib)
    });
    const statuses: number[] = [];
    transport.invoke.mockImplementation(async (name: string, { body }: { body: ReviewEvent }) => {
      if (name !== 'recall-grade') throw Error('Unexpected synthetic function');
      await role('service_role');
      const response: Response = await handler(new Request('https://fixture.invalid/recall-grade', {
        method: 'POST', headers: { authorization: 'Bearer synthetic-owner' }, body: JSON.stringify(body)
      }));
      statuses.push(response.status);
      return { data: await response.clone().json(), error: response.ok ? null : { context: response } };
    });
    const config = { url: 'https://abcdefghijklmnopqrst.supabase.co', publishableKey: 'sb_publishable_fixture' };
    const legacy = makeLegacyApi(config), current = makeRecallApi(config);
    const storage = memory(), legacyPrefix = `recall.live.v1.${legacy.origin}.${owner}.`;
    const oldBox = makeOutbox({ storage, prefix: legacyPrefix, send: event => legacy.grade(event) });
    const prefetched = await legacy.due();
    expect(prefetched[0].card_id).toBe(unsupported);
    const oldSession = makeReviewSession(prefetched.slice(0, 1), event => oldBox.enqueue(event));
    oldSession.reveal();
    const original = oldSession.rate('medium')!;
    const originalPayload = JSON.stringify(original);
    expect(oldBox.entries()[0]).toMatchObject({ status: 'pending', event: original });

    // An already-open old client still has the unsupported card and original
    // pending event when the guarded migration becomes active.
    const migrations = new URL('../../../backend/supabase/migrations/', import.meta.url);
    for (const name of (await readdir(migrations)).filter(name => name.endsWith('.sql')).sort()) {
      if (name > '20261121000100_recall_fsrs_synthetic.sql') await migration(name.slice(0, -4));
    }
    await oldBox.flush();
    expect(statuses.at(-1)).toBe(422);
    expect(oldBox.entries()).toEqual([{ status: 'conflict', event: original }]);
    expect(JSON.stringify(oldBox.entries()[0].event)).toBe(originalPayload);
    expect(await count('reviews')).toBe(0);
    expect(await count('action_responses')).toBe(0);
    expect((await legacy.due()).map(card => card.card_id)).toEqual([oldMemory, newMemory]);
    expect((await current.due()).map(card => card.card_id)).toEqual([oldMemory, newMemory]);

    const v1Key = legacyPrefix + original.review_id;
    const originalStoredConflict = storage.getItem(v1Key);
    const v2Key = `recall.round.v2.${current.origin}.${owner}`;
    const store = makeDurableSession({ storage, key: v2Key, api: current, lock });
    storage.failKey = v2Key;
    await expect(store.initialize([], [], legacyPrefix)).rejects.toThrow('Synthetic storage quota');
    expect(storage.getItem(v1Key)).toBe(originalStoredConflict);
    expect(storage.getItem(v2Key)).toBeNull();
    storage.failKey = null;
    const migrated = (await store.initialize([], [], legacyPrefix))!;
    expect(storage.getItem(v1Key)).toBeNull();
    expect(migrated.saves).toEqual([{ kind: 'review', status: 'conflict', event: original }]);
    expect(JSON.stringify(migrated.saves[0].event)).toBe(originalPayload);
    const callsBeforeRetry = statuses.length;
    await store.start(migrated.id); await store.retry(); await store.finish(migrated.id);
    expect(store.read()?.finished).toBe(false);
    expect(store.read()?.saves).toEqual(migrated.saves);
    expect(statuses).toHaveLength(callsBeforeRetry);
    expect(await count('reviews')).toBe(0);
    expect(await count('action_responses')).toBe(0);

    // Characterize the rollout limitation: an old tab can still create a V1
    // key after V2 initialized. V2 does not continuously import those keys.
    const staleTab = makeReviewSession(prefetched.slice(0, 1), event => oldBox.enqueue(event));
    staleTab.reveal(); const lateLegacyEvent = staleTab.rate('hard')!;
    expect(storage.getItem(legacyPrefix + lateLegacyEvent.review_id)).not.toBeNull();
    expect(store.read()?.saves).toEqual(migrated.saves);
    expect(store.read()?.saves.some(save => save.kind === 'review' && save.event.review_id === lateLegacyEvent.review_id)).toBe(false);

    // A separate clean device hands an as-yet-unsent V1 event to V2. The actual
    // current adapter receives 422 and the actual V2 saver preserves conflict.
    const pendingStorage = memory();
    const pendingOldBox = makeOutbox({ storage: pendingStorage, prefix: legacyPrefix, send: event => legacy.grade(event) });
    pendingOldBox.enqueue(lateLegacyEvent);
    const pendingV2 = makeDurableSession({ storage: pendingStorage, key: v2Key, api: current, lock });
    const pendingRound = (await pendingV2.initialize([], [], legacyPrefix))!;
    expect(pendingRound.saves).toEqual([{ kind: 'review', status: 'pending', event: lateLegacyEvent }]);
    expect(pendingStorage.getItem(legacyPrefix + lateLegacyEvent.review_id)).toBeNull();
    await pendingV2.start(pendingRound.id); await pendingV2.flush(); await pendingV2.finish(pendingRound.id);
    expect(statuses.at(-1)).toBe(422);
    expect(pendingV2.read()?.saves).toEqual([{ kind: 'review', status: 'conflict', event: lateLegacyEvent }]);
    expect(pendingV2.read()?.finished).toBe(false);
    expect(await count('reviews')).toBe(0);
    expect(await count('action_responses')).toBe(0);

    // Separate clean devices exercise supported old and new client writes and
    // exact receipt replays. No synthetic event is translated into an action.
    const supportedStorage = memory();
    const supportedBox = makeOutbox({ storage: supportedStorage, prefix: 'supported-v1.', send: event => legacy.grade(event) });
    const supportedSession = makeReviewSession((await legacy.due()).filter(card => card.card_id === oldMemory), event => supportedBox.enqueue(event));
    supportedSession.reveal(); const oldEvent = supportedSession.rate('medium')!;
    await supportedBox.flush(); expect(supportedBox.entries()).toEqual([]);
    await legacy.grade(oldEvent); await current.grade(oldEvent);
    expect(await count('reviews')).toBe(1);

    const supportedV2 = makeDurableSession({ storage: memory(), key: 'supported-v2', api: current, lock });
    const fresh = (await supportedV2.initialize((await current.due()).filter(card => card.card_id === newMemory), []))!;
    await supportedV2.start(fresh.id); await supportedV2.reveal(fresh.id, newMemory);
    await supportedV2.rate(fresh.id, newMemory, 'easy'); await supportedV2.flush();
    const newSave = supportedV2.read()!.saves[0];
    expect(newSave.status).toBe('saved'); expect(newSave.kind).toBe('review');
    if (newSave.kind !== 'review') throw Error('Expected memory review');
    await current.grade(newSave.event); await legacy.grade(newSave.event);
    expect(supportedV2.read()?.finished).toBe(false);
    await supportedV2.finish(fresh.id); expect(supportedV2.read()?.finished).toBe(true);
    expect(await count('reviews')).toBe(2);
    expect(await count('action_responses')).toBe(0);
    expect(await q('select revision from flashcards_private.cards where id=$1', [unsupported])).toEqual([{ revision: 0 }]);
    expect(await q('select revision from flashcards_private.cards where id in ($1,$2) order by id', [oldMemory, newMemory]))
      .toEqual([{ revision: 1 }, { revision: 1 }]);
    expect(forbidFetch).not.toHaveBeenCalled();
  } finally { forbidFetch?.mockRestore(); await db.close(); }
}, 30000);
