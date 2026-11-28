import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
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
    create role authenticated; create role anon; create role service_role; create role supabase_auth_admin; create role neckardt_apps_oauth;
    create schema auth; create table auth.users (id uuid primary key);
    create function auth.uid() returns uuid language sql stable as $$
      select (nullif(current_setting('request.jwt.claims', true), '')::jsonb->>'sub')::uuid
    $$;
  `);
  const migrations = new URL("../supabase/migrations/", import.meta.url);
  const activityMigration = "20261128113521_task_activity.sql";
  const pending = [];
  for (const file of (await readdir(migrations)).filter(name => name.endsWith(".sql")).sort()) {
    const sql = await readFile(new URL(file, migrations), "utf8");
    if (file >= activityMigration) pending.push(sql);
    else await db.exec(sql);
  }

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

  const legacy = await create(a, shared, fields("Before tracking"));
  await complete(a, legacy, 1);
  for (const sql of pending) await db.exec(sql);
  const history = (who, task, before = null) => asUser(who, "select * from public.tasks_history($1,$2,$3)", [who,task,before]);
  const closed = (who, at = null, id = null) => asUser(who, "select * from public.tasks_completed($1,$2,$3)", [who,at,id]);
  const change = async (who, task, version, action, data = null) => (await asUser(who,
    "select public.tasks_change($1,$2,$3,$4,$5) as receipt", [who,task,version,action,JSON.stringify(data)]))[0].receipt;
  const undo = (who, receipt) => asUser(who, "select public.tasks_undo($1,$2)", [who,receipt]);

  await t.test("completed tasks and history respect enrollment, and tracking starts at rollout", async () => {
    assert.deepEqual(await history(b, legacy), []);
    assert.equal((await closed(b))[0].task_id, legacy);
    const task = await create(a, privateA, fields("Private activity"));
    const done = await change(a, task, 1, "completed");
    for (const other of [b,outsider]) {
      await assert.rejects(history(other,task), denied);
      await assert.rejects(undo(other,done), denied);
      assert(!(await closed(other)).some(row => row.task_id === task));
    }
    await assert.rejects(asUser(a, "select * from tasks_private.activity"), denied);
    for (const sql of ["select * from public.tasks_history($1,$2)", "select public.tasks_undo($1,$2)"]) {
      await assert.rejects(asUser(a, sql, [b, done]), denied);
      await assert.rejects(asUser(a, sql, [a, done], {client_id: randomUUID()}), denied);
    }
    await assert.rejects(undo(a,(await history(a,task)).find(e=>e.action==="created").event_id),denied);
  });

  await t.test("shared edits and punts record dates, compare revisions and undo only once", async () => {
    const original = fields("Shared plan", {plannedDate:"2032-06-01",plannedTime:"13:30",deadlineDate:"2032-07-01"});
    const task = await create(a,shared,original);
    const punt = await change(a,task,1,"edited",{plannedDate:"2032-06-08",plannedTime:null});
    const latest = (await history(b,task))[0];
    assert.deepEqual([latest.action,latest.by_you,latest.from_date,latest.from_time,latest.to_date,latest.to_time],
      ["rescheduled",false,"2032-06-01","13:30","2032-06-08",null]);
    assert(Number.isFinite(new Date(latest.happened_at).getTime()));
    await assert.rejects(undo(b,punt),denied);
    const edit = await change(b,task,2,"edited",{...original,title:"Later edit",plannedDate:"2032-06-08",plannedTime:null});
    await assert.rejects(undo(a,punt),conflict);
    await undo(b,edit);
    await assert.rejects(undo(a,punt),conflict); // Reverting a later edit still advances the version.
    assert.equal((await get(a,task)).title,"Shared plan");
    const completion = await change(a,task,4,"completed");
    assert((await closed(b)).some(row=>row.task_id===task));
    assert.equal((await history(b,task))[0].action,"completed");
    assert.equal(await get(a,task),undefined);
    await undo(a,completion);
    await change(b,task,6,"edited",{plannedDate:null,plannedTime:null});
    await undo(a,completion); // Retry after a lost undo response has no side effects.
    assert.equal((await get(a,task)).version,7);
    assert.equal((await get(a,task)).deadlineDate,original.deadlineDate);
    assert.deepEqual((await history(a,task)).map(e=>[e.action,e.is_undo]), [
      ["rescheduled",false],["completed",true],["completed",false],["edited",true],
      ["edited",false],["rescheduled",false],["created",false]]);
    const reverted = await change(a,task,7,"edited",{plannedDate:"2032-06-09",plannedTime:"12:00"});
    await undo(a,reverted);
    assert.equal((await get(a,task)).plannedDate,null);
    const expired = await change(a,task,9,"completed");
    await db.query("update tasks_private.activity set happened_at=now()-interval '5 minutes' where id=$1",[expired]);
    await assert.rejects(undo(a,expired),{code:"PT410"});
    assert.equal(await get(a,task),undefined);
  });

  await t.test("Focus undo restores personal order and rejects superseded choices without leaking activity", async () => {
    const first = await create(a,shared,fields("First"));
    const task = await create(a,shared,fields("Focus activity"));
    const choices = async who => (await read(who)).focus.filter(x=>[first,task].includes(x.taskId)).map(x=>x.taskId);
    const original = await change(a,task,1,"promoted");
    await change(a,first,1,"promoted");
    const move = await change(a,task,1,"promoted");
    const other = await change(b,task,1,"promoted");
    await assert.rejects(undo(a,original),conflict);
    await undo(a,move);
    assert.deepEqual(await choices(a),[first,task]);
    await assert.rejects(undo(a,original),conflict);
    assert.deepEqual(await choices(b),[task]);
    await undo(b,other);
    assert.deepEqual(await choices(b),[]);
    const events = await history(b,task);
    assert.deepEqual(events.map(e=>[e.action,e.by_you]),[["promoted",true],["promoted",true],["created",false]]);
    assert.deepEqual(await history(b,task,move),[]);
    await assert.rejects(undo(b,move),denied);
    const drop = await change(a,task,1,"deprioritized");
    await update(b,task,1,{plannedDate:"2032-06-09",plannedTime:null});
    await assert.rejects(undo(a,drop),conflict);
    assert.equal((await get(a,task)).plannedDate,"2032-06-09");
  });

  await t.test("older activity and completions remain reachable across page boundaries", async () => {
    const task = await create(a,privateA,fields("Long history"));
    for (let version=1;version<=50;version++) await update(a,task,version,fields(`Edit ${version}`));
    const latest = await history(a,task);
    assert.equal(latest.length,50);
    assert.deepEqual((await history(a,task,latest.at(-1).event_id)).map(e=>e.action),["created"]);
    const ids = [];
    for (let i=0;i<51;i++) {
      const id = await create(a,privateA,fields(`Closed ${i}`));
      ids.push(id);
      await complete(a,id,1);
    }
    // The ID breaks ties even if many rows close in the same transaction.
    await db.query("update tasks_private.items set completed_at='2044-01-01Z' where id=any($1::uuid[])",[ids]);
    const page = await closed(a);
    assert.equal(page.length,50);
    const last = page.at(-1);
    const older = await closed(a,last.completed_at,last.task_id);
    assert.deepEqual([...page,...older].map(row=>row.task_id).filter(id=>ids.includes(id)),ids.sort().reverse());
  });

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
