# Apps and Habit Practice

A public launcher and Habit Practice share one unbranded Apps/Account shell,
app registry, styles, and Supabase session. Habit Practice uses the existing
`/recall/` URL and the existing internal `recall` identifiers and storage keys.
The launcher stays public; signing in does not grant access to any app's data.
Each feature/backend enforces its own authorization.

## Local development and checks

Requires Node.js 24.

```sh
npm ci
npm run typecheck
npm test
npm run build
npm run dev
```

One top-level React + TypeScript + Vite build emits `index.html`,
`recall/index.html`, and `oauth/consent/index.html` at matching paths within
`_site/`. Navigation uses ordinary links and full page loads, without a router.
Relative asset paths and explicit `appsHref` values support both `/`
and `/NeckardtApps/`, including direct `index.html` URLs. The root workspace
installs the pinned backend test dependencies under `apps/recall/`.

Tests use only synthetic fixtures. They exercise shared session identity,
launcher-to-practice navigation, exact resume, pending saves, owner changes,
keyboard focus, safe formatting, the actual Edge handler, FSRS, and SQL/ACL
compatibility. HTTP tests serve the production artifact at both base paths and
verify that the launcher and OAuth consent page do not load review code. No live
account or data is needed. Browser emulation is not a real iOS WebKit/soft-keyboard test.

The build refuses an existing output path. Build to a new directory or deliberately
remove only generated output. Source maps and automatic public-directory copying
are disabled. Backend files, tests, private fixtures, and standalone configuration
are excluded from the published artifact.

## Shared session and feature boundaries

`SiteRoot` owns the shared Apps/Account UI; feature code lives outside it.
The launcher and Habit Practice entries use one shared SDK client getter and the
unchanged Supabase project-based session storage convention. Same-origin pages
share the session; different hostnames and browser profiles do not. Local-scope sign-out leaves
unrelated browser data and queued review responses intact.

The separate OAuth consent entry uses its own memory-only canary session. It does
not replace or clear the shared Account session or queued practice responses.

The session observer supplies identity. A generation guard invalidates old work
synchronously when identity changes, including a rapid owner A to B to A switch.
A same-owner token refresh retains the active review. Each app still handles
server-enforced access failures; browser identity is not an authorization grant.

The shared Account form preserves its focus behavior and pinch zoom. Its inputs
have a minimum 16px font to mitigate focus zoom on affected iOS Safari versions;
this is a compatibility precaution, not a claim of actual-device verification.

`public-config.json` contains only the existing browser-safe URL and publishable
key. Optional build overrides retain `RECALL_SUPABASE_URL` and
`RECALL_SUPABASE_PUBLISHABLE_KEY`; set both. Secret keys and malformed hosts fail
validation before output creation.

## Durable practice flow

Today starts or resumes the saved round. Provisioned habit opportunities precede
recall and use Yes, No, No opportunity, or Skip independently of recall grading.
Reveal shows safely formatted answers; Again, Hard, Good, and Easy advance after
the response is durably recorded. Apps/Account popovers suppress review shortcuts.

Progress, original event IDs, pending responses, and verified acknowledgments
live in one owner-scoped atomic record, with Web Locks coordinating tabs.
Leaving for the launcher or signing out stops further drains, preserves pending
responses, and never completes the round. Returning restores the exact revealed
card after Resume, including an earlier uncertain grade awaiting replay.
Unsupported/conflicting responses remain preserved for reconciliation. Finish
requires verified saves and an explicit action; Debrief with Dot is optional.

## Release prerequisites and recovery

This frontend candidate does not apply migrations, deploy Edge Functions, change
live data, or enable notifications. Keep the published maintenance route in place
until a separate release is approved. PR checks build without publishing; a push
to `main` triggers Pages deployment and therefore belongs to the release decision.

The additive compatibility migration
`apps/recall/supabase/migrations/20261122013041_recall_opportunities.sql` is the
reviewed backend prerequisite. It adds the private opportunity/response contract
and required `recall_due` read API while preserving the legacy due RPC signature,
row shape, default/client limits, owner access, and ACL. The new frontend fails
closed if the required read API is absent. The existing `recall-grade` Edge
Function source is unchanged; no Edge deployment is required by this candidate.

Before a separately authorized migration/frontend rollout, pause/close cached
old clients and preserve their pending data without draining them against the
old permissive backend. An already-open old tab may retain an
unsupported card: grading it after the migration returns a conflict and keeps the
original response; it must not be translated into a habit result or silently
removed. Old tabs can also create V1 keys after V2 initializes, so coordinate their
closure/reload and reconciliation rather than clearing browser storage.
After old clients are paused, apply the reviewed backward-compatible database
guard/bridge and verify it with separately authorized checks. Only then replay
supported original events with a controlled recovery/new client, retaining
unsupported conflicts for explicit reconciliation. Release the reviewed frontend
after these prerequisites. No live production apply or validation is performed
by this local test suite.

To take the new frontend offline again, separately review a revert of the
integration commit. That restores the prior scriptless maintenance entry and
shared launcher without a database rollback. Do not automatically reverse the
additive migration or clear browser data: doing so may discard responses or break
cached/new clients. Already-open tabs are not revoked by a frontend rollback.
Revalidate backend compatibility and cached-client handling for any later rollout.

Keep Supabase migrations and Edge/backend files source-only; never publish them
as site assets or rerun historical migrations on a provisioned database. Do not commit live seeds, credentials, cards, or history.

## OAuth consent for the Recall canary

The registered ChatGPT client sends its OAuth request to Supabase. Supabase sends the browser to
`/oauth/consent/?authorization_id=…`. Sign in with the dedicated synthetic project user to see the
requesting app, scopes and return address. Allow or deny sends the decision to Supabase, which
returns the callback URL for the browser. The page holds the test session in memory.

1. Register the OAuth client manually in Supabase with its exact callback. For a local PKCE pilot,
   use a `http://127.0.0.1:<port>/<path>` callback. For ChatGPT, copy its HTTPS callback from the
   connection setup and update both the client registration and the build variable. Provision a
   dedicated synthetic Auth user with an email and password. The MCP resource must independently
   verify the token issuer, audience, client ID and synthetic user.
2. Set the GitHub Actions repository variables `RECALL_CANARY_CLIENT_ID`, `RECALL_CANARY_USER_ID`
   and `RECALL_CANARY_CALLBACK_URL`. These are public identifiers embedded in the Pages build.
   Keep client secrets and user credentials in their respective private stores.
3. Build and deploy Pages. Open `https://apps.neckardt.com/oauth/consent/` to check the route.
   Set Supabase Auth Site URL to `https://apps.neckardt.com` and its OAuth Authorization Path to
   `/oauth/consent/`. Changing Site URL also changes defaults for other Auth redirects.
4. Start a fresh connection in ChatGPT. If Supabase reports previous consent, revoke the canary
   user's existing grant and reconnect. A previous grant response omits the client ID needed to
   verify the request. Rebuilding without the three variables disables the consent form.

For a pre-merge test on the browser's own computer, build with `VITE_CANARY_CLIENT_ID`,
`VITE_CANARY_USER_ID` and `VITE_CANARY_CALLBACK_URL` in the local environment, then serve
`_site/` on `localhost:3000` and use that origin as the Supabase Site URL. Only use this method
when the intended browser can reach this loopback address.
