---
name: supabase-deploy
description: Release reviewed NeckardtApps database migrations and Edge Functions to Supabase when Nick explicitly asks to deploy. Use for manual release preparation, execution, and verification.
---

# Deploy the Supabase backend

1. Identify the target project ref, release SHA on main, reviewed migrations and affected function names (including consumers of changed shared code). Verify the reviewed changes are merged and required CI passed for the release. Use a clean checkout pinned to that SHA. PR approval and green CI alone authorize no hosted changes. Proceed with a hosted release only on Nick’s explicit deploy instruction covering this target and scope.
2. At the repo root run `npm ci` and `npm run db:types` before shipping functions. Run Supabase CLI commands from `apps/backend/`. Link the checkout with `supabase link --project-ref "$PROJECT_REF"` using the verified hosted ref. The config's local project ID is not the hosted ref. Check that required secret names exist without printing their values.
3. Run `supabase migration list --linked` and `supabase db push --linked --dry-run`. Compare the pending versions to the approved SQL. For previously hand-applied SQL, verify the affected live objects or data before treating a migration as pending. Stop on unexplained drift, a partially applied migration, or extra pending SQL. Report the discrepancy for reconciliation before pushing or repairing history.
4. Apply the matching pending migrations with `supabase db push --linked`. Deploy each scoped function with `supabase functions deploy "$FUNCTION" --project-ref "$PROJECT_REF"` using the committed configuration. If a step fails, record what succeeded and recheck live state before resuming.
5. Recheck migration history and deployed function versions. Exercise the changed behavior using a read-only request or an approved fixture. For the one-round Dot debrief, distinguish an endpoint smoke check from an actual opted-in round and confirmed delivery. Report target, SHA, migration IDs, function versions, smoke result, and anything still unverified.
