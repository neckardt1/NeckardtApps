import { setTimeout as delay } from 'node:timers/promises';

// Bounded, code-only recovery for missed wakes, crashes, and due retries.
// A deployed worker/scheduler must invoke this; Edge waitUntil is not durable.
export async function recover({ notifier, intervalMs = 1000, rounds = 60, signal,
  wait = (ms, signal) => delay(ms, undefined, { signal }) }) {
  if (!Number.isInteger(rounds) || rounds < 1 || rounds > 3600
      || !Number.isFinite(intervalMs) || intervalMs < 1 || intervalMs > 60000) {
    throw new Error('Invalid recovery limits');
  }
  let processedAttempts = 0;
  for (let i = 0; i < rounds; i++) {
    if (signal?.aborted) break;
    processedAttempts += await notifier.kick();
    if (i + 1 < rounds) {
      try { await wait(intervalMs, signal); }
      catch (error) { if (signal?.aborted) break; throw error; }
    }
  }
  return processedAttempts;
}
