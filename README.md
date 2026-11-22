# Neckardt Apps

A public static launcher for small personal tools. Recall is temporarily offline
while its replacement is reviewed separately. Fresh loads of `/recall/` receive
a static maintenance page with a link back to Apps.

## Local checks and preview

Requires Node.js 24.

```sh
npm ci --prefix apps/recall
npm --prefix apps/recall run typecheck
npm --prefix apps/recall test
node --test tests/*.test.mjs
node scripts/build-pages.mjs
python3 -m http.server 4173 --bind 127.0.0.1 --directory _site
```

The typecheck still covers the shared browser-auth module. The backend integration
test still exercises the actual Edge handler, FSRS, SQL, owner access, and replay
safety using synthetic in-memory fixtures. Shared auth convention checks remain
in `tests/browser-auth.test.mjs`; they do not load auth into the site.

The build copies exactly two HTML files: the launcher and `recall/index.html`.
It does not run Vite, bundle JavaScript, read Supabase configuration, or package
backend files. It refuses an existing output path so old review assets cannot
silently enter a new artifact. Rebuild into a new directory, or deliberately
remove only the generated output first.

## Offline behavior and limits

The maintenance page has no script, sign-in form, review controls, external
assets, auth client, redirects, or storage access. Its content security policy
disallows scripts and network resources. It cannot initiate a review on a fresh
load of this artifact. The launcher remains public and reports the offline status.

This is a frontend pause, not backend revocation. Already-open tabs and previously
cached old HTML/JavaScript may continue to operate against the unchanged backend.
Existing in-flight requests are not cancelled. This change does not read, clear,
migrate, or modify browser storage, sessions, queued responses, cards, schedules,
or review history. Preserve pending responses; do not clear browser data as part
of taking the frontend offline.

The old Recall frontend implementation and browser build tooling are removed
from this branch. Its Supabase migrations and Edge Function source stay intact.
No backend block, schema apply, Edge deployment, or review write is included.

## GitHub Pages and adding apps

Pull requests run checks and build without publishing. A push to `main` runs the
Pages deployment workflow. Merge and deployment require separate authorization;
preparing this PR does not take the live site offline.

The relative launcher link `./recall/` and maintenance link `../` work at both
`/recall/` and `/NeckardtApps/recall/`, including direct `index.html` loads.
Tests serve the actual artifact over HTTP at both bases and verify that old JS,
configuration, and backend paths are absent. No Supabase build variables are
needed or read while Recall is offline.

Keep the root launcher public. Give future apps real per-app output directories,
relative links, and direct-route tests. The shared browser-auth module is retained
for future applications but is not part of this static artifact.

## Recovery

This removal is one reversible commit. To restore the previous frontend and
build, prepare a separately reviewed revert of the offline PR's single commit:
`git revert <offline-pr-commit>`. Run the full checks, inspect the resulting
artifact, and obtain the required approval before merging/deploying the revert.
No database rollback or browser-storage cleanup is needed for this frontend-only
change. Recheck backend compatibility if it has changed independently.

The Recall rewrite remains on its existing separate PR/branch. This removal does
not rebase, replace, or merge that work; a later rewrite integration needs its own
review.

## Source and data boundaries

Backend files under `apps/recall/supabase/` remain source-only and are never
published with the site. Do not rerun historical migrations on a provisioned
database. Keep private schemas and owner-only access unchanged. No live seeds,
database dumps, owner credentials, or card/review data belong in this repository.
