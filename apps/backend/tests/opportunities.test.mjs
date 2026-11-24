import { randomUUID } from "node:crypto";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { legacyAnswerRow } from "./legacy-answer-row.mjs";

const migration = "20261122013041_recall_opportunities.sql";
async function fixture(imports, { beforeMigration = async () => undefined } = {}) {
  const db = new PGlite();
  const q = async (sql, params = []) => (await db.query(sql, params)).rows;
  const owner = randomUUID(), other = randomUUID();
  await db.exec(`create role anon nologin; create role authenticated nologin; create role service_role nologin;
    create schema auth; create table auth.users(id uuid primary key);
    create function auth.uid() returns uuid stable language sql as $$
      select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid
    $$; grant usage on schema auth to anon,authenticated,service_role;`);
  for (const file of ["20261121000000_demo_flashcards.sql", "20261121000100_recall_fsrs_synthetic.sql"]) {
    await db.exec(await readFile(new URL("../supabase/migrations/" + file, import.meta.url), "utf8"));
  }
  await q("insert into auth.users values($1),($2)", [owner, other]);
  await q("insert into flashcards_private.app_owner(owner_id) values($1)", [owner]);
  const cards = await q(`insert into flashcards_private.cards(owner_id,front,back,due_at)
    select $1,'Synthetic question '||i,'Synthetic answer '||i,now()-interval '1 hour'
    from generate_series(1,105) i returning id`, [owner]);
  if (imports) {
    await db.exec(`create table flashcards_private.notion_imports(owner_id uuid,card_id uuid,kind text,source_doc jsonb);
      alter table flashcards_private.notion_imports enable row level security;
      revoke all on flashcards_private.notion_imports from public,anon,authenticated,service_role;`);
    for (const [i, kind] of ["habit-action", "reflection", "unrecognized", "habit-recall", "fact"].entries()) {
      await q("insert into flashcards_private.notion_imports values($1,$2,$3,'{}')", [owner, cards[i].id, kind]);
    }
  }
  const role = async (name, id = "") => {
    await db.exec("reset role; set role " + name);
    await q("select set_config('request.jwt.claim.sub',$1,false)", [id]);
  };
  const context = { db, q, owner, other, cards, role };
  const before = await beforeMigration(context);
  await db.exec("reset role");
  await db.exec(await readFile(new URL("../supabase/migrations/" + migration, import.meta.url), "utf8"));
  return { ...context, before };
}

test("new recall read contract filters imported action/unsupported kinds without exposing imports", async () => {
  const { db, q, owner, other, cards, role } = await fixture(true);
  try {
    for (const [name, id] of [["anon", ""], ["service_role", ""], ["authenticated", other], ["authenticated", ""]]) {
      await role(name, id);
      await assert.rejects(q("select * from public.recall_due(100)"), { code: "42501" });
      await assert.rejects(q("select * from public.recall_opportunities(100)"), { code: "42501" });
    }
    await role("authenticated", owner);
    const due = await q("select * from public.recall_due(1000)");
    assert.equal(due.length, 100);
    for (const card of cards.slice(0, 3)) assert(!due.some(row => row.card_id === card.id));
    const all = await q("select id from flashcards_private.cards");
    assert.equal(all.length, 105); // Existing grants remain exactly as before.
    await assert.rejects(q("select * from flashcards_private.notion_imports"), { code: "42501" });
    await assert.rejects(q("select source_doc from flashcards_private.notion_imports"), { code: "42501" });
    await assert.rejects(q("select * from flashcards_private.action_opportunities"), { code: "42501" });
    await assert.rejects(q("select * from flashcards_private.action_responses"), { code: "42501" });
    await assert.rejects(q("select flashcards_private.recall_card_supported($1,$2)", [owner,cards[0].id]), { code: "42501" });
    assert.equal((await q("select * from public.recall_due(1)")).length, 1);
  } finally { await db.close(); }
});

test("optional migration also supports an unimported deck", async () => {
  const { db, q, owner, role } = await fixture(false);
  try {
    await role("authenticated", owner);
    assert.equal((await q("select * from public.recall_due()")).length, 100);
    assert.deepEqual(await q("select * from public.recall_opportunities()"), []);
  } finally { await db.close(); }
});

