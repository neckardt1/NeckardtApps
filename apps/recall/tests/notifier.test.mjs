import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createNotifier, RelayError, wakeAfterSave } from '../notifier/dispatcher.mjs';
import { completionStore } from '../notifier/store.mjs';
import { httpRelay } from '../notifier/http-relay.mjs';
import { fixture } from '../notifier/fixture.mjs';
import { gradeHandler } from '../supabase/functions/recall-grade/grade.mjs';

const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
async function ready(f, count = 1) {
  const s = await f.session(count);
  await f.store.register(s);
  for (const r of s.reviews) assert.equal((await f.grade(r)).status, 200);
  return s;
}

test('completion registration and durable grade integration', async t => {
  const f = await fixture();
  t.after(() => f.close());
  const s = await f.session();
  const deliveries = [];
  const notifier = createNotifier({ store: f.store, send: async (...args) => deliveries.push(args) });
  const tasks = [];
  f.setWake(wakeAfterSave(notifier, task => tasks.push(task)));
  const eventId = await f.store.register(s);
  assert.equal(await notifier.kick(), 0);
  for (const r of s.reviews.slice(0, 2)) {
    assert.equal((await f.grade(r)).status, 200);
    await Promise.all(tasks);
    assert.equal(deliveries.length, 0);
  }
  // Neither a conflict nor an invalid review may release the final-save gate.
  assert.equal((await f.grade({ ...s.reviews[2], revision: 20 })).status, 409);
  assert.equal(await notifier.kick(), 0);
  assert.equal((await f.grade(s.reviews[2])).status, 200);
  await Promise.all(tasks);
  assert.equal(deliveries.length, 1);
  assert.deepEqual(deliveries[0][0], {
    version: 1, type: 'recall.session.completed', event_id: eventId, session_id: s.sessionId
  });
  assert.equal(deliveries[0][1].idempotencyKey, eventId);
  assert.equal(await f.store.register({ ...s, reviewIds: [...s.reviewIds].reverse() }), eventId);
  assert.equal((await f.grade(s.reviews[2])).status, 200);
  await Promise.all(tasks);
  await Promise.all([notifier.kick(), notifier.kick()]);
  assert.equal(deliveries.length, 1);
  const [event] = await f.events();
  assert.equal(event.state, 'accepted');
  assert.equal(event.attempts, 1);
  assert(event.last_review_recorded_at);
  assert.equal((await f.q('select * from flashcards_private.reviews')).length, 3);
});

test('registration after all saves still dispatches; manifests cannot mutate or reuse reviews', async t => {
  const f = await fixture(); t.after(() => f.close());
  const s = await f.session();
  for (const r of s.reviews) assert.equal((await f.grade(r)).status, 200);
  await f.store.register(s);
  await assert.rejects(f.store.register({ ...s, reviewIds: [s.reviewIds[0]] }), /changed/);
  await assert.rejects(f.store.register({ ...s, sessionId: randomUUID() }), /another session/);
  await assert.rejects(f.store.register({ ...s, reviewIds: [s.reviewIds[0], s.reviewIds[0]] }), /Duplicate/);
  assert.equal((await f.events()).length, 1, 'rejected registration rolls back');
  let sent = 0;
  await createNotifier({ store: f.store, send: async () => { sent++; } }).kick();
  assert.equal(sent, 1);
});

test('private queue denies browser roles and unknown owners', async t => {
  const f = await fixture(); t.after(() => f.close());
  const s = await f.session();
  await assert.rejects(f.store.register({ ...s, ownerId: randomUUID() }), { code: '23503' });
  for (const role of ['anon', 'authenticated', 'service_role']) {
    await f.db.exec('set role ' + role);
    await assert.rejects(f.q('select * from flashcards_private.completion_events'), { code: '42501' });
    await f.db.exec('reset role');
  }
  assert.equal((await f.events()).length, 0);
});

test('slow relay never holds successful save or replay responses', async () => {
  const gate = deferred();
  let kicks = 0;
  const handler = gradeHandler({
    getOwner: async () => randomUUID(),
    prepare: async () => ({ kind: 'replay', review_id: randomUUID() }),
    afterSave: () => { kicks++; return gate.promise; }
  });
  const request = () => new Request('https://test.invalid', { method: 'POST',
    headers: { authorization: 'Bearer synthetic' }, body: JSON.stringify({
      card_id: randomUUID(), review_id: randomUUID(), revision: 0, grade: 'medium',
      reviewed_at: new Date().toISOString()
    }) });
  assert.equal((await handler(request())).status, 200);
  assert.equal(kicks, 1);
  gate.resolve();
  const errors = [];
  let retained;
  wakeAfterSave({ kick: async () => { throw new Error('sensitive transport details'); } },
    task => { retained = task; }, code => errors.push(code))();
  await retained;
  assert.deepEqual(errors, ['notifier_wake_failed']);
});

