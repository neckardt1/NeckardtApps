# NeckardtApps

Small personal web apps at [apps.neckardt.com](https://apps.neckardt.com/).
React, TypeScript, and Vite provide a public launcher and shared Apps/Account
navigation and sign-in. Each app owns its behavior and backend access checks.

- [Habit Practice](apps/recall/README.md) — cards and habit check-ins at `/recall/`.
- [Canary OAuth consent](src/oauth/README.md) — the MCP experiment's sign-in page
  at `/oauth/consent/`, with a separate session from the apps.

## Local development

Use Node.js 24, then run:

```sh
npm ci
npm run dev
```

Before a PR: `npm run typecheck`, `npm test`, and `npm run build`.
The build writes `_site/` and refuses an existing output directory; remove only
generated output before rebuilding, or pass a fresh directory to
`node scripts/build-pages.mjs <directory>`.

## Deployment

PR checks do not publish. A push to `main` runs checks, builds the three page
entries, and deploys `_site/` to GitHub Pages. Links work on the custom domain
and the `/NeckardtApps/` project path without a client-side router.

`public-config.json` contains the browser-safe Supabase URL and publishable key.
Optional build overrides are `RECALL_SUPABASE_URL` and
`RECALL_SUPABASE_PUBLISHABLE_KEY` (set both). Keep credentials and private data
out of this public repo. Database migrations and Edge Functions deploy
separately; see the app's notes before backend-dependent releases.
