import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { PGlite } from "@electric-sql/pglite";

test("account profiles are private to direct, signed-in owners", async t => {
  const db = new PGlite();
  t.after(() => db.close());
  const [owner, other] = [randomUUID(), randomUUID()];
  await db.exec(`
    create role anon; create role authenticated; create role service_role;
    create role neckardt_apps_oauth; create role recall_canary_oauth;
    create schema auth;
    create table auth.users(id uuid primary key);
    create function auth.uid() returns uuid stable language sql as $$
      select (current_setting('request.jwt.claims')::jsonb->>'sub')::uuid
    $$;
    grant usage on schema auth to authenticated;
  `);
  await db.exec(await readFile(new URL("../supabase/migrations/20261128070821_account_profiles.sql", import.meta.url), "utf8"));
  await db.query("insert into auth.users values ($1), ($2)", [owner, other]);
  const signIn = (sub, extra = {}) => db.query("select set_config('request.jwt.claims',$1,false)",
    [JSON.stringify({ sub, is_anonymous: false, ...extra })]);
  await db.exec("set role authenticated");
  await signIn(owner);
  const save = (id, name, picture) => db.query(`insert into public.account_profiles values ($1,$2,$3)
    on conflict (user_id) do update set display_name = excluded.display_name, picture = excluded.picture returning display_name`, [id,name,picture]);
  await save(owner, "First", null);
  assert.deepEqual((await save(owner, "Second", "data:image/jpeg;base64,/9j/")).rows, [{display_name: "Second"}]);
  await assert.rejects(save(owner, "a".repeat(81), null), /check constraint/);
  await assert.rejects(save(owner, "", "https://example.org/picture"), /check constraint/);
  await assert.rejects(db.query("update account_profiles set user_id=$1", [other]), /row-level security/);
  for (const [sub, extra] of [[other, {}], [owner, {client_id: randomUUID()}], [owner, {is_anonymous: true}]]) {
    await signIn(sub, extra);
    assert.deepEqual((await db.query("select * from account_profiles")).rows, []);
    assert.equal((await db.query("update account_profiles set display_name='blocked'")).affectedRows, 0);
    await assert.rejects(save(owner, "blocked", null), /row-level security/);
  }
  for (const role of ["anon", "neckardt_apps_oauth", "recall_canary_oauth"]) {
    await db.exec(`reset role; set role ${role}`);
    await assert.rejects(db.query("select * from account_profiles"), /permission denied/);
    await assert.rejects(save(owner, "blocked", null), /permission denied/);
  }
});
