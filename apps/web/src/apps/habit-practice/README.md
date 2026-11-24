# Habit Practice

The app lives at `/recall/`. The [review UI](./) owns rounds
and responses. The [shared shell](../../shell/) owns navigation and sign-in.

## Saved rounds and recovery

The browser keeps an owner-scoped record of the round, original event IDs,
pending responses, and verified acknowledgments. Leaving the app or signing out
preserves that record. Resume restores it; retries reuse the original event IDs.
Do not clear browser storage to resolve a failed save: it can discard answers.
Keep unsupported or conflicting responses for explicit reconciliation rather
than translating them to a different grade or habit result.

## Backend changes

SQL migrations and the grading function live in [the backend workspace](../../../../backend/supabase/). Pages deployment
does not apply either. Before shipping a frontend that requires a new API,
apply and verify the compatible backend change first. Coordinate reloads of
cached clients when a backend contract changes, preserving pending responses.
Check the live migration ledger before applying a migration; do not rerun an
old filename just because its ledger ID differs.

A frontend rollback does not roll back the database or revoke already-open
tabs. Preserve additive schema changes and browser data; check compatibility
before resuming reviews. Never commit live cards, review history, or credentials.

The canary consent page has its own [OAuth setup](../../oauth/README.md).