test("actual opportunities store idempotent actions, keep no-op/skip occasions open, and never touch FSRS", async () => {
  const { db, q, owner, other, cards, role } = await fixture(true);
  const sql = "select public.recall_record_action($1,$2,$3,$4,$5,$6) result";
  const recorded = new Date().toISOString();
  try {
    const opportunities = await q(`insert into flashcards_private.action_opportunities(owner_id,card_id,prompt,cue,available_at)
      select $1,$2,'Synthetic actual occasion '||i,'A specific synthetic cue',now()-interval '1 hour'
      from generate_series(1,5) i returning *`, [owner,cards[0].id]);
    const before = await q("select * from flashcards_private.cards order by id");
    const makeArgs = (i, outcome) => [randomUUID(),opportunities[i].opportunity_id,cards[0].id,0,outcome,recorded];
    const yes = makeArgs(0,"yes"), no = makeArgs(1,"no"), none = makeArgs(2,"no_opportunity"), skip = makeArgs(3,"skip");
    for (const [name,id] of [["anon",""],["service_role",""],["authenticated",other],["authenticated",""]]) {
      await role(name,id);
      await assert.rejects(q(sql, yes), { code: "42501" });
    }
    await role("authenticated",owner);
    for (const args of [yes,no,none,skip]) {
      const saved = (await q(sql,args))[0].result;
      assert.equal(saved.action_id,args[0]);
      assert.equal(saved.outcome,args[4]);
      assert.deepEqual((await q(sql,args))[0].result,saved);
    }
    const available = await q("select * from public.recall_opportunities(100)");
    assert.equal(available.length,3);
    assert(available.some(row => row.opportunity_id === none[1]));
    assert(available.some(row => row.opportunity_id === skip[1]));
    await assert.rejects(q(sql,[randomUUID(),...yes.slice(1)]),{code:"PT409"});
    await assert.rejects(q(sql,[yes[0],yes[1],yes[2],0,"no",recorded]),{code:"22023"});
    await assert.rejects(q(sql,[randomUUID(),opportunities[4].opportunity_id,cards[0].id,1,"yes",recorded]),{code:"PT409"});
    await assert.rejects(q(sql,[randomUUID(),opportunities[4].opportunity_id,cards[1].id,0,"yes",recorded]),{code:"PT409"});
    await assert.rejects(q(sql,[randomUUID(),randomUUID(),cards[0].id,0,"yes",recorded]),{code:"PT404"});
    await assert.rejects(q(sql,makeArgs(4,"easy")),{code:"22023"});
    await assert.rejects(q(sql,[...makeArgs(4,"yes").slice(0,5),"infinity"]),{code:"22023"});
    await assert.rejects(q(sql,[...makeArgs(4,"yes").slice(0,5),"2099-01-01T00:00:00Z"]),{code:"22023"});
    await assert.rejects(q("update flashcards_private.action_opportunities set revision=1"),{code:"42501"});
    await assert.rejects(q("delete from flashcards_private.action_responses"),{code:"42501"});
    // A later Yes can consume an occasion previously skipped or reported absent.
    await q(sql,makeArgs(2,"yes"));
    assert.equal((await q("select * from public.recall_opportunities(100)")).length,2);
    await db.exec("reset role");
    assert.equal((await q("select * from flashcards_private.action_responses")).length,5);
    assert.equal((await q("select * from flashcards_private.reviews")).length,0);
    assert.deepEqual(await q("select * from flashcards_private.cards order by id"),before);
    // Metadata changes cannot invalidate a committed response replay.
    await q("update flashcards_private.action_opportunities set active=false,revision=1 where opportunity_id=$1",[yes[1]]);
    await role("authenticated",owner);
    assert.equal((await q(sql,yes))[0].result.action_id,yes[0]);
  } finally { await db.close(); }
});

