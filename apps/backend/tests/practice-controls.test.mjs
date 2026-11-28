import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { test } from "node:test";
import { PGlite } from "@electric-sql/pglite";

test("the next round, card status and reversible selection agree for the signed-in deck", async () => {
  const db = new PGlite();
  const query = async (sql, args = []) => (await db.query(sql, args)).rows;
  const owner = randomUUID(), other = randomUUID();
  const [cue, action, legacy, future, otherCard] = Array.from({ length: 5 }, () => randomUUID());
  const asOwner = async id => {
    await db.exec("reset role; set role authenticated");
    await query("select set_config('request.jwt.claim.sub', $1, false)", [id]);
  };
  const preview = async () => (await query("select * from public.recall_round_preview()"))[0];
  const catalog = () => query("select * from public.recall_browse_cards()");
  const setActive = (ids, active) => query("select public.recall_set_cards_active($1,$2)", [ids, active]);
  try {
    await db.exec(`
      create role anon; create role authenticated; create role service_role; create role supabase_auth_admin;
      create schema auth; create table auth.users(id uuid primary key);
      create function auth.uid() returns uuid stable language sql as $$
        select nullif(current_setting('request.jwt.claim.sub', true),'')::uuid $$;
      grant usage on schema auth to anon, authenticated, service_role;`);
    const dir = new URL("../supabase/migrations/", import.meta.url);
    for (const file of (await readdir(dir)).filter(name => name.endsWith(".sql")).sort()) {
      await db.exec(await readFile(new URL(file, dir), "utf8"));
    }
    await query("insert into auth.users values ($1),($2)", [owner, other]);
    await query("insert into flashcards_private.app_owner(owner_id) values ($1),($2)", [owner, other]);
    await query(`insert into flashcards_private.cards(owner_id,id,kind,front,back,due_at)
      values ($1,$2,'habit-recall','Cue','Answer',now()-interval '3 days'),
        ($1,$3,'habit-action','Legacy','Ledger only',now()),
        ($1,$4,'fact','Future','Future answer',now()+interval '1 day'),
        ($5,$6,'fact','Other owner','Private answer',now())`,[owner,cue,legacy,future,other,otherCard]);
    await query(`insert into flashcards_private.cards(owner_id,id,kind,cue_card_id,front,back)
      values ($1,$2,'habit-action',$3,'Paired action','Criterion')`, [owner,action,cue]);
    const facts = (await query(`insert into flashcards_private.cards(owner_id,front,back)
      select $1,'Fact '||i,'Answer' from generate_series(1,7) i returning id`, [owner])).map(c => c.id);
    await query(`insert into flashcards_private.action_opportunities(owner_id,card_id,prompt)
      values ($1,$2,'Real fixture occasion'), ($1,$3,'Legacy fixture occasion')`, [owner,action,legacy]);

    // Nonempty scheduling state and a previous grade must survive a pause.
    await query(`update flashcards_private.cards set revision=1, last_review_at=now()-interval '4 days',
      scheduler_state='{"reps":1,"stability":3}' where id=$1`, [cue]);
    await query(`insert into flashcards_private.reviews
      (owner_id,review_id,card_id,card_revision,grade,reviewed_at,next_due_at,fsrs_log,after_state,scheduler_build,scheduler_config)
      select owner_id,$2,id,0,'medium',last_review_at,due_at,'{}',scheduler_state,'fixture','{}'
      from flashcards_private.cards where id=$1`, [cue,randomUUID()]);
    const rowsBefore = await query("select * from flashcards_private.cards order by id");
    const historyBefore = await query("select * from flashcards_private.reviews");

    await db.exec("set role anon");
    await assert.rejects(preview(), {code:"42501"});
    await assert.rejects(setActive([cue],false), {code:"42501"});
    await asOwner(owner);
    assert.equal((await preview()).due_reviews,8);
    assert.equal((await preview()).check_ins,2);
    assert.ok((await preview()).next_review_at);
    assert.deepEqual(await query("select * from public.recall_latest_round()"),[]);
    assert.equal((await catalog()).find(c=>c.card_id===action).cue_card_id,cue);
    await assert.rejects(setActive([cue,otherCard], false),{code:"22023"});
    await assert.rejects(setActive([cue,cue], false),{code:"22023"});
    await assert.rejects(setActive([],false),{code:"22023"});
    assert.equal((await catalog()).find(c=>c.card_id===cue).active,true);
    await setActive([action],false);
    assert.equal((await preview()).due_reviews,8);
    await setActive([action],true);
    await setActive([cue],false);
    const partner=(await catalog()).find(c=>c.card_id===action);
    assert.equal(partner.active,true);
    assert.equal(partner.check_in_available,false);
    assert.equal((await preview()).check_ins,1);
    await setActive([cue],true);
    const six=[cue,action,legacy,...facts.slice(0,3)];
    await setActive(six,false);
    await setActive(six,false);
    assert.equal((await catalog()).filter(c=>!c.active).length,6);
    assert.equal((await preview()).check_ins,0);
    assert.deepEqual(await query("select * from public.recall_opportunities()"),[]);
    await setActive(six,true);
    await db.exec("reset role");
    assert.deepEqual(await query("select * from flashcards_private.cards order by id"),rowsBefore);
    assert.deepEqual(await query("select * from flashcards_private.reviews"),historyBefore);

    await asOwner(owner);
    await assert.rejects(query("select * from public.recall_open_round($1,0)",[randomUUID()]),{code:"22023"});
    const opened=await query("select * from public.recall_open_round($1,1)",[randomUUID()]);
    assert.deepEqual(opened.map(row=>row.item_kind),["action","action","review"]);
    assert.deepEqual(await query("select * from public.recall_open_round($1,20)",[randomUUID()]),opened);
    await asOwner(other);
    assert.equal((await preview()).due_reviews,1);
    assert.equal((await catalog()).length,1);
    await setActive([otherCard],false);
    assert.equal((await preview()).due_reviews,0);
    assert.deepEqual(await query("select * from public.recall_open_round($1)",[randomUUID()]),[]);
    assert.deepEqual(await query("select * from public.recall_latest_round()"),[]);
  } finally { await db.close(); }
});
