# Test Habit Practice against hosted Supabase

At the checkout root, run `npm run test:hosted -- --watch`. Vite serves your working tree on
localhost. Chromium signs in through the Account menu as a new disposable user in the app’s existing
Supabase project. Press Enter after an edit to seed one due card, reveal it, grade it and finish.
Vite, Chromium and the signed-in session stay warm. A run checks both the grading receipt and the
Saved screen. A plain `npm run test:hosted` runs once and exits.

Use `npm run test:hosted -- --pair` to verify isolation. It signs two users in concurrently, grades
A’s card, reads B’s card back at revision zero, then grades B’s card. Each worker gets a real deck
under its own Auth ID. The shared provisioner marks the current test accounts `habit-practice-v1`.
Habit Practice uses that marker and the matching generated address to authorize deck reset and expiry.

## Enable a hosted target once

1. In the existing Supabase project, check the live migration ledger using the
   [backend rollout notes](../../apps/web/src/apps/habit-practice/README.md#backend-changes).
   Apply the reviewed multi-user enrollment migration and worker fixture migration in order and make
   sure `recall-grade` is deployed. Pages deployment only publishes the frontend. In SQL Editor run
   [expiry.sql](expiry.sql) as the database owner to remove workers older than 48 hours each hour.
2. In Supabase Edge Functions → Secrets, set `NECKARDT_APPS_FIXTURE_PROJECT_REF` and a random
   `NECKARDT_APPS_FIXTURE_KEY` of at least 32 characters. Set the project reference in the deploy
   shell too. From `apps/backend`, deploy with Supabase CLI v3 using
   `supabase functions deploy provision-worker --remote="$NECKARDT_APPS_FIXTURE_PROJECT_REF"`.
   Supabase supplies the admin credential. The worker provides a fresh password. The function
   chooses the account ID and email. Enable email/password sign-in. Public signups may stay disabled.
3. In the private Codex Cloud environment, set `NECKARDT_APPS_FIXTURE_PROJECT_REF` as a regular
   variable. Add the same `NECKARDT_APPS_FIXTURE_KEY` as an HTTP secret for exactly
   `<project-ref>.supabase.co`. Allow task-time HTTPS GET, POST and OPTIONS to that host. Only the
   provision request uses the secret placeholder. Chromium signs in with the disposable password.
   Install Node 24.5+, run `npm ci` and provide Chrome during setup. Set `CHROME_BIN` if needed.
   Start a fresh task and run the pair check. [Codex environment settings](https://learn.chatgpt.com/docs/environments/cloud-environments#configure-environment-variables-and-network-secrets)

Existing environments can keep the prior `HABIT_FIXTURE_*` pair during rollout. Set both new names
together when switching an environment.

The shared project uses the checked-in public app config. For a hosted rehearsal of an incompatible
migration, Auth hook or Edge change, point both `NECKARDT_APPS_SUPABASE_URL` and
`NECKARDT_APPS_SUPABASE_PUBLISHABLE_KEY` at the alternate target. Bind the fixture ref and secret
to that project. Vite picks up frontend edits immediately. Hosted tests exercise the backend deployed
to their target. A future outbound notification should skip fixture users before delivery.
