# Maintaining Neckardt Apps

Follow the [PR skill](.agents/skills/pr/SKILL.md) for every change. Nick reviews changes to skills, SOPs and the controls that implement them. The agent handling a PR owns reviewer dispatch, merge and deployment through verification.

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
