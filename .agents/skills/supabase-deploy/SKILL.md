---
name: supabase-deploy
description: Release reviewed NeckardtApps migrations and Edge Functions through the Supabase connector after the PR skill's checks.
---

# Deploy the Supabase backend

1. **Treat a reviewed merge as the release gate.** After the required reviews and CI pass and the change merges, deploy its exact approved scope without asking again. Identify the hosted project, merged SHA on `main`, migration files and affected Edge Functions. Don't pick up unrelated migrations. Respect holds and any narrower direction. Destructive changes still need explicit approval and a verified backup covering the affected data.
2. **Use the Supabase connector first.** Read the migration text at the merged SHA. Check the live migration ledger and affected objects before writing. The connector assigns its own hosted migration timestamp, so use the migration name and SHA-256 of the SQL (trim outer whitespace only) to recognize an exact match. Skip a verified repeat; stop on conflicting SQL, unexpected drift, or evidence of partial application. The connector doesn't have a dry run: use the reviewed disposable-database test plus these live checks, not a production apply as a test.
3. **Apply only the reviewed files, one at a time in dependency order.** After each apply, verify the new ledger row, SQL digest and expected live objects. For affected Edge Functions, use the exact reviewed source, dependencies and config, preserve the checked JWT setting, and verify required secret names without showing values. Use the established CLI path if the connector cannot safely perform a step: link the verified project, compare the linked dry run to the exact release set, and stop on a mismatch instead of repairing history. Verify affected function versions and smoke-test through the app or a disposable fixture; distinguish a smoke test from actual consent or delivery.
4. **Record the release.** Keep the project, merged SHA, Git migration filenames, hosted versions, SQL digests and verification result together. If anything fails, inspect what actually applied before retrying or continuing. Never replay a migration just because its hosted timestamp differs from Git.
