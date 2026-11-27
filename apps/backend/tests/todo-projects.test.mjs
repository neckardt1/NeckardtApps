import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { PGlite } from "@electric-sql/pglite";

test("two enrolled accounts share tasks only in the owner's chosen projects", async () => {
  const db = new PGlite();
  const rows = async (sql, args = []) => (await db.query(sql, args)).rows;
  const [owner, partner, outsider] = Array.from({ length: 3 }, () => randomUUID());
  const signIn = async id => {
    await db.exec("set role authenticated");
    await rows("select set_config('request.jwt.claim.sub', $1, false)", [id]);
  };
  try {
    await db.exec(`create role authenticated; create role anon; create role service_role;
      create schema auth; create table auth.users(id uuid primary key);
      create function auth.uid() returns uuid stable language sql as $$
        select current_setting('request.jwt.claim.sub', true)::uuid $$;
      grant usage on schema auth to authenticated;
      alter default privileges in schema public grant all on tables to authenticated, anon, service_role;`);
    await db.exec(await readFile(new URL("../supabase/migrations/20261127233600_shared_todo_projects.sql", import.meta.url), "utf8"));
    await rows("insert into auth.users values ($1), ($2), ($3)", [owner, partner, outsider]);
    await rows("insert into todo_accounts values ($1), ($2)", [owner, partner]);

    await signIn(owner);
    const create = "insert into todo_projects(owner_id,name) values ($1,$2) returning id";
    const [{ id: privateId }] = await rows(create, [owner, "Personal"]);
    const [{ id: sharedId }] = await rows(create, [owner, "Household"]);
    const add = "insert into todo_tasks(project_id,title) values ($1,$2) returning id";
    const [{ id: privateTask }] = await rows(add, [privateId, "Buy a gift"]);
    const [{ id: sharedTask }] = await rows(add, [sharedId, "Get milk"]);
    const share = "update todo_projects set collaborator_id=$1 where id=$2 returning id";
    assert.deepEqual(await rows(share, [partner, sharedId]), [{ id: sharedId }]);

    await signIn(partner);
    assert.deepEqual(await rows("select user_id from todo_accounts"), [{ user_id: partner }]);
    assert.deepEqual(await rows("select id from todo_projects"), [{ id: sharedId }]);
    assert.deepEqual(await rows("select id from todo_tasks"), [{ id: sharedTask }]);
    assert.deepEqual(await rows("update todo_tasks set done=true where id=$1 returning id", [privateTask]), []);
    await assert.rejects(rows(add, [privateId, "A private task"]), { code: "42501" });
    assert.deepEqual(await rows(share, [null, sharedId]), []);
    await assert.rejects(rows("update todo_tasks set project_id=$1 where id=$2", [privateId, sharedTask]), { code: "42501" });
    await rows("update todo_tasks set done=true where id=$1", [sharedTask]);
    await rows(add, [sharedId, "Pick up bread"]);
    await rows(create, [partner, "Personal to partner"]);

    await signIn(outsider);
    assert.deepEqual(await rows("select id from todo_projects"), []);
    await assert.rejects(rows(create, [outsider, "Unenrolled"]), { code: "23503" });
    await assert.rejects(rows("insert into todo_accounts values ($1)", [outsider]), { code: "42501" });
    await signIn(owner);
    assert.equal((await rows("select done from todo_tasks where id=$1", [sharedTask]))[0].done, true);
    assert.equal((await rows("select id from todo_projects")).length, 2);
    await rows(share, [null, sharedId]);
    await signIn(partner);
    assert.deepEqual(await rows("select id from todo_tasks"), []);
    assert.deepEqual(await rows("update todo_tasks set title='Revised' where id=$1 returning id", [sharedTask]), []);
    await db.exec("reset role; set role anon");
    await assert.rejects(rows("select * from todo_projects"), { code: "42501" });
  } finally {
    await db.close();
  }
});
