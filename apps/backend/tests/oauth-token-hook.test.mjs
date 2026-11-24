import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { PGlite } from "@electric-sql/pglite";

const guardMigration = new URL(
  "../supabase/migrations/20261124041055_deny_unrecognized_oauth_clients.sql", import.meta.url
);
const suiteMigration = new URL(
  "../supabase/migrations/20261124054823_authorize_neckardt_apps_mcp.sql", import.meta.url
);
const suiteId = "99658a13-b445-411d-bcc8-6a01bc5358ff";
const suiteOrigin = "https://jjgepkhpvslqwzkquqaf.supabase.co";
const grant = "oauth_provider/authorization_code";

test("shared access-token hook", async (t) => {
  const db = new PGlite();
  t.after(() => db.close());
  await db.exec(`
    create role anon; create role authenticated;
    create role service_role; create role supabase_auth_admin;
  `);
  await db.exec(await readFile(guardMigration, "utf8"));
  await db.exec(await readFile(suiteMigration, "utf8"));
  await db.exec(await readFile(new URL(
    "../supabase/migrations/20261124163535_allow_suite_chatgpt_identity_scopes.sql", import.meta.url
  ), "utf8"));
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

  const suiteClaims = { ...ordinary, client_id: suiteId, iss: suiteOrigin + "/auth/v1", scope: "openid",
    email: "fixture@example.invalid", phone: "fixture-phone", user_metadata: { name: "fixture" },
    app_metadata: { provider: "email" } };
  await t.test("each suite user gets only the link audience on issue and refresh", async () => {
    for (const userId of [owner, randomUUID()]) {
      for (const method of [grant, "token_refresh"]) {
        const sessionId = randomUUID();
        const { claims } = await issue(method, { ...suiteClaims, sub: userId, session_id: sessionId }, { user_id: userId });
        assert.deepEqual(claims, { ...ordinary, sub: userId, session_id: sessionId, client_id: suiteId,
          iss: suiteClaims.iss, scope: "openid", aud: suiteOrigin + "/functions/v1/neckardt-apps-mcp",
          role: "neckardt_apps_oauth", email: "", phone: "" });
      }
    }
  });

  await t.test("the ChatGPT identity grant and its refresh retain the link-only role and audience", async () => {
    for (const [method, scope] of [[grant, "openid email offline_access"], ["token_refresh", "offline_access openid email"]]) {
      const { claims } = await issue(method, { ...suiteClaims, scope });
      assert.equal(claims?.role, "neckardt_apps_oauth");
      assert.equal(claims.aud, suiteOrigin + "/functions/v1/neckardt-apps-mcp");
      assert.equal(claims.sub, owner);
      assert.equal(claims.email, "");
      assert.equal(claims.phone, "");
      assert.equal(Object.hasOwn(claims, "user_metadata"), false);
    }
  });

  await t.test("suite grants reject other identities, scopes, issuers and anonymous sessions", async () => {
    for (const method of [grant, "token_refresh"]) {
      for (const change of [{ sub: randomUUID() }, { scope: "openid email" }, { scope: undefined },
        { scope: "openid offline_access" }, { scope: "openid email email" }, { scope: "openid email offline_access phone" },
        { iss: "https://other.example/auth/v1" }, { role: "service_role" }, { is_anonymous: true }]) {
        assertDenied(await issue(method, { ...suiteClaims, ...change }));
      }
      assertDenied(await issue(method, suiteClaims, { client_id: canary }));
      assertDenied(await issue(method, { ...suiteClaims, sub: undefined }, { user_id: undefined }));
    }
    assertDenied(await issue("password", suiteClaims));
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