test("a valid offline action can arrive after expiry without losing replay safety", async () => {
  const { db, q, owner, cards, role } = await fixture(false);
  const sql = "select public.recall_record_action($1,$2,$3,$4,$5,$6) result";
  try {
    const opportunities = await q(`insert into flashcards_private.action_opportunities
      (owner_id,card_id,prompt,available_at,expires_at)
      select $1,$2,'Synthetic elapsed occasion '||i,now()-interval '2 hours',now()-interval '1 hour'
      from generate_series(1,4) i returning *`, [owner,cards[0].id]);
    const timeInsideWindow = new Date(new Date(opportunities[0].expires_at).getTime()-1000).toISOString();
    const args = [randomUUID(),opportunities[0].opportunity_id,cards[0].id,0,"yes",timeInsideWindow];
    await q("update flashcards_private.action_opportunities set active=false where opportunity_id=$1",[opportunities[2].opportunity_id]);
    await q("update flashcards_private.action_opportunities set revision=1 where opportunity_id=$1",[opportunities[3].opportunity_id]);
    await role("authenticated",owner);
    assert.deepEqual(await q("select * from public.recall_opportunities()"),[]);
    const receipt = (await q(sql,args))[0].result;
    assert.equal(receipt.action_id,args[0]);
    assert.deepEqual((await q(sql,args))[0].result,receipt);
    // Delivery time may be late; the reported answer must still be in-window.
    await assert.rejects(q(sql,[randomUUID(),opportunities[1].opportunity_id,cards[0].id,0,"yes",new Date().toISOString()]),{code:"22023"});
    await assert.rejects(q(sql,[randomUUID(),opportunities[1].opportunity_id,cards[0].id,0,"yes","2000-01-01T00:00:00Z"]),{code:"22023"});
    for (const i of [2,3]) {
      await assert.rejects(q(sql,[randomUUID(),opportunities[i].opportunity_id,cards[0].id,0,"yes",timeInsideWindow]),{code:"PT409"});
    }
    await db.exec("reset role");
    assert.equal((await q("select * from flashcards_private.action_responses")).length,1);
    assert.equal((await q("select * from flashcards_private.reviews")).length,0);
  } finally { await db.close(); }
});

test("legacy grading rejects unsupported pending cards at prepare and commit but replays prior receipts", async () => {
  const { db, q, owner, cards, role } = await fixture(true);
  const { gradeHandler, schedulerFor } = await import("../supabase/functions/recall-grade/grade.mjs");
  const fsrsLib = await import("ts-fsrs");
  const params = p => [p.p_owner,p.p_review_id,p.p_card_id,p.p_revision,p.p_grade,p.p_reviewed_at];
  const contextSQL = "select public.recall_grade_context($1,$2,$3,$4,$5,$6) result";
  const commitSQL = "select public.recall_commit_review($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) result";
  let scheduleCalls = 0;
  const schedule = schedulerFor(fsrsLib);
  const handler = gradeHandler({
    getOwner: async () => owner,
    prepare: async p => legacyAnswerRow((await q(contextSQL,params(p)))[0].result, p),
    commit: async p => (await q(commitSQL,[...params(p),p.p_due_at,p.p_state,p.p_log,p.p_scheduler_build,p.p_scheduler_config]))[0].result,
    schedule: (...args) => { scheduleCalls++; return schedule(...args); }
  });
  const post = event => handler(new Request("https://fixture.invalid/recall-grade",{
    method:"POST", headers:{authorization:"Bearer synthetic"}, body:JSON.stringify(event)
  }));
  const makeEvent = index => ({ review_id:randomUUID(),card_id:cards[index].id,revision:0,grade:"medium",reviewed_at:new Date().toISOString() });
  try {
    await role("authenticated",owner);
    await assert.rejects(q(contextSQL,[owner,randomUUID(),cards[3].id,0,"medium",new Date().toISOString()]),{code:"42501"});
    await role("service_role");
    for (const i of [0,1,2]) assert.equal((await post(makeEvent(i))).status,422);
    assert.equal(scheduleCalls,0);
    const event = makeEvent(3);
    const first = await post(event);
    assert.equal(first.status,200);
    const saved = await first.json();
    assert.equal(scheduleCalls,1);
    // Changing import kind after prepare cannot sneak through locked commit.
    const contender = makeEvent(4);
    const contenderParams = [owner,contender.review_id,contender.card_id,0,contender.grade,contender.reviewed_at];
    const context = (await q(contextSQL,contenderParams))[0].result;
    const row = legacyAnswerRow(context, {
      p_review_id: contender.review_id, p_card_id: contender.card_id, p_revision: contender.revision
    });
    const calculated = schedule(row,contender.grade,contender.reviewed_at);
    await db.exec("reset role");
    await q("update flashcards_private.notion_imports set kind='habit-action' where card_id in ($1,$2)",[cards[3].id,cards[4].id]);
    await role("service_role");
    await assert.rejects(q(commitSQL,[...contenderParams,calculated.dueAt,calculated.state,calculated.log,calculated.build,calculated.config]),{code:"22023"});
    const replay = await post(event);
    assert.equal(replay.status,200);
    assert.deepEqual(await replay.json(),saved);
    assert.equal(scheduleCalls,1);
    assert.equal((await post({...event,review_id:randomUUID(),revision:1})).status,422);
    await db.exec("reset role");
    assert.equal((await q("select * from flashcards_private.reviews")).length,1);
    assert.equal((await q("select revision from flashcards_private.cards where id=$1",[cards[3].id]))[0].revision,1);
  } finally { await db.close(); }
});

