import { RelayError } from './dispatcher.mjs';

// Server-configured URL only. No recipient, credentials, owner ID, review IDs,
// card contents, or grades travel in the wake payload.
export function httpRelay({ url, token, allowLoopback = false, fetchImpl = fetch, now = Date.now }) {
  const endpoint = new URL(url);
  const loopback = ['127.0.0.1', '[::1]', 'localhost'].includes(endpoint.hostname);
  if (endpoint.username || endpoint.password || endpoint.hash || endpoint.search
      || (endpoint.protocol !== 'https:' && !(allowLoopback && loopback && endpoint.protocol === 'http:'))) {
    throw new Error('Relay requires a configured HTTPS endpoint');
  }
  return async (event, { signal, idempotencyKey }) => {
    const response = await fetchImpl(endpoint, {
      method: 'POST', signal, redirect: 'error',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey,
        ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(event)
    });
    // Acceptance is not evidence that Dot replied. Avoid waiting for a body.
    void response.body?.cancel().catch(() => {});
    if (response.ok) return;
    const after = response.headers.get('retry-after');
    const delay = after === null ? 0 : /^\d+(\.\d+)?$/.test(after)
      ? Number(after) * 1000 : Date.parse(after) - now();
    if (Number.isFinite(delay) && !Number.isFinite(new Date(now() + delay).getTime())) {
      throw new RelayError('retry_after_out_of_range', { retryable: false });
    }
    throw new RelayError(`http_${response.status}`, {
      retryable: [408, 425, 429].includes(response.status) || response.status >= 500,
      retryAfterMs: Number.isFinite(delay) ? Math.max(0, delay) : 0
    });
  };
}
