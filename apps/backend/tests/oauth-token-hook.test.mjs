import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { PGlite } from "@electric-sql/pglite";

const migration = new URL(
  "../supabase/migrations/20261124041055_deny_unrecognized_oauth_clients.sql", import.meta.url
);
const grant = "oauth_provider/authorization_code";

test("shared access-token hook", async (t) => {
  const db = new PGlite();
  t.after(() => db.close());
  await db.exec(`
    create role anon; create role authenticated;
    create role service_role; create role supabase_auth_admin;
  `);
  await db.exec(await readFile(migration, "utf8"));
  const owner = randomUUID();
  const canary = randomUUID();
  const unknown = randomUUID();
  const audience = "https://canary.example.invalid/mcp";
  const ordinary = { aud: "authenticated", role: "authenticated", sub: owner, is_anonymous: false };
  const bound = { ...ordinary, client_id: canary, scope: "openid" };

  async function issue(method, claims, extra = {}) {
    const event = { user_id: owner, authentication_method: method, claims, ...extra };
    const { rows } = await db.query(
      "select public.recall_canary_access_token_hook($1::jsonb) as result", [JSON.stringify(event)]
    );
    return rows[0].result;
  }
  function assertDenied(result) {
    assert.equal(result.error?.http_code, 403);
    assert.equal(Object.hasOwn(result, "claims"), false);
  }

  await db.exec("set role supabase_auth_admin");
  await t.test("ordinary sign-ins and session refresh preserve all claims", async () => {
    for (const method of ["password", "oauth", "token_refresh"]) {
      assert.deepEqual(await issue(method, ordinary), { claims: ordinary });
    }
  });
  await t.test("a clean project denies delegated issuance and refresh without bindings", async () => {
    for (const method of [grant, "token_refresh"]) {
      assertDenied(await issue(method, bound));
    }
  });

  await db.exec(`
    reset role;
    create schema recall_canary;
    create table recall_canary.oauth_clients (client_id uuid primary key, subject_id uuid, audience text not null);
    alter table recall_canary.oauth_clients enable row level security;
    grant usage on schema recall_canary to supabase_auth_admin;
    grant select on recall_canary.oauth_clients to supabase_auth_admin;
    create policy auth_reads_bindings on recall_canary.oauth_clients for select to supabase_auth_admin using (true);
  `);
  await db.query("insert into recall_canary.oauth_clients values ($1, $2, $3)", [canary, owner, audience]);
  await db.exec("set role supabase_auth_admin");

  await t.test("unknown registrations cannot mint or refresh an authenticated token", async () => {
    for (const method of [grant, "token_refresh"]) {
      assertDenied(await issue(method, { ...ordinary, client_id: unknown }));
    }
    assertDenied(await issue(grant, ordinary));
    assertDenied(await issue("token_refresh", { ...ordinary, amr: [{ method: grant }] }));
    assertDenied(await issue(grant, bound, { client_id: unknown }));
  });

  await t.test("the existing canary keeps its audience, role and owner restriction", async () => {
    for (const method of [grant, "token_refresh"]) {
      assert.deepEqual(await issue(method, bound), {
        claims: { ...bound, aud: audience, role: "recall_canary_oauth" }
      });
    }
    const anotherUser = randomUUID();
    assertDenied(await issue(grant, { ...bound, sub: anotherUser }, { user_id: anotherUser }));
    assertDenied(await issue(grant, { ...bound, is_anonymous: true }));
    await db.exec("reset role");
    await db.query("update recall_canary.oauth_clients set subject_id = null where client_id = $1", [canary]);
    await db.exec("set role supabase_auth_admin");
    assertDenied(await issue("token_refresh", bound));
  });

  await t.test("app-facing roles cannot call the hook", async () => {
    for (const role of ["anon", "authenticated", "service_role"]) {
      const { rows } = await db.query(
        "select has_function_privilege($1, 'public.recall_canary_access_token_hook(jsonb)', 'EXECUTE') as can_call",
        [role]
      );
      assert.equal(rows[0].can_call, false, role);
    }
  });
});