async function legacyDueContract({ q, owner, other, role }) {
  const metadata = (await q(`select p.oid, p.proname, p.proowner::regrole::text as owner,
    pg_get_function_identity_arguments(p.oid) as identity_args,
    pg_get_function_arguments(p.oid) as arguments,
    pg_get_function_result(p.oid) as result,
    p.prosecdef, p.provolatile, p.proconfig, p.proacl::text as acl
    from pg_proc p where p.oid='public.demo_flashcards_due(integer)'::regprocedure`))[0];
  assert.equal(metadata.identity_args,"p_limit integer");
  assert.equal(metadata.arguments,"p_limit integer DEFAULT 5");
  assert.equal(metadata.result,"TABLE(card_id uuid, front text, back text, revision integer, due_at timestamp with time zone)");
  assert.equal(metadata.prosecdef,false);
  assert.equal(metadata.provolatile,"s");
  assert.deepEqual(metadata.proconfig,['search_path=""']);
  assert.equal(metadata.acl,"{postgres=X/postgres,authenticated=X/postgres}");
  for (const [name,id] of [["anon",""],["service_role",""],["authenticated",other],["authenticated",""]]) {
    await role(name,id);
    await assert.rejects(q("select * from public.demo_flashcards_due()"),{code:"42501"});
    await assert.rejects(q("select * from public.demo_flashcards_due(2147483647)"),{code:"42501"});
  }
  await role("authenticated",owner);
  const behavior = [];
  for (const [argument,expected] of [["",5],["null",5],["-2147483648",1],["-1",1],["0",1],["1",1],["3",3],["5",5],["6",5],["2147483647",5]]) {
    const rows = await q(`select * from public.demo_flashcards_due(${argument})`);
    assert.equal(rows.length,expected);
    for (const row of rows) {
      assert.deepEqual(Object.keys(row),["card_id","front","back","revision","due_at"]);
      assert.equal(typeof row.card_id,"string");
      assert.equal(typeof row.front,"string");
      assert.equal(typeof row.back,"string");
      assert.equal(typeof row.revision,"number");
      assert(Number.isFinite(new Date(row.due_at).getTime()));
    }
    behavior.push({argument,size:rows.length,shape:Object.keys(rows[0])});
  }
  return { metadata, behavior };
}

test("legacy due bridge preserves its SQL and authorization contract while filtering before the five-card limit", async () => {
  const context = await fixture(true, { beforeMigration: async state => {
    const { q, owner, cards } = state;
    // Four unsupported cards are strictly earlier than every supported card.
    // A filter after LIMIT would leave fewer than five cards in the round.
    await q("insert into flashcards_private.notion_imports values($1,$2,null,'{}')",[owner,cards[5].id]);
    await q(`update flashcards_private.cards set due_at=now()-interval '2 hours'
      where id in ($1,$2,$3,$4)`,[cards[0].id,cards[1].id,cards[2].id,cards[5].id]);
    await q(`update flashcards_private.cards set due_at=now()-interval '90 minutes'
      where id in ($1,$2)`,[cards[3].id,cards[4].id]);
    const contract = await legacyDueContract(state);
    const legacyRows = await q("select * from public.demo_flashcards_due()");
    for (const i of [0,1,2,5]) assert(legacyRows.some(row=>row.card_id===cards[i].id));
    return contract;
  }});
  const { db, q, owner, cards, role, before } = context;
  try {
    const after = await legacyDueContract(context);
    assert.deepEqual(after,before); // Includes the same function OID and exact ACL.
    await role("authenticated",owner);
    const legacy = await q("select * from public.demo_flashcards_due()");
    const modern = await q("select * from public.recall_due(2147483647)");
    assert.equal(legacy.length,5);
    assert.equal(modern.length,100);
    assert.deepEqual(legacy,modern.slice(0,5));
    assert.equal((await q("select * from public.recall_due()")).length,100);
    for (const i of [0,1,2,5]) {
      assert(!legacy.some(row=>row.card_id===cards[i].id));
      assert(!modern.some(row=>row.card_id===cards[i].id));
    }
    for (const i of [3,4]) assert(legacy.some(row=>row.card_id===cards[i].id));
    for (const roleName of ["anon","authenticated","service_role"]) {
      assert.equal((await q("select has_function_privilege($1,'flashcards_private.recall_card_supported(uuid,uuid)','EXECUTE') as allowed",[roleName]))[0].allowed,false);
    }
    await assert.rejects(q("select flashcards_private.recall_card_supported($1,$2)",[owner,cards[3].id]),{code:"42501"});
  } finally { await db.close(); }
});

