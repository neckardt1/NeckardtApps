# NeckardtApps

Small personal web apps at [apps.neckardt.com](https://apps.neckardt.com/).

- [Web](apps/web/) contains the React/Vite launcher, [Habit Practice](apps/web/src/apps/habit-practice/README.md)
  at `/recall/`, the To-do prototype at `/todo/`, and the separate [OAuth consent page](apps/web/src/oauth/README.md).
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

## Two-account To-do prototype

In a disposable Supabase project, each tester needs an Auth account and a corresponding
`public.todo_accounts.user_id` row. The migration creates an empty enrollment table.
To-do uses the launcher's **Account** sign-in. Each account can create private projects.
To share one, the other tester opens **Your sharing ID** and gives the ID to the owner.
The owner enters it under that project's **Manage sharing**. Either tester can then add,
rename or complete tasks. **Refresh** loads the other tester's changes. **Stop sharing**
returns the project to the owner alone.

Run `node --test apps/backend/tests/todo-projects.test.mjs` for the disposable database
test covering private projects, shared tasks and revocation.

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
