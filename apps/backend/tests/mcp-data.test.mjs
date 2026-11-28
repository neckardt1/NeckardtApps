import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { createHandler } from "../supabase/functions/neckardt-apps-mcp/server.ts";

test("signed suite MCP requests use the registered tools and isolated app data", async t => {
  const db = new PGlite();
  t.after(() => db.close());
  await db.exec(`
    create role anon; create role authenticated; create role supabase_auth_admin; create role service_role;
    create schema auth; create table auth.users(id uuid primary key);
    create function auth.uid() returns uuid stable language sql as $$
      select (nullif(current_setting('request.jwt.claims',true),'')::jsonb->>'sub')::uuid
    $$;
    create table auth.oauth_clients(id uuid primary key, redirect_uris text, registration_type text default 'manual',
      client_type text default 'public', token_endpoint_auth_method text default 'none', deleted_at timestamptz);
    grant usage on schema auth to authenticated, supabase_auth_admin;
    grant select on auth.oauth_clients to supabase_auth_admin;
  `);
  const migrations = new URL("../supabase/migrations/", import.meta.url);
  for (const file of (await readdir(migrations)).filter(file => file.endsWith(".sql")).sort())
    await db.exec(await readFile(new URL(file, migrations), "utf8"));

  const a = randomUUID(), b = randomUUID(), pilot = randomUUID(), writer = randomUUID(), reader = randomUUID();
  const [suite] = (await db.query("select client_id from neckardt_mcp.clients")).rows;
  const all = ["get_cards","create_cards","list_tasks","create_task","update_task","complete_task","set_task_focus"];
  await db.query("insert into auth.users values ($1),($2)", [a,b]);
  await db.query("insert into flashcards_private.app_owner(owner_id) values ($1),($2)", [a,b]);
  await db.query("insert into tasks_private.lists(slot,owner_id) values (1,$1),(2,$2)", [a,b]);
  for (const [client,owner,tools] of [[pilot,a,[]],[writer,a,all],[reader,b,["get_cards","list_tasks"]]]) {
    await db.query(`insert into neckardt_mcp.clients(client_id,display_name,callback_url,owner_id,data_tools)
      values ($1,'Fixture','https://fixture.example.invalid/callback',$2,$3)`, [client,owner,tools]);
  }
  await db.exec("insert into auth.oauth_clients(id,redirect_uris) select client_id,callback_url from neckardt_mcp.clients");
  const { publicKey, privateKey } = await generateKeyPair("ES256");
  const keys = createLocalJWKSet({ keys: [{ ...await exportJWK(publicKey), kid: "fixture" }] });
  // Use the hook's configured issuer to mint local fixture tokens. All transport and SQL run in process.
  const origin = "https://jjgepkhpvslqwzkquqaf.supabase.co";
  async function token(client, sub) {
    const claims = { sub, client_id:client, iss:origin+"/auth/v1", aud:"authenticated", role:"authenticated",
      is_anonymous:false, scope:"openid", session_id:randomUUID() };
    const issued = await db.transaction(async tx => {
      await tx.exec("set local role supabase_auth_admin");
      const result = await tx.query("select public.recall_canary_access_token_hook($1) as grant",
        [JSON.stringify({user_id:sub, authentication_method:"oauth_provider/authorization_code", claims})]);
      return result.rows[0].grant;
    });
    assert.ok(issued.claims, JSON.stringify(issued.error));
    return new SignJWT(issued.claims).setProtectedHeader({alg:"ES256",kid:"fixture"})
      .setIssuedAt().setExpirationTime("5m").sign(privateKey);
  }
  const dataRpc = (client, actor, operation, args) => db.transaction(async tx => {
    await tx.exec("set local role service_role");
    return (await tx.query("select public.neckardt_mcp_data($1,$2,$3,$4) as data",
      [client,actor,operation,JSON.stringify(args)])).rows[0].data;
  });
  const handler = createHandler(origin, keys, undefined, dataRpc);
  async function rpc(bearer, method, params) {
    const res = await handler(new Request(origin+"/functions/v1/neckardt-apps-mcp", {method:"POST",
      headers:{Accept:"application/json, text/event-stream", "Content-Type":"application/json",
        ...(bearer ? {Authorization:"Bearer "+bearer} : {})},
      body:JSON.stringify({jsonrpc:"2.0",id:1,method,params})}));
    return res.json();
  }
  const list = async bearer => (await rpc(bearer,"tools/list",{})).result.tools.map(t=>t.name);
  const call = (bearer,name,args={}) => rpc(bearer,"tools/call",{name,arguments:args});
  const ok = async (bearer,name,args) => {
    const {error,result} = await call(bearer,name,args);
    assert.ok(!error && !result.isError, JSON.stringify(error ?? result));
    return result.structuredContent;
  };
  const wa = await token(writer,a), rb = await token(reader,b);
  const schemaDenied = async (name,args) => assert.equal((await call(wa,name,args)).error.code,-32602);
  const denied = async (bearer,name,args) => assert.equal((await call(bearer,name,args)).result.isError,true);

  await t.test("discovery, direct calls, and consent respect per-client privileges", async () => {
    for (const bearer of [null,await token(suite.client_id,a),await token(pilot,a)]) {
      assert.deepEqual(await list(bearer),["get_habit_practice_link"]);
      await denied(bearer,"get_cards",{});
      await denied(bearer,"list_tasks",{});
    }
    assert.deepEqual(await list(wa),["get_habit_practice_link",...all]);
    assert.deepEqual(await list(rb),["get_habit_practice_link","get_cards","list_tasks"]);
    await assert.rejects(dataRpc(writer,b,"list_tasks",{}),{code:"42501"});
    await assert.rejects(db.query("update neckardt_mcp.clients set data_tools=$1 where client_id=$2",[all,pilot]));
    await assert.rejects(db.query("update neckardt_mcp.clients set owner_id=$1 where client_id=$2",[b,writer]));
    for (const role of ["anon","authenticated"])
      await assert.rejects(db.transaction(async tx => {
        await tx.exec("set local role "+role);
        await tx.query("select public.neckardt_mcp_data($1,$2,'list_tasks','{}')", [writer,a]);
      }),{code:"42501"});
    const consent = await db.transaction(async tx => {
      await tx.exec("set local role authenticated");
      await tx.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({sub:a,is_anonymous:false})]);
      return tx.query("select data_tools from public.neckardt_mcp_client($1,$2,'openid')", [writer,a]);
    });
    assert.deepEqual(consent.rows[0].data_tools,all);
  });

  await t.test("approved batches are atomic, exact, retryable and visible only to their owner", async () => {
    const card = front => ({id:randomUUID(),front,back:"  **Fixture**\n\nSecond paragraph.  "});
    const fact = card("Fixture fact?"), cue = card("Fixture cue?"), action = card("Fixture action?");
    const batch = {approved_exact_wording:true,items:[{kind:"fact",card:fact},{kind:"habit",cue,action}]};
    await schemaDenied("create_cards",{items:batch.items});
    await schemaDenied("create_cards",{...batch,owner_id:b});
    await schemaDenied("create_cards",{...batch,items:[{kind:"habit",cue}]});
    await denied(rb,"create_cards",batch);
    const {cards} = await ok(wa,"create_cards",batch);
    assert.equal(cards.length,3);
    for (const c of [fact,cue,action]) {
      const saved = cards.find(row=>row.id===c.id);
      assert.equal(saved.front,c.front); assert.equal(saved.back,c.back);
      assert.ok(saved.active && Date.parse(saved.due_at)<=Date.now()+1000);
    }
    assert.equal(cards.find(c=>c.id===action.id).cue_card_id,cue.id);
    const later = "2040-01-01T00:00:00+00:00";
    await db.query("update flashcards_private.cards set due_at=$1, revision=1 where id=$2",[later,fact.id]);
    const replay = await ok(wa,"create_cards",batch);
    assert.equal(Date.parse(replay.cards.find(c=>c.id===fact.id).due_at),Date.parse(later));
    const extra = card("Rollback?");
    await denied(wa,"create_cards",{...batch,items:[{kind:"fact",card:extra},{kind:"fact",card:{...fact,front:"Changed"}}]});
    assert.deepEqual((await ok(wa,"get_cards",{ids:[extra.id]})).cards,[]);
    assert.deepEqual((await ok(rb,"get_cards",{ids:[fact.id]})).cards,[]);
    const page = await ok(wa,"get_cards",{limit:2});
    const last = await ok(wa,"get_cards",{limit:2,after:page.next_after});
    assert.equal(last.next_after,null);
    assert.deepEqual([...page.cards,...last.cards],replay.cards);
    await schemaDenied("get_cards",{owner_id:b});
  });

  await t.test("task tools share web revisions, list membership, create receipts and personal Focus", async () => {
    const lists = (await ok(wa,"list_tasks")).lists;
    assert.deepEqual(lists.map(l=>l.kind),["private"]);
    const [other] = (await ok(rb,"list_tasks")).lists;
    const fields = {title:"Fixture", plannedDate:null, plannedTime:null, deadlineDate:null, deadlineTime:null,
      showAfterDate:null, showAfterTime:null};
    const create = {list_id:lists[0].id, request_id:randomUUID(), fields};
    const task = await ok(wa,"create_task",create);
    assert.deepEqual(await ok(wa,"create_task",create),task);
    await denied(wa,"create_task",{...create,list_id:other.id});
    await denied(rb,"complete_task",{task_id:task.id,version:1});
    await schemaDenied("list_tasks",{p_actor:b});
    await db.exec("insert into tasks_private.lists(slot) values(0)");
    const household = (await ok(wa,"list_tasks")).lists.find(l=>l.kind==="household");
    const shared = await ok(wa,"create_task",{...create,list_id:household.id,request_id:randomUUID()});
    await ok(wa,"set_task_focus",{task_id:shared.id,state:"promoted"});
    assert.deepEqual((await ok(wa,"list_tasks")).focus,[{taskId:shared.id,state:"promoted"}]);
    const peer = await ok(rb,"list_tasks");
    assert.deepEqual(peer.tasks.map(t=>t.id),[shared.id]); assert.deepEqual(peer.focus,[]);
    await ok(wa,"update_task",{task_id:shared.id,version:1,fields:{plannedDate:"2040-03-01",plannedTime:"09:00"}});
    await denied(wa,"complete_task",{task_id:shared.id,version:1});
    await ok(wa,"complete_task",{task_id:shared.id,version:2});
    assert.deepEqual((await ok(rb,"list_tasks")).tasks,[]);
    await db.transaction(async tx => {
      await tx.exec("set local role authenticated");
      await tx.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({
        role:"authenticated", sub:a, aud:"authenticated", is_anonymous:false})]);
      const read = await tx.query("select public.tasks_read($1) as data", [a]);
      assert.deepEqual(read.rows[0].data.tasks.map(item=>item.id), [task.id]);
      await tx.query("select public.tasks_complete($1,$2,1)", [a,task.id]);
    });
    assert.deepEqual((await ok(wa,"list_tasks")).tasks,[]);
    // The public web endpoint retains its first-party session check after the implementation moves.
    await assert.rejects(db.transaction(async tx => {
      await tx.exec("set local role authenticated");
      await tx.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({
        role:"authenticated",sub:a,aud:"authenticated",is_anonymous:false,client_id:writer})]);
      await tx.query("select public.tasks_read($1)",[a]);
    }),{code:"42501"});
    await db.query("update neckardt_mcp.clients set data_tools='{}' where client_id=$1",[writer]);
    await denied(wa,"list_tasks",{});
    assert.deepEqual(await list(wa),["get_habit_practice_link"]);
  });
});