test("the compatibility upgrade preserves exact pre-migration grade receipts without permitting new unsupported grades", async () => {
  const { gradeHandler, schedulerFor } = await import("../supabase/functions/recall-grade/grade.mjs");
  const fsrsLib = await import("ts-fsrs");
  const contextSQL = "select public.recall_grade_context($1,$2,$3,$4,$5,$6) result";
  const commitSQL = "select public.recall_commit_review($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) result";
  const fields = p => [p.p_owner,p.p_review_id,p.p_card_id,p.p_revision,p.p_grade,p.p_reviewed_at];
  const makeHandler = (q,owner,schedule) => gradeHandler({
    getOwner: async () => owner,
    prepare: async p => legacyAnswerRow((await q(contextSQL,fields(p)))[0].result, p),
    commit: async p => (await q(commitSQL,[...fields(p),p.p_due_at,p.p_state,p.p_log,p.p_scheduler_build,p.p_scheduler_config]))[0].result,
    schedule
  });
  const post = (handler,event) => handler(new Request("https://fixture.invalid/recall-grade",{
    method:"POST",headers:{authorization:"Bearer synthetic"},body:JSON.stringify(event)
  }));
  const context = await fixture(true, { beforeMigration: async ({ db,q,owner,cards,role }) => {
    // The old backend allowed this synthetic imported action-card review.
    // Preserve its receipt across the upgrade without repeating its side effect.
    const event = {review_id:randomUUID(),card_id:cards[0].id,revision:0,grade:"medium",reviewed_at:new Date().toISOString()};
    await role("service_role");
    const response = await post(makeHandler(q,owner,schedulerFor(fsrsLib)),event);
    assert.equal(response.status,200);
    const receipt = await response.json();
    await db.exec("reset role");
    return {event,receipt,reviews:await q("select * from flashcards_private.reviews"),
      card:(await q("select * from flashcards_private.cards where id=$1",[event.card_id]))[0]};
  }});
  const { db,q,owner,role,before } = context;
  let scheduleCalls = 0;
  const handler = makeHandler(q,owner,()=>{ scheduleCalls++; throw Error("Replay must not reschedule"); });
  try {
    await role("service_role");
    const replay = await post(handler,before.event);
    assert.equal(replay.status,200);
    assert.deepEqual(await replay.json(),before.receipt);
    assert.equal(scheduleCalls,0);
    assert.equal((await post(handler,{...before.event,review_id:randomUUID(),revision:1})).status,422);
    assert.equal((await post(handler,{...before.event,grade:"easy"})).status,422);
    await db.exec("reset role");
    assert.deepEqual(await q("select * from flashcards_private.reviews"),before.reviews);
    assert.deepEqual((await q("select * from flashcards_private.cards where id=$1",[before.event.card_id]))[0],before.card);
    // The next migration gives imported cards explicit kinds. Apply it with
    // real scheduling history and then take the old import archive offline.
    for (const file of ["20261124045149_enroll_multiple_habit_practice_owners.sql",
      "20261124050000_paired_habit_answers.sql"]) {
      await db.exec(await readFile(new URL("../supabase/migrations/" + file, import.meta.url), "utf8"));
    }
    await db.exec("alter table flashcards_private.notion_imports rename to archived_notion_imports");
    const upgraded = (await q("select * from flashcards_private.cards where id=$1", [before.event.card_id]))[0];
    for (const key of Object.keys(before.card)) assert.deepEqual(upgraded[key], before.card[key], key);
    assert.equal(upgraded.kind, "habit-action");
    assert.equal(upgraded.cue_card_id, null);
    assert.deepEqual(await q("select * from flashcards_private.reviews"), before.reviews);
    const kinds = await q(`select kind, flashcards_private.recall_card_supported(owner_id, id) as enabled
      from flashcards_private.cards where owner_id=$1 and front = any($2::text[]) order by front`,
      [owner, ["Synthetic question 1","Synthetic question 2","Synthetic question 3","Synthetic question 4","Synthetic question 5"]]);
    assert.deepEqual(kinds, [
      { kind: "habit-action", enabled: false }, { kind: "reflection", enabled: false },
      { kind: "unsupported", enabled: false }, { kind: "habit-recall", enabled: true },
      { kind: "fact", enabled: true }
    ]);
    await role("service_role");
    assert.deepEqual(await (await post(handler, before.event)).json(), before.receipt);
    assert.equal(scheduleCalls, 0);
  } finally { await db.close(); }
});
