import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";

const fields = (title, dates = {}) => ({
  title, plannedDate: null, plannedTime: null, deadlineDate: null, deadlineTime: null,
  showAfterDate: null, showAfterTime: null, ...dates
});

test("Tasks account and write contract", async t => {
  const db = new PGlite();
  t.after(() => db.close());
  await db.exec(`
    create role authenticated; create role anon; create role service_role; create role neckardt_apps_oauth;
    create schema auth; create table auth.users (id uuid primary key);
    create function auth.uid() returns uuid language sql stable as $$
      select (nullif(current_setting('request.jwt.claims', true), '')::jsonb->>'sub')::uuid
    $$;
  `);
  await db.exec(await readFile(new URL("../supabase/migrations/20261128093356_household_tasks.sql", import.meta.url), "utf8"));

  const [a, b, outsider] = [randomUUID(), randomUUID(), randomUUID()];
  await db.query("insert into auth.users values ($1),($2),($3)", [a,b,outsider]);
  const asUser = (who, sql, params = [], claims = {}) => db.transaction(async tx => {
    await tx.exec("set local role authenticated");
    await tx.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({
      sub: who, role: "authenticated", aud: "authenticated", is_anonymous: false, ...claims
    })]);
    return (await tx.query(sql, params)).rows;
  });
  const read = async (who, actor = who) => (await asUser(who, "select public.tasks_read($1) as data", [actor]))[0].data;
  const create = async (who, list, data, request = randomUUID()) => (await asUser(who,
    "select public.tasks_create($1,$2,$3,$4) as id", [who,list,request,JSON.stringify(data)]))[0].id;
  const update = (who, task, version, data) => asUser(who, "select public.tasks_update($1,$2,$3,$4)",
    [who,task,version,JSON.stringify(data)]);
  const complete = (who, task, version) => asUser(who, "select public.tasks_complete($1,$2,$3)", [who,task,version]);
  const focus = (who, task, state) => asUser(who, "select public.tasks_focus($1,$2,$3)", [who,task,state]);
  const get = async (who, task) => (await read(who)).tasks.find(item => item.id === task);
  const denied = { code: "42501" }, conflict = { code: "PT409" };

  assert.deepEqual((await read(a)).lists, []);
  await db.query("insert into tasks_private.lists (slot,owner_id) values (0,null),(1,$1),(2,$2)", [a,b]);
  const [{id: privateA}, {id: shared}] = (await read(a)).lists;
  const [{id: privateB}] = (await read(b)).lists;
  assert.deepEqual((await read(a)).lists, [{id:privateA,kind:"private"}, {id:shared,kind:"household"}]);
  assert.deepEqual((await read(b)).lists, [{id:privateB,kind:"private"}, {id:shared,kind:"household"}]);
  assert.notEqual(privateA, privateB);

  await t.test("ordinary accounts can neither read nor mutate one another's private data", async () => {
    for (const [owner, other, list] of [[a,b,privateA], [b,a,privateB]]) {
      const id = await create(owner, list, fields("Private fixture"));
      await focus(owner, id, "promoted");
      const visible = await read(other);
      assert(!visible.lists.some(item => item.id === list));
      assert(!visible.tasks.some(item => item.id === id));
      assert(!visible.focus.some(item => item.taskId === id));
      await assert.rejects(create(other, list, fields("Hidden")), denied);
      await assert.rejects(update(other, id, 1, fields("Hidden")), denied);
      await assert.rejects(complete(other, id, 1), denied);
      await assert.rejects(focus(other, id, "promoted"), denied);
      assert.equal((await get(owner, id)).title, "Private fixture");
    }
    assert.deepEqual((await read(outsider)).tasks, []);
    await assert.rejects(create(outsider, shared, fields("Not enrolled")), denied);
    await assert.rejects(read(a, b), denied);
    await assert.rejects(asUser(a, "select public.tasks_create($1,$2,$3,$4)",
      [b,shared,randomUUID(),JSON.stringify(fields("Wrong account"))]), denied);
    await assert.rejects(asUser(a, "select * from tasks_private.items"), denied);
    await assert.rejects(asUser(outsider, "insert into tasks_private.lists(slot,owner_id) values (1,$1)", [outsider]), denied);
    for (const claims of [{ is_anonymous: true }, { client_id: randomUUID() }, { aud: "another-service" },
      { amr: [{ method: "oauth_provider/authorization_code" }] }]) {
      await assert.rejects(asUser(a, "select public.tasks_read($1)", [a], claims), denied);
    }
    for (const role of ["anon", "neckardt_apps_oauth", "service_role"]) {
      await assert.rejects(db.transaction(async tx => {
        await tx.exec(`set local role ${role}`);
        await tx.query("select public.tasks_read($1)", [a]);
      }), denied);
    }
  });

  await t.test("a retry reuses the creator's receipt through edits and completion", async () => {
    const receipt = randomUUID(), original = fields("First shared", { plannedDate: "2028-04-15" });
    const task = await create(a, shared, original, receipt);
    assert.equal(task, await create(a, shared, original, receipt));
    const otherTask = await create(b, shared, fields("Independent create"), receipt);
    assert.notEqual(otherTask, task);
    await update(b, task, 1, fields("Revised", { plannedDate:"2028-04-16", deadlineDate:"2028-04-20" }));
    await assert.rejects(update(a, task, 1, fields("Stale")), conflict);
    await assert.rejects(complete(a, task, 1), conflict);
    assert.equal(await create(a, shared, original, receipt), task);
    assert.equal((await get(a, task)).title, "Revised");
    await update(a, task, 2, { plannedDate:"2028-04-17", plannedTime:"19:00" });
    const rescheduled = await get(b, task);
    assert.deepEqual([rescheduled.title,rescheduled.plannedTime,rescheduled.deadlineDate,rescheduled.version],
      ["Revised","19:00","2028-04-20",3]);
    await focus(a, task, "promoted");
    await complete(b, task, 3);
    assert.equal(await create(a, shared, original, receipt), task);
    for (const who of [a,b]) {
      const snapshot = await read(who);
      assert(!snapshot.tasks.some(item => item.id === task));
      assert(!snapshot.focus.some(item => item.taskId === task));
    }
    await assert.rejects(update(a, task, 3, original), conflict);
    await assert.rejects(create(a, privateA, original, receipt), conflict);
  });

  await t.test("invalid shared edits return a field error without stored row details", async () => {
    const task = await create(a, shared, fields("Original title"));
    const original = await get(b, task);
    for (const [data, message] of [
      [fields(" \t"), "Enter a task title."],
      [fields(null), "Enter a task title."],
      [{ plannedDate:null, plannedTime:"12:00" }, "A time needs a date."],
      [fields("Updated", { deadlineTime:"09:00" }), "A time needs a date."],
      [fields("Updated", { showAfterTime:"09:00" }), "A time needs a date."]
    ]) {
      await assert.rejects(update(b, task, original.version, data), error => {
        assert.equal(error.code, "PT422");
        assert.equal(error.message, message);
        assert.equal(error.detail, undefined);
        return true;
      });
    }
    assert.deepEqual(await get(a, task), original);
  });

  await t.test("Pacific civil dates are stable during travel and only Show after gates promotion", async () => {
    const task = await create(a, shared, fields("Travel dates", { plannedDate:"2099-01-04", plannedTime:"19:00",
      deadlineDate:"2099-01-05" }));
    const before = await get(a, task);
    assert.equal(before.showAfterAt, null);
    assert.equal(before.deadlineTime, null);
    await focus(b, task, "promoted");
    await db.exec("set time zone 'Asia/Tokyo'");
    assert.deepEqual(await get(b, task), before);
    await update(a, task, 1, fields("Gate during daylight time", { plannedDate:"2099-08-02",
      showAfterDate:"2099-08-01", showAfterTime:"19:15" }));
    const gated = await get(b, task);
    assert.equal(gated.plannedTime, null);
    assert.equal(gated.showAfterTime, "19:15");
    assert.equal(new Date(gated.showAfterAt).toISOString(), "2099-08-02T02:15:00.000Z");
    await assert.rejects(focus(b, task, "promoted"), { code: "PT422" });
    await update(b, task, 2, fields("Winter date gate", { showAfterDate:"2099-01-04" }));
    const winter = await get(a, task);
    assert.equal(winter.showAfterTime, null);
    assert.equal(new Date(winter.showAfterAt).toISOString(), "2099-01-04T08:00:00.000Z");
    await assert.rejects(update(a, task, 3, { plannedDate:"tomorrow", plannedTime:null }), { code:"PT422" });
    assert.deepEqual(await get(a, task), winter);
  });

  await t.test("personal promotions keep their order and suppression lasts one Pacific day", async () => {
    const ids = [];
    for (let i = 0; i < 5; i++) {
      const task = await create(a, shared, fields(`Focus ${i}`, { plannedDate:"2031-02-03" }));
      ids.push(task);
      await focus(a, task, "promoted");
    }
    await focus(a, ids[0], "promoted");
    const choices = async who => (await read(who)).focus.filter(item => ids.includes(item.taskId));
    assert.deepEqual((await choices(a)).map(item => item.taskId), [ids[0],ids[4],ids[3],ids[2],ids[1]]);
    await focus(b, ids[1], "deprioritized");
    assert.deepEqual(await choices(b), []);
    await focus(b, ids[1], "promoted");
    await focus(a, ids[1], "deprioritized");
    assert.deepEqual((await choices(a))[0], {taskId:ids[1], state:"deprioritized"});
    await focus(a, ids[1], "deprioritized");
    assert.equal((await choices(a))[0].state, "deprioritized");
    assert.deepEqual(await choices(b), [{taskId:ids[1], state:"promoted"}]);
    assert.equal((await get(b,ids[1])).plannedDate, "2031-02-03");
    assert.equal((await get(b,ids[1])).version, 1);
    await db.query("update tasks_private.focus set chosen_day = chosen_day - 1 where task_id=$1", [ids[1]]);
    await focus(a, ids[1], "deprioritized");
    assert(!(await choices(a)).some(item => item.taskId === ids[1]));
    assert.deepEqual(await choices(b), [{taskId:ids[1],state:"promoted"}]);
    const pacificDay = new Intl.DateTimeFormat("en-CA", { timeZone:"America/Los_Angeles",
      year:"numeric", month:"2-digit", day:"2-digit" }).format(new Date());
    assert.equal((await read(a)).focusDay, pacificDay);
  });
});