test('kick arriving during an empty claim is not lost', async () => {
  const gate = deferred(); let claims = 0, sends = 0;
  const store = {
    claim: async () => { claims++; if (claims === 1) { await gate.promise; return null; }
      return claims === 2 ? { event_id: randomUUID(), session_id: randomUUID(), attempts: 1 } : null; },
    accepted: async () => true
  };
  const notifier = createNotifier({ store, send: async () => { sends++; } });
  const first = notifier.kick();
  await Promise.resolve(); // allow the first claim to begin
  const second = notifier.kick();
  assert.equal(first, second);
  gate.resolve(); await first;
  assert.equal(sends, 1);
});

test('overlapping dispatchers claim once; expired leases fence stale acknowledgements', async t => {
  let clock = Date.now();
  const f = await fixture({ now: () => clock }); t.after(() => f.close());
  await ready(f);
  const gate = deferred(), entered = deferred();
  let sends = 0;
  const first = createNotifier({ store: f.store, send: async () => { sends++; entered.resolve(); await gate.promise; } });
  const work = first.kick(); await entered.promise;
  assert.equal(await createNotifier({ store: completionStore(f.db, { now: () => clock }), send: async () => { sends++; } }).kick(), 0);
  gate.resolve(); await work;
  assert.equal(sends, 1);
  await ready(f);
  const a = await f.store.claim({ leaseMs: 2000, maxAttempts: 3 });
  clock += 2001;
  const b = await f.store.claim({ leaseMs: 2000, maxAttempts: 3 });
  assert.equal(a.event_id, b.event_id);
  assert.notEqual(a.lease_token, b.lease_token);
  assert.equal(await f.store.accepted(a), false);
  assert.equal(await f.store.accepted(b), true);
});

test('lost acknowledgement and worker restart retain one receiver receipt', async t => {
  let clock = Date.now();
  const f = await fixture({ now: () => clock }); t.after(() => f.close());
  await ready(f);
  const receipts = new Set(), attempts = [];
  const send = async event => { attempts.push(event.event_id); receipts.add(event.event_id); };
  const brokenAck = { ...f.store, accepted: async () => { throw new Error('DB unavailable'); } };
  await assert.rejects(createNotifier({ store: brokenAck, send }).kick(), /DB unavailable/);
  assert.equal((await f.events())[0].state, 'leased');
  clock += 10001;
  await createNotifier({ store: completionStore(f.db, { now: () => clock }), send }).kick();
  assert.equal(receipts.size, 1);
  assert.equal(attempts.length, 2);
  assert.equal(attempts[0], attempts[1]);
  assert.equal((await f.events())[0].state, 'accepted');
});

test('retry delay, permanent failures, attempt cap, and crash at final attempt', async t => {
  let clock = Date.now();
  const f = await fixture({ now: () => clock }); t.after(() => f.close());
  await ready(f);
  let sends = 0;
  const notifier = createNotifier({ store: f.store, maxAttempts: 2, random: () => 0.5,
    send: async () => { sends++; throw new RelayError('http_429', { retryAfterMs: 2000 }); } });
  await notifier.kick();
  assert.equal((await f.events())[0].state, 'waiting');
  clock += 1999; await notifier.kick(); assert.equal(sends, 1);
  clock += 1; await notifier.kick(); assert.equal(sends, 2);
  assert.equal((await f.events())[0].state, 'dead');
  await ready(f);
  await createNotifier({ store: f.store, send: async () => { throw new RelayError('http_401', { retryable: false }); } }).kick();
  assert.equal((await f.events()).filter(e => e.state === 'dead').length, 2);
  await ready(f);
  await f.store.claim({ leaseMs: 2000, maxAttempts: 1 });
  clock += 2001;
  assert.equal(await f.store.claim({ leaseMs: 2000, maxAttempts: 1 }), null);
  assert.equal((await f.events()).filter(e => e.last_error === 'delivery_unknown').length, 1);
});

