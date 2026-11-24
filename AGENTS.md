# Maintaining Neckardt Apps

- Open PRs ready for review unless Nick asks for a draft. Keep exactly one commit, including after revisions, and link directly to the current commit in the PR.
- Track review feedback and closure. Report meaningful updates.
- Rebase-merge only after a formal GitHub approval or an explicit merge instruction from verified `NickEckardt` on the exact current head. Check for later conflicting feedback and guard the merge with the expected head SHA.

This is primarily a single-user personal app. Favor fast development over perfection: accept small, reversible failures and prefer actionable logging and easy recovery to defensive code for every edge case. Preserve baseline auth and data integrity.

Treat the committed SQL migrations as the source of truth for the database schema. Generate TypeScript database types locally and keep them out of Git. A clean build must work without hosted Supabase credentials.

Use `NECKARDT_APPS_*` for configuration shared across apps. Name feature settings for the feature
that owns them.

For Habit Practice UI work, use [hosted fixture users](tests/hosted/README.md) on the app’s existing
Supabase project. Run `npm run test:hosted -- --watch` while editing and `--pair` to check worker
isolation. Exercise candidate migrations locally. Use a separate hosted target when a change needs
a hosted backend rehearsal.
