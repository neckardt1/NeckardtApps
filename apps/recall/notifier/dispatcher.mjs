export class RelayError extends Error {
  constructor(code, { retryable = true, retryAfterMs = 0 } = {}) {
    super(code); this.code = code; this.retryable = retryable; this.retryAfterMs = retryAfterMs;
  }
}

export function createNotifier({ store, send, timeoutMs = 1500, leaseMs = 10000,
  maxAttempts = 5, maxBatch = 20, random = Math.random, observe = () => {} }) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || !Number.isFinite(leaseMs)
      || leaseMs <= timeoutMs + 1000 || !Number.isInteger(maxAttempts) || maxAttempts < 1
      || !Number.isInteger(maxBatch) || maxBatch < 1) throw new Error('Invalid notifier limits');
  let running, requested = false;
  const emit = data => { try { observe(data); } catch { /* Telemetry cannot change delivery. */ } };
  async function deliver(event) {
    const controller = new AbortController();
    let timer;
    const started = performance.now();
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => { reject(new RelayError('timeout')); controller.abort(); }, timeoutMs);
    });
    try {
      // Bound even an adapter that ignores AbortSignal. A late remote acceptance
      // is safe only if the receiver persists idempotency under the event ID.
      await Promise.race([Promise.resolve().then(() => send({
        version: 1, type: 'recall.session.completed', event_id: event.event_id,
        session_id: event.session_id
      }, { signal: controller.signal, idempotencyKey: event.event_id })), timeout]);
    } catch (error) {
      clearTimeout(timer);
      const known = error instanceof RelayError;
      const code = known ? error.code : 'transport_error';
      const retryMs = Math.max(known ? error.retryAfterMs : 0, Math.min(60000,
        250 * 2 ** Math.min(8, event.attempts - 1) * (0.75 + 0.5 * random())));
      await store.failed(event, { code, retryMs, maxAttempts, retryable: !known || error.retryable });
      emit({ event_id: event.event_id, stage: 'relay_error', code, attempt: event.attempts,
        duration_ms: performance.now() - started });
      return;
    } finally { clearTimeout(timer); }
    // An acknowledgement DB error leaves the lease for recovery, rather than
    // pretending the already accepted send failed. Reuse the same remote key.
    const acknowledged = await store.accepted(event);
    emit({ event_id: event.event_id, stage: acknowledged ? 'relay_accepted' : 'stale_ack',
      attempt: event.attempts, duration_ms: performance.now() - started });
  }
  return {
    // Kick after manifest registration AND durable grade commit/replay; retain
    // the promise with EdgeRuntime.waitUntil. Also run bounded crash recovery.
    kick() {
      requested = true;
      if (running) return running;
      running = Promise.resolve().then(async () => {
        try {
        let count = 0;
        do {
          requested = false;
          while (count < maxBatch) {
            const event = await store.claim({ leaseMs, maxAttempts });
            if (!event) break;
            count++;
            await deliver(event);
          }
        } while (requested && count < maxBatch);
        return count;
        } finally { running = undefined; }
      });
      return running;
    }
  };
}

// Wake failures must never turn a successful grade save into a client error.
// Queue recovery is required: waitUntil is not a durable job scheduler.
export function wakeAfterSave(notifier, retain = () => {}, onError = () => {}) {
  return () => {
    const report = () => { try { onError('notifier_wake_failed'); } catch {} };
    try { retain(notifier.kick().catch(report)); } catch { report(); }
  };
}
