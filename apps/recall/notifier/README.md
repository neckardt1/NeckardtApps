# Recall notifier latency experiment

This fork supplies a locally tested completion queue, immediate dispatcher, and
reproducible latency harness. It is **not deployed or enabled in Recall**.
The existing grade handler gains an optional `afterSave` callback with a no-op
default; the browser and hosted Edge entry point do not enable it.

## What changed

The browser integration helper persists an immutable completion manifest on the
last tap. Registration can overlap the last grade save. The SQL claim only
releases an event when **every listed review is present for the configured
owner**, including when registration arrives after the saves. Both registration
and a successful grade save/replay should immediately kick the dispatcher.
The saved response does not await relay delivery.

Each event has one stable ID. Atomic claims, leases and fencing tokens prevent
overlapping workers from acknowledging each other's work. Timeout, retryable
HTTP failures and ambiguous acknowledgements retain that ID. Exponential
backoff is bounded; a provider's longer Retry-After remains a minimum.
A final crashed attempt is marked `delivery_unknown`, not falsely delivered.
Malformed/conflicting manifests are rejected and reviews cannot be reused
across sessions.

The wake body contains only version/type and opaque event/session IDs. It has
no card text, grade, owner address or credentials. The relay URL and bearer
credential are server configuration, redirects are refused, and response
bodies are not needed for acceptance.

## Run locally

From the repository root, using Node 24:

```sh
npm ci --prefix apps/recall
node --test apps/recall/tests/notifier.test.mjs
node apps/recall/scripts/notifier-bench.mjs
```

`NOTIFIER_SAMPLES` optionally sets 1–500 measured samples (default 40).
The benchmark starts and closes its own loopback-only HTTP receiver; it sends
nothing to Gmail, Dot, Supabase or any external recipient. Fixture cards are
generated locally. `schema.sql` is an experiment fixture, not a migration;
do not apply it to the live project.

The normal `npm --prefix apps/recall test` discovers these tests, so existing PR
checks exercise them. Pages builds continue to contain only frontend assets.

## Measured result

[Raw benchmark result](benchmark-result.json), 40 warm synthetic one-card sessions,
one excluded warmup, actual local grade handler + FSRS + PostgreSQL through
PGlite + loopback HTTP. Durations use one process's monotonic clock.

| Stage from simulated final tap | p50 | p95 | Maximum |
| --- | ---: | ---: | ---: |
| Save response | 3.02 ms | 5.45 ms | 6.63 ms |
| Local relay receipt | 4.58 ms | 9.18 ms | 10.52 ms |
| Persisted relay acknowledgement | 5.33 ms | 10.90 ms | 12.46 ms |
| Worker drain complete | 7.66 ms | 14.49 ms | 18.16 ms |

A separate 20-sample run deliberately inserted 100 ms before dispatch:
106.36 ms median and 108.07 ms p95 to local relay receipt. This isolates
scheduling delay; it is not a measurement of a previous notifier or Gmail.

These numbers **exclude** browser scheduling, a network request to the grading
endpoint, real Auth, hosted Supabase latency/cold starts, Gmail delivery, Dot's
wake, and debrief generation/delivery. They do not establish a sub-five-second
live debrief. `recorded_at` is database transaction time, not a commit timestamp;
`ready_observed_at` is queue observation time. Neither is used as a substitute
for the monotonic measurements above.

## Verification and adversarial review

All 24 repository tests pass: 16 notifier cases, 2 existing SQL/session cases,
4 React cases and 2 Pages cases. TypeScript checking and the Vite/Pages
production build pass.

Coverage includes delayed final persistence, rejected/conflicting grades,
registration before/after saves, duplicate/reordered manifests, review reuse,
browser-role denial, save-response independence, both worker cleanup races,
overlapping workers, lease fencing, ack loss, retry delays/limits, stuck
adapters, redirect rejection, recovery without another user action, offline
registration after client reload, and on-disk database close/reopen with a
persistent receiver receipt.

An independent adversarial review found a lost-wake microtask gap and premature
retries for long Retry-After values. Both have regression tests and fixes. A follow-up review caught an unbounded
client registration request; registration now has a deadline and a regression
test proving a hung adapter cannot stall subsequent sessions.
The disk-restart test proves this local receiver's idempotent receipt, not
exactly-once real Dot messages.

## Integration contract and remaining live work

1. Wire `manifestOutbox` into the rebuilt UI using the same stable session and
   review IDs as the rating outbox. Persist the manifest before issuing its
   registration request; retry on reconnect/reload while the same owner is
   active. Keep notification status separate from ratings-saved status.
   Storage failure/corruption must be surfaced, not reported as a queued wake.
   Use the server-authenticated owner identity; never trust a browser owner ID.
2. Turn the private SQL adapter into reviewed, narrowly granted server RPCs.
   The fixture grants no browser or service-role direct table access. It is
   deliberately not a deployable Supabase migration or exposed endpoint.
   Verify real PostgreSQL multi-connection isolation separately: PGlite runs a
   single embedded connection, so local overlap tests do not prove hosted lock
   scheduling. A missing/conflicted review intentionally keeps its manifest
   waiting; production also needs an explicit abandon/retention policy.
3. Wire `afterSave: wakeAfterSave(notifier, task => EdgeRuntime.waitUntil(task))`
   and an equivalent kick after successful manifest registration.
   `recover({ notifier, rounds, intervalMs, signal })` is a bounded worker for
   missed wakes, expired leases and due retries. It returns **processed
   attempts**, not delivery count. A supervisor must restart/reschedule it,
   including after database exceptions and when a bounded run ends.
   No recovery schedule is installed by this fork.
4. Configure an authorized HTTPS relay and real Gmail/Dot event subscription.
   The relay/consumer must authenticate the wake, read the persisted session
   through an owner-authorized path, and durably deduplicate the event ID.
   This notifier provides **at-least-once delivery attempts**; an idempotent
   HTTP header alone cannot guarantee one downstream debrief.
5. Run an explicitly scoped live test with isolated test reviews (or an
   approved copy of real cards), without changing live review history.
   Record correlated final tap, server save confirmation, relay acceptance,
   Gmail receipt, Dot start and debrief delivery. Use monotonic durations
   within each runtime; report cross-host clock uncertainty. Include warm,
   cold/idle, duplicate and lost-response samples, then report p50/p95 and
   failures for each stage. Relay acceptance must never stand in for debrief
   delivery.

No live notifier/relay was present in the inspected workspace or hosted
function list. An existing relay location was requested in the fork; absent
that setup, live wake/debrief latency remains unmeasured.

Supabase's [background-task documentation](https://supabase.com/docs/guides/functions/background-tasks)
describes `waitUntil` and its runtime limits; it is not a durable queue.
[Database webhooks](https://supabase.com/docs/guides/database/webhooks) can supply
an asynchronous event source after a completion row changes, with recovery
still needed for failures.
