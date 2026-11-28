# NeckardtApps

Small personal web apps at [apps.neckardt.com](https://apps.neckardt.com/).

- [Web](apps/web/) contains the React/Vite launcher, [Habit Practice](apps/web/src/apps/habit-practice/README.md)
  at `/recall/`, and the separate [OAuth consent page](apps/web/src/oauth/README.md).
- [Private sites](/apps/web/src/apps/sites/Sites.tsx) at `/sites` displays owner- and viewer-scoped HTML. Use the [publishing skill](.agents/skills/publish-site/SKILL.md) to create pages and manage access.
- [Tasks](apps/web/src/apps/tasks/) at `/tasks/` uses the existing Account sign-in. Two enrolled accounts each have a private list and share Household. Focus choices belong to each account.
  The [planned recurrence behavior](apps/web/src/apps/tasks/RECURRENCE.md) includes a monthly rent example.
- [Backend](apps/backend/supabase/) contains the SQL migrations and Supabase Edge Functions.
  Generate types with `npm run db:types` at the root before checking or deploying an Edge
  Function. Run Supabase CLI commands from `apps/backend/`.

See the [MCP tools and events](apps/backend/supabase/functions/neckardt-apps-mcp/README.md) for the suite’s ChatGPT interface.

## Local development

From the repo root with Node.js 24:

```sh
npm ci
npm run dev
```

Vite generates database types at startup and after migration edits. To regenerate them
on their own, run `npm run db:types`. The generator applies the migrations to a fresh
in-memory PostgreSQL database (PGlite) and uses Supabase typegen. Both workspaces
consume the result. No hosted credentials or Docker daemon are required.

Run `npm run check` before a PR. It generates types, checks both workspaces, and runs
their tests, including builds of the Pages site in temporary directories.
`npm run build` produces a deployable site in `_site/`. Pass a fresh output directory
with `npm run build -- <directory>` to keep earlier builds.

To test Habit Practice while editing with a disposable Supabase user, see the
[hosted test setup](tests/hosted/README.md).

### Rehearse Tasks with two accounts

Both lists use `America/Los_Angeles`. A planned time can appear in Today that morning.
Show after gates Today independently of the plan and deadline. Manual Focus carries
forward until changed or completed. Deprioritizing suppresses a suggestion for the
rest of the Pacific day. The database operator's existing backups cover both lists.

Use a disposable local Auth, PostgREST and PostgreSQL stack with the committed migrations.
Create two password users in local Auth. As the local database operator, bind their Auth
IDs as `$1` and `$2` to provision the empty lists in one statement.

```sql
insert into tasks_private.lists (slot, owner_id)
values (0, null), (1, $1::uuid), (2, $2::uuid);
```

Prepare a JSON fixture outside Git with the loopback gateway `url` (such as
`http://127.0.0.1:54321`), a synthetic `publicOrigin` such as
`https://taskslocalfixtureabc.supabase.co`, the local gateway's `publishableKey`,
and `users` containing two objects with `id`, `email` and `password`. Run
`CHROME_BIN=/usr/bin/chromium node apps/web/tests/tasks-local-browser.mjs /path/to/fixture.json`.
The test builds Pages, signs in through Home in separate desktop and phone browser
contexts, and forwards the synthetic origin to loopback. It creates synthetic tasks.

## Deployment

A push to `main` runs the checks and deploys the web workspace to GitHub Pages.
The launcher and Habit Practice share a React Router entry. The Pages fallback
preserves direct links on the custom domain and the `/NeckardtApps/` project path.
OAuth consent has its own HTML entry and sign-in session.

The [shared public config](apps/backend/supabase/functions/_shared/public-config.json) holds the
Supabase URL and publishable key for the web app and the default hosted test target. Set
`NECKARDT_APPS_SUPABASE_URL` and `NECKARDT_APPS_SUPABASE_PUBLISHABLE_KEY` together to override
them. Builds also accept the older `RECALL_SUPABASE_*` pair when both new
settings are empty. Database migrations and Edge Functions deploy separately.
