const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Integration helper for the rebuilt UI, not enabled in the current app.
// Keep the completion manifest durable independently of the rating outbox.
export function manifestOutbox({ storage, ownerId, register, active = () => true, timeoutMs = 5000 }) {
  if (!uuid.test(ownerId)) throw Error('Invalid owner');
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 60000) throw Error('Invalid registration timeout');
  const prefix = 'recall.completion.' + ownerId.toLowerCase() + '.';
  let running, requested = false;
  function canonical({ sessionId, reviewIds }) {
    if (!uuid.test(sessionId) || !Array.isArray(reviewIds) || reviewIds.length < 1
        || reviewIds.length > 5 || reviewIds.some(id => !uuid.test(id))) throw Error('Invalid manifest');
    const ids = reviewIds.map(x => x.toLowerCase()).sort();
    if (new Set(ids).size !== ids.length) throw Error('Duplicate reviews');
    return { sessionId: sessionId.toLowerCase(), reviewIds: ids };
  }
  function entries() {
    const out = [];
    for (let i = 0; i < storage.length; i++) {
      const key = storage.key(i);
      if (key?.startsWith(prefix)) {
        const manifest = canonical(JSON.parse(storage.getItem(key)));
        if (key !== prefix + manifest.sessionId) throw Error('Corrupt manifest key');
        out.push(manifest);
      }
    }
    return out;
  }
  return {
    enqueue(input) {
      const manifest = canonical(input), key = prefix + manifest.sessionId;
      const old = storage.getItem(key);
      if (old && old !== JSON.stringify(manifest)) throw Error('Session manifest changed');
      storage.setItem(key, JSON.stringify(manifest)); // Throw on quota failure; don't report a queued wake.
      return manifest;
    },
    entries,
    flush() {
      requested = true;
      if (running) return running;
      running = Promise.resolve().then(async () => {
        const attempted = new Set(); let failures = 0;
        try {
          do {
            requested = false;
            for (const manifest of entries()) {
              if (!active()) return { failures, paused: true };
              if (attempted.has(manifest.sessionId)) continue;
              attempted.add(manifest.sessionId);
              let timer;
              const controller = new AbortController();
              try {
                // Authenticated server supplies owner identity. A timeout is
                // ambiguous: retain the stable manifest even if it later saves.
                const deadline = new Promise((_, reject) => {
                  timer = setTimeout(() => { reject(Error('Registration timeout')); controller.abort(); }, timeoutMs);
                });
                await Promise.race([Promise.resolve().then(() => register(manifest,
                  { signal: controller.signal })), deadline]);
                storage.removeItem(prefix + manifest.sessionId);
              } catch { failures++; }
              finally { clearTimeout(timer); }
            }
          } while (requested);
          return { failures, paused: false };
        } finally { running = undefined; }
      });
      return running;
    }
  };
}
