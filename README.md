# Neckardt Apps

A static launcher for small personal tools. [Recall](apps/recall/) is the
first app: see a flashcard, show its answer, then grade it with Again, Hard,
Good, or Easy. Reviews save asynchronously.

## Local development

Requires Node.js 24.

```sh
npm ci --prefix apps/recall
npm --prefix apps/recall run typecheck
npm --prefix apps/recall test
node --test tests/pages.test.mjs
node scripts/build-pages.mjs
```

Run `npm --prefix apps/recall run dev` for the Recall Vite dev server, or serve
`_site/` with a static server to preview both pages. Rebuild into a new
directory after each build, or remove the old generated output first.
The default connection uses the documented public browser settings in
`apps/recall/public-config.json`. To target a separate project for local
development, provide both variables below to the build command. The app
uses an existing Supabase Auth account, not a GitHub login. No signup form.

## Adding an app

Keep the root launcher public. Give each app its own HTML entry, source,
and tests under `apps/<name>/`. Follow the Recall React + TypeScript + Vite
pattern: build with a relative asset base (`./`) and stage the output in a
real per-app directory under `_site/`. Add a relative launcher link and
a direct-route test; no shared router or UI kit is required.

To share sign-in on the same origin and Supabase project, reuse the browser
client convention in `shared/browser-auth.mts` and keep the SDK's project-based
session key. Do not add a path-specific session key or infer authorization
from browser UI state; the backend still controls each app's access. Sessions
do not cross between the default Pages hostname and the custom domain.

## GitHub Pages

1. In **Settings → Pages**, set **Source** to **GitHub Actions** and run the
   deployment workflow on `main`. It tests first and publishes only the
   generated HTML and browser assets under `_site/`; tests, backend
   migrations and functions are not part of the Pages artifact.
2. The launcher and `/recall/` use relative paths, so they work at the
   repository's default Pages base path or at a custom domain such as
   `apps.neckardt.com`. For a custom domain, set it in Pages settings, follow
   GitHub's DNS instructions, and enforce HTTPS when available. Prefer the
   custom domain for sign-in: apps sharing a browser origin also share
   its browser storage, regardless of path.
3. No repository variables are needed with the defaults in
   `apps/recall/public-config.json`. To override both, add
   `RECALL_SUPABASE_URL` and `RECALL_SUPABASE_PUBLISHABLE_KEY` in
   **Settings → Secrets and variables → Actions → Variables**.
   Use only the public HTTPS URL and the `sb_publishable_…` value;
   never a server secret, database credential, or session token.

Pull requests run type checking, tests, and the static build without publishing.

See the [GitHub Pages workflow guide](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages)
and [GitHub's custom domain guide](https://docs.github.com/en/pages/configuring-a-custom-domain-for-your-github-pages-site/about-custom-domains-and-github-pages).

## Source and data boundaries

- `apps/recall/` contains the UI, tests, and generic Supabase migrations and
  Edge Function implementation. No live seed, database dump, owner account,
  or card/review data belongs here. Tests generate their fixtures in memory.
- Publishing the frontend does not apply schema migrations, deploy the Edge
  Function, or make private Supabase data public. The backend must already be
  provisioned and owner-only authorization enforced. Keep
  `flashcards_private` out of the exposed Data API schemas. Do not rerun the
  initial migrations on a provisioned database.
- The browser can see its publishable key and the public app source; only an
  allowlisted signed-in account can access the deck. The grading function uses
  Supabase-managed server credentials only inside its runtime; deployment and
  private data live outside this repository.