test('timeout bounds even a stuck adapter; observation failures do not resend', async t => {
  const f = await fixture(); t.after(() => f.close());
  await ready(f);
  let signal;
  const notifier = createNotifier({ store: f.store, timeoutMs: 20, leaseMs: 2000,
    send: async (_event, options) => { signal = options.signal; return new Promise(() => {}); },
    observe: () => { throw new Error('telemetry down'); } });
  await notifier.kick();
  assert.equal(signal.aborted, true);
  assert.equal((await f.events())[0].last_error, 'timeout');
  await ready(f);
  await createNotifier({ store: f.store, send: async () => {}, observe: () => { throw Error(); } }).kick();
  assert.equal((await f.events()).filter(e => e.state === 'accepted').length, 1);
});

test('real HTTP acceptance is bounded, private, and does not follow redirects', async t => {
  let body, headers, calls = 0;
  const server = createServer(async (req, res) => {
    calls++; headers = req.headers; let raw = '';
    for await (const part of req) raw += part;
    body = JSON.parse(raw);
    if (req.url === '/redirect') { res.writeHead(302, { Location: '/sink' }); res.end(); }
    else if (req.url === '/busy') { res.writeHead(429, { 'Retry-After': '2' }); res.end(); }
    else { res.writeHead(202); res.end(); }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const url = 'http://127.0.0.1:' + server.address().port;
  assert.throws(() => httpRelay({ url }), /HTTPS/);
  assert.throws(() => httpRelay({ url: 'https://test.invalid/?secret=x' }), /HTTPS/);
  const event = { version: 1, type: 'recall.session.completed', event_id: randomUUID(), session_id: randomUUID() };
  const options = { signal: new AbortController().signal, idempotencyKey: event.event_id };
  await httpRelay({ url, allowLoopback: true, token: 'synthetic-token' })(event, options);
  assert.deepEqual(body, event);
  assert.equal(headers['idempotency-key'], event.event_id);
  assert.equal(headers.authorization, 'Bearer synthetic-token');
  await assert.rejects(httpRelay({ url: url + '/busy', allowLoopback: true })(event, options),
    e => e.code === 'http_429' && e.retryAfterMs === 2000 && e.retryable);
  const before = calls;
  await assert.rejects(httpRelay({ url: url + '/redirect', allowLoopback: true })(event, options));
  assert.equal(calls, before + 1);
});

test('kick during drain cleanup gets its own retained drain', async () => {
  const gate = deferred(); let claims = 0, sent = 0, pending = false, followup;
  const notifier = createNotifier({ store: {
    claim: () => { claims++; if (claims === 1) return gate.promise;
      if (!pending) return Promise.resolve(null);
      pending = false;
      return Promise.resolve({ event_id: randomUUID(), session_id: randomUUID(), attempts: 1 }); },
    accepted: async () => true
  }, send: async () => { sent++; } });
  const first = notifier.kick();
  await Promise.resolve(); // start the initial claim
  gate.resolve(null);
  queueMicrotask(() => { pending = true; followup = notifier.kick(); });
  await first; await followup;
  assert.equal(sent, 1);
  assert.equal(pending, false);
});

test('provider retry-after is a minimum even when longer than the backoff cap', async t => {
  let clock = Date.now();
  const f = await fixture({ now: () => clock }); t.after(() => f.close());
  await ready(f); let calls = 0;
  const send = httpRelay({ url: 'https://relay.invalid/', now: () => clock,
    fetchImpl: async () => { calls++; return new Response(null, { status: 429, headers: { 'Retry-After': '600' } }); } });
  const notifier = createNotifier({ store: f.store, send });
  await notifier.kick();
  clock += 60000; await notifier.kick(); assert.equal(calls, 1);
  clock += 540000; await notifier.kick(); assert.equal(calls, 2);
});

test('recovery delivers a due retry without another user action and is bounded', async t => {
  const { recover } = await import('../notifier/recovery.mjs');
  let clock = Date.now();
  const f = await fixture({ now: () => clock }); t.after(() => f.close());
  await ready(f); let calls = 0, sleeps = 0;
  const notifier = createNotifier({ store: f.store, random: () => 0.5, send: async () => {
    if (++calls === 1) throw new RelayError('http_503');
  } });
  await notifier.kick();
  await recover({ notifier, rounds: 3, intervalMs: 250, wait: async ms => { sleeps++; clock += ms; } });
  assert.equal(calls, 2);
  assert.equal(sleeps, 2);
  assert.equal((await f.events())[0].state, 'accepted');
  const controller = new AbortController(); controller.abort();
  assert.equal(await recover({ notifier, signal: controller.signal }), 0);
});

test('lost registration response survives a client reload without a second event', async t => {
  const { manifestOutbox } = await import('../notifier/manifest-outbox.mjs');
  const f = await fixture(); t.after(() => f.close());
  const s = await f.session();
  for (const r of s.reviews) assert.equal((await f.grade(r)).status, 200);
  const data = new Map();
  const storage = { get length() { return data.size; }, key: i => [...data.keys()][i],
    getItem: k => data.get(k) ?? null, setItem: (k,v) => data.set(k,v), removeItem: k => data.delete(k) };
  let calls = 0, sent = 0;
  const notifier = createNotifier({ store: f.store, send: async () => { sent++; } });
  const register = async manifest => {
    await f.store.register({ ...manifest, ownerId: f.ownerId });
    await notifier.kick();
    if (++calls === 1) throw Error('response lost after registration');
  };
  const first = manifestOutbox({ storage, ownerId: f.ownerId, register });
  first.enqueue(s);
  assert.equal((await first.flush()).failures, 1);
  assert.equal(first.entries().length, 1);
  const reloaded = manifestOutbox({ storage, ownerId: f.ownerId, register });
  assert.equal((await reloaded.flush()).failures, 0);
  assert.equal(reloaded.entries().length, 0);
  assert.equal((await f.events()).length, 1);
  assert.equal(sent, 1);
  reloaded.enqueue({ ...s, sessionId: randomUUID() });
  const signedOut = manifestOutbox({ storage, ownerId: f.ownerId, register, active: () => false });
  assert.equal((await signedOut.flush()).paused, true);
  assert.equal(calls, 2);
});

test('disk restart preserves queue and receiver dedup after an ambiguous send', async t => {
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { PGlite } = await import('@electric-sql/pglite');
  const dir = await mkdtemp(join(tmpdir(), 'recall-notifier-'));
  let clock = Date.now(), db;
  t.after(async () => { if (db) await db.close(); await rm(dir, { recursive: true, force: true }); });
  const f = await fixture({ now: () => clock, dataDir: dir });
  db = f.db;
  await ready(f);
  await db.exec('create table receiver_receipts(event_id uuid primary key)');
  let attempts = 0;
  const send = async event => {
    attempts++;
    await db.query('insert into receiver_receipts values($1) on conflict do nothing', [event.event_id]);
  };
  await assert.rejects(createNotifier({
    store: { ...f.store, accepted: async () => { throw Error('crash before acknowledgement'); } }, send
  }).kick(), /crash/);
  await db.close(); db = undefined;
  db = new PGlite(dir);
  clock += 10001;
  await createNotifier({ store: completionStore(db, { now: () => clock }), send }).kick();
  assert.equal((await db.query('select * from receiver_receipts')).rows.length, 1);
  assert.equal((await db.query('select state from flashcards_private.completion_events')).rows[0].state, 'accepted');
  assert.equal(attempts, 2);
});

test('hung manifest registration times out and cannot stall later sessions', async () => {
  const { manifestOutbox } = await import('../notifier/manifest-outbox.mjs');
  const data = new Map();
  const storage = { get length() { return data.size; }, key: i => [...data.keys()][i],
    getItem: k => data.get(k) ?? null, setItem: (k,v) => data.set(k,v), removeItem: k => data.delete(k) };
  const first = { sessionId: randomUUID(), reviewIds: [randomUUID()] };
  const second = { sessionId: randomUUID(), reviewIds: [randomUUID()] };
  let calls = 0, stuck = true, firstSignal;
  const outbox = manifestOutbox({ storage, ownerId: randomUUID(), timeoutMs: 10,
    register: async (manifest, { signal }) => {
      calls++;
      if (stuck && manifest.sessionId === first.sessionId) {
        firstSignal = signal;
        return new Promise(() => {}); // adapter even ignores cancellation
      }
    }
  });
  outbox.enqueue(first); outbox.enqueue(second);
  assert.equal((await outbox.flush()).failures, 1);
  assert.equal(calls, 2);
  assert.equal(firstSignal.aborted, true);
  assert.deepEqual(outbox.entries(), [first]);
  stuck = false;
  assert.equal((await outbox.flush()).failures, 0);
  assert.equal(outbox.entries().length, 0);
});
