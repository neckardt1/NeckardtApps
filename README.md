# Apps

A public app launcher with a reusable Apps/Account shell. The display name
**Habit Practice** points to the existing `/recall/` URL; internal identifiers
and storage/auth keys are unchanged. Its maintenance page remains scriptless and
identical to the approved offline baseline. The review rebuild is separate work.

## Local development and checks

Requires Node.js 24.

```sh
npm ci
npm run typecheck
npm test
npm run build
npm run dev
```

There is one top-level React + TypeScript + Vite frontend build. The root workspace
also installs the pinned backend test dependencies under `apps/recall/`.
`npm test` runs shared-auth and HTTP artifact tests, synthetic React/session
tests, and the unchanged Edge/FSRS/SQL backend integration assertions.
No live account, card, database, or review data is needed for these tests.

The two real HTML entries are `index.html` and `recall/index.html`. They publish
to `_site/index.html` and `_site/recall/index.html`. Navigation uses ordinary
links and full page loads, with no router. Vite uses relative asset paths.
The maintenance HTML was moved to its top-level entry without content changes
and must remain byte-identical after building.

The build validates browser-safe configuration and refuses an existing output
path. Build into a new directory, or deliberately remove only generated output.
It disables automatic public-directory copying and source maps. No backend,
test, source, or standalone configuration file belongs in the published artifact.

## Shared shell and sessions

The launcher renders its app list immediately, even if Account is unavailable,
still loading, or fails. Sign-in is optional for browsing the launcher.
The unbranded shell keeps Apps on the left, Account on the right, and no title
in the middle. The app registry supplies display names, paths, and status.

Future scripted page entries can render their content within `SiteRoot`.
Pass `appsHref="./"` at the launcher and `appsHref="../"` in a single-level app
entry. This keeps both the default `/NeckardtApps/` base and custom-domain root
working. Feature code stays outside the shared shell.

`shared/browser-auth.mts` retains the existing Supabase project-based storage
convention. The shared session adapter/provider owns Account identity and uses
local-scope sign-out. It does not clear arbitrary browser data or queued reviews.
Pages on the same origin and Supabase project use the same persisted session;
sessions do not cross between different hostnames or browser profiles.

Authentication is identity, not app authorization. Each feature decides when
sign-in is required and handles its own server-enforced access checks. The public
launcher never calls review/card/action APIs and cannot grant access to a deck.
The maintenance page loads neither the shell nor any auth JavaScript. No Recall
review logic, new database contract, or migration is part of this PR.

The existing public URL and publishable key live in `public-config.json`.
Optional build overrides retain the names `RECALL_SUPABASE_URL` and
`RECALL_SUPABASE_PUBLISHABLE_KEY`; set both. Secret keys and malformed hosts are
rejected before output is created. Never place server credentials in browser code.

## Release and recovery

PR checks install at the repository root, typecheck, test, and build. A push to
`main` triggers Pages deployment; opening this PR does not deploy it.
Merge requires the repository's exact-head approval or merge instruction.

Habit Practice's `/recall/` route stays offline for fresh loads. Previously cached
or already-open old clients are not revoked, and in-flight requests are not
cancelled. Preserve browser data and pending responses. No backend or storage
cleanup is included.

A separately reviewed revert of this shell commit restores the static launcher
and build without changing the maintenance content or database. The later
review rebuild must adopt the shared shell in its own reviewed step, with its
database prerequisite and cached-client release sequencing revalidated. Its
existing PR/branch is not changed by this work.

Backend files under `apps/recall/supabase/` remain source-only, unchanged, and
excluded from the site. Never rerun historical migrations on a provisioned
database or commit live seeds, account credentials, cards, or review history.
