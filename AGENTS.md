# Maintaining Neckardt Apps

- Open PRs ready for review unless Nick asks for a draft. Keep exactly one commit, including after revisions, and link directly to the current commit in the PR.
- Track review feedback and closure. Report meaningful updates.
- Rebase-merge only after a formal GitHub approval or an explicit merge instruction from verified `NickEckardt` on the exact current head. Check for later conflicting feedback and guard the merge with the expected head SHA.

## Supabase deploy handoff

- When a PR is ready, the worker sends Dot the PR link, whether a Supabase deploy is needed, and any prerequisites.
- Dot keeps one private record per release with the PR, exact reviewed commit, original worker thread, and Nick’s deploy authorization or its pending status. A plain merge instruction authorizes only the merge.
- Once the existing watcher verifies that the reviewed change merged and required CI passed for the release commit, Dot sends the release back to the original thread if Nick explicitly authorized that deploy. Otherwise, keep it pending.
- The worker follows the [Supabase deploy skill](.agents/skills/supabase-deploy/SKILL.md) and reports what shipped, smoke-test results, and any blockers to Dot. Dot updates the same record.

This is primarily a single-user personal app. Favor fast development over perfection: accept small, reversible failures and prefer actionable logging and easy recovery to defensive code for every edge case. Preserve baseline auth and data integrity.

Treat the committed SQL migrations as the source of truth for the database schema. Generate TypeScript database types locally and keep them out of Git. A clean build must work without hosted Supabase credentials.

Use `NECKARDT_APPS_*` for configuration shared across apps. Name feature settings for the feature
that owns them.

For Habit Practice UI work, use [hosted fixture users](tests/hosted/README.md) on the app’s existing
Supabase project. Run `npm run test:hosted -- --watch` while editing and `--pair` to check worker
isolation. Put feature-specific checks in a named hosted scenario and run it with `--scenario <name>`.
In the saved Cloud environment, use the [documented Chromium filesystem permission](tests/hosted/README.md#run-in-the-saved-neckardtapps-cloud-environment)
for both modes. Exercise candidate migrations locally. Use a separate hosted target when a change needs
a hosted backend rehearsal.
