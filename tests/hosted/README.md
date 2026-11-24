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
2. In Supabase Edge Functions → Secrets, set a random `NECKARDT_APPS_FIXTURE_KEY` of at least
   32 characters. From `apps/backend`, run `supabase link` to select the shared project if needed.
   Deploy with Supabase CLI v3 using `supabase functions deploy provision-worker`.
   Supabase supplies the admin credential. The worker provides a fresh password. The function
   chooses the account ID and email. Enable email/password sign-in. Public signups may stay disabled.
3. In the private Codex Cloud environment, add the same `NECKARDT_APPS_FIXTURE_KEY` as an HTTP
   secret for the exact hostname in the
   [shared public config](../../apps/backend/supabase/functions/_shared/public-config.json).
   Allow task-time HTTPS GET, POST and OPTIONS to that host. The provision request uses the
   secret placeholder. Chromium signs in with the disposable password.
   Install Node 24.5+, run `npm ci` and provide Chrome during setup. Set `CHROME_BIN` if needed.
   Start a fresh task and run the pair check. [Codex environment settings](https://learn.chatgpt.com/docs/environments/cloud-environments#configure-environment-variables-and-network-secrets)

The shared project needs only the fixture key on each side. Existing installations can keep their
`HABIT_FIXTURE_KEY` and `HABIT_FIXTURE_PROJECT_REF` pair until the updated function is deployed.

For an alternate hosted project, set `NECKARDT_APPS_FIXTURE_PROJECT_REF` on both the Edge function
and runner. Scope that project’s fixture secret to its exact hostname. Set the runner’s
`NECKARDT_APPS_SUPABASE_URL` and `NECKARDT_APPS_SUPABASE_PUBLISHABLE_KEY` to its public values.
Vite picks up frontend edits immediately. Hosted tests exercise the backend deployed to their target.
A future outbound notification should skip fixture users before delivery.
