# Test Habit Practice against hosted Supabase

At the checkout root, run `npm run test:hosted -- --watch`. Vite serves your working tree on
localhost. Chromium signs in through the Account menu as a new disposable user in the app’s existing
Supabase project. Press Enter after an edit to seed one due card, reveal it, grade it and finish.
Vite, Chromium and the signed-in session stay warm. A run checks both the grading receipt and the
Saved screen. A plain `npm run test:hosted` runs once and exits.

Use `npm run test:hosted -- --pair` to verify isolation. It signs two users in concurrently, grades
A’s card, reads B’s card back at revision zero, then grades B’s card. Each worker gets a real deck
under its own Auth ID. Reset uses the signed-in ID. Only users marked by the provisioner with their
matching generated address qualify for reset or expiry. Ordinary users have the usual app behavior.

## Enable a hosted target once

1. In the existing Supabase project, check the live migration ledger using the
   [backend rollout notes](../../apps/web/src/apps/habit-practice/README.md#backend-changes).
   Apply the reviewed multi-user enrollment migration and worker fixture migration in order and make
   sure `recall-grade` is deployed. Pages deployment only publishes the frontend. In SQL Editor run
   [expiry.sql](expiry.sql) as the database owner to remove workers older than 48 hours each hour.
2. Set `HABIT_FIXTURE_PROJECT_REF` and a random `HABIT_FIXTURE_KEY` (at least 32 characters) under
   Supabase Edge Functions → Secrets. Set the project reference in the deploy shell too. From
   `apps/backend` run `supabase functions deploy provision-worker --remote="$HABIT_FIXTURE_PROJECT_REF"`
   with Supabase CLI v3. Supabase provides the admin credential to the
   function. The worker provides a fresh password and the function chooses the account ID and email.
   Email/password sign-in must be enabled. Public signups may stay disabled.
3. In the private Codex Cloud environment set the same `HABIT_FIXTURE_PROJECT_REF` as a regular
   variable. Add `HABIT_FIXTURE_KEY` as an HTTP secret for exactly `<project-ref>.supabase.co`.
   Allow task-time HTTPS GET, POST and OPTIONS to that host. Only the provision request uses the
   secret placeholder. Chromium signs in with the disposable password. Install Node 24.5+, run
   `npm ci` and provide Chrome during setup. Set `CHROME_BIN` if needed. Start a fresh task and run
   the pair check. [Codex environment settings](https://learn.chatgpt.com/docs/environments/cloud-environments#configure-environment-variables-and-network-secrets)

The shared project uses the checked-in public app config. For a hosted rehearsal of an incompatible
migration, Auth hook or Edge change, point both `RECALL_SUPABASE_URL` and
`RECALL_SUPABASE_PUBLISHABLE_KEY` at the alternate target and bind its fixture ref and secret there.
Vite picks up frontend edits immediately. Hosted tests exercise the backend version deployed to their
target. A future outbound notification should skip fixture users before delivery.
