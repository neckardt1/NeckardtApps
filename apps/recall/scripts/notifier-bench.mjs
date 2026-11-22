import { createServer } from 'node:http';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { fixture } from '../notifier/fixture.mjs';
import { createNotifier, wakeAfterSave } from '../notifier/dispatcher.mjs';
import { httpRelay } from '../notifier/http-relay.mjs';

const samples = Number(process.env.NOTIFIER_SAMPLES ?? 40);
if (!Number.isInteger(samples) || samples < 1 || samples > 500) throw Error('NOTIFIER_SAMPLES must be 1..500');
const fixtureDb = await fixture();
const receipts = new Map(), runs = [];
const status = 202;
const relay = createServer(async (req, res) => {
  let body = '';
  for await (const part of req) body += part;
  const event = JSON.parse(body);
  if (req.headers['idempotency-key'] !== event.event_id) { res.writeHead(400); res.end(); return; }
  if (!receipts.has(event.event_id)) receipts.set(event.event_id, performance.now());
  res.writeHead(status); res.end();
});
relay.listen(0, '127.0.0.1'); await once(relay, 'listening');
const send = httpRelay({ url: 'http://127.0.0.1:' + relay.address().port, allowLoopback: true });
const ackTimes = new Map();
const notifier = createNotifier({ store: fixtureDb.store, send, observe: event => {
  if (event.stage === 'relay_accepted') ackTimes.set(event.event_id, performance.now());
} });
let retained = [];
fixtureDb.setWake(wakeAfterSave(notifier, promise => retained.push(promise)));
const summary = values => {
  const sorted = [...values].sort((a,b) => a-b);
  const at = p => Number(sorted[Math.max(0, Math.ceil(sorted.length*p)-1)].toFixed(2));
  return { p50_ms: at(0.5), p95_ms: at(0.95), max_ms: at(1) };
};
try {
  // Warmup is explicitly excluded. The measured path includes the actual
  // grading handler, FSRS, SQL commit, claim, localhost HTTP and SQL ack.
  for (let i = -1; i < samples; i++) {
    const s = await fixtureDb.session(1); retained = [];
    const tap = performance.now();
    // Registration starts on the last tap while the grade request runs.
    const registration = fixtureDb.store.register(s).then(async eventId => {
      retained.push(notifier.kick()); return eventId;
    });
    const response = await fixtureDb.grade(s.reviews[0]);
    if (response.status !== 200) throw Error('Grade did not save');
    const savedAck = performance.now();
    const eventId = await registration;
    await Promise.all(retained);
    const finished = performance.now();
    if (!receipts.has(eventId)) throw Error('Missing relay receipt');
    if (i >= 0) runs.push({ tap_to_save_ack_ms: savedAck - tap,
      tap_to_local_relay_ms: receipts.get(eventId) - tap,
      tap_to_persisted_relay_ack_ms: ackTimes.get(eventId) - tap,
      tap_to_dispatch_drain_ms: finished - tap });
  }
  // Same pipeline with deliberately introduced 100ms dispatch delay, to make
  // scheduling overhead visible. This is a controlled comparison, not an old
  // implementation or a measured Gmail polling interval.
  const controlled = [];
  fixtureDb.setWake(() => {});
  for (let i = 0; i < Math.min(samples, 20); i++) {
    const s = await fixtureDb.session(1);
    const tap = performance.now();
    const id = await fixtureDb.store.register(s);
    const response = await fixtureDb.grade(s.reviews[0]);
    if (response.status !== 200) throw Error('Grade did not save');
    await delay(100); await notifier.kick();
    controlled.push(receipts.get(id) - tap);
  }
  console.log(JSON.stringify({
    environment: 'warm local PGlite + actual recall-grade/FSRS + loopback HTTP; synthetic one-card sessions; no browser/Auth/grade-network or hosted cold starts',
    samples, warmup_excluded: 1, stages: Object.fromEntries(
      Object.keys(runs[0]).map(k => [k, summary(runs.map(r => r[k]))])),
    controlled_100ms_dispatch_delay: { samples: controlled.length, ...summary(controlled) },
    external_stages: { gmail_delivery: 'not measured', dot_wake: 'not measured', dot_debrief: 'not measured' }
  }, null, 2));
} finally {
  relay.closeAllConnections();
  await new Promise(resolve => relay.close(resolve));
  await fixtureDb.close();
}
