import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { publishSql } from "../../../.agents/skills/publish-site/publish.mjs";

test("private sites isolate HTML, cross-site navigation and operator writes", async () => {
  const db = new PGlite();
  try {
    await db.exec(`create role anon; create role authenticated; create role service_role;
      create schema auth; create table auth.users (id uuid primary key);
      create function auth.uid() returns uuid stable language sql as $$
        select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
      grant usage on schema auth to authenticated;`);
    await db.exec(await readFile(new URL("../supabase/migrations/20261128071000_private_sites.sql", import.meta.url), "utf8"));
    const [owner, viewer, other] = [randomUUID(), randomUUID(), randomUUID()];
    await db.query("insert into auth.users values ($1),($2),($3)", [owner, viewer, other]);
    const html = "<h1>Owner’s 'private' page</h1>";
    const run = (action, fields = {}) => db.query(publishSql(action, { slug: "family", owner_id: owner, html, title: "Family", ...fields }));
    await run("create");
    await assert.rejects(run("create", { owner_id: other, html: "collision" }), { code: "23505" });
    await run("create", { slug: "trips" });
    await run("publish", { path: "trips/packing" });
    await run("link", { target_slug: "trips" });
    await run("share", { viewer_id: viewer });

    const read = (id, sql) => db.transaction(async tx => {
      await tx.query("select set_config('request.jwt.claim.sub',$1,true)", [id]);
      await tx.exec("set local role authenticated");
      return (await tx.query(sql)).rows;
    });
    const pages = "select html from public.site_pages where site_slug='family'";
    assert.equal((await read(owner, pages)).length, 2);
    assert.deepEqual(await read(viewer, pages), [{ html }, { html }]);
    assert.deepEqual(await read(other, pages), []);
    assert.deepEqual(await read(other, "select * from public.sites"), []);
    assert.deepEqual(await read(viewer, "select * from public.site_links"), []);
    await run("share", { slug: "trips", viewer_id: viewer });
    assert.equal((await read(viewer, "select * from public.site_links")).length, 1);
    await assert.rejects(read(owner, "delete from public.site_pages"), { code: "42501" });
    await assert.rejects(read(viewer, "insert into public.site_viewers select * from public.site_viewers"), { code: "42501" });
    for (const action of ["publish", "share", "unshare", "link"]) {
      const result = await run(action, { owner_id: viewer, path: "", viewer_id: other, target_slug: "trips", html: "changed" });
      assert.equal(result.rows.length, 0);
    }
    await run("unshare", { viewer_id: viewer });
    assert.deepEqual(await read(viewer, pages), []);
    assert.deepEqual(await read(viewer, "select * from public.site_links"), []);
    await db.exec("set role anon");
    await assert.rejects(db.query(pages), { code: "42501" });
  } finally { await db.close(); }
});
