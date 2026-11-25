import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { test } from "node:test";
import { PGlite } from "@electric-sql/pglite";

import { createEvents } from "../supabase/functions/neckardt-apps-mcp/apps/habit-practice/events.ts";

test("only an authorized round delivers the requested detail level, once", async t => {
  const db = new PGlite();
  const query = async (sql, args = []) => (await db.query(sql, args)).rows;
  const scalar = async (sql, args = []) => Object.values((await query(sql, args))[0])[0];
  const owner = randomUUID();
  const other = randomUUID();
  const unsubscribedOwner = randomUUID();
  const round = randomUUID();
  const secret = "whsec_" + randomBytes(32).toString("base64");
  const subscription = { owner_id: owner, id: "test-sub", url: "https://connectors.api.openai.com/fixture",
    secret, expires_at: new Date(Date.now() + 600000).toISOString() };
  const rpc = (action, payload) => scalar("select public.habit_notify_rpc($1,$2)", [action, payload]);
  const admin = () => db.exec("reset role");
  const service = () => db.exec("reset role; set role service_role");
  const asUser = async (id, extra = {}) => {
    await db.exec("reset role; set role authenticated");
    const claims = { sub:id, role:"authenticated", aud:"authenticated", is_anonymous:false, ...extra };
    await query("select set_config('request.jwt.claims',$1,false)", [JSON.stringify(claims)]);
  };
  const arm = id => scalar("select public.habit_notify_arm($1)", [id]);
  const finish = id => query("select * from public.recall_finish_round($1)", [id]);
  const open = (who, id) => query(
    "insert into flashcards_private.practice_rounds(owner_id,round_id) values ($1,$2)", [who, id]);
  try {
    // Only the hosted Vault and pg_net boundaries are stubbed. The production trigger,
    // Finish, Postgres roles, arm, claim and acknowledgment functions all run here.
    await db.exec(`create role anon; create role authenticated; create role service_role; create role supabase_auth_admin;
      create schema auth; create table auth.users(id uuid primary key);
      create function auth.uid() returns uuid stable language sql as $$
        select (current_setting('request.jwt.claims', true)::jsonb->>'sub')::uuid $$;
      grant usage on schema auth to authenticated;
      create schema vault; create table vault.decrypted_secrets(name text, decrypted_secret text);
      insert into vault.decrypted_secrets values
        ('habit_notify_dispatch_url','https://fixture.supabase.co/functions/v1/neckardt-apps-mcp/deliver'),
        ('habit_notify_dispatch_secret',repeat('x',32));
      create schema net; create table net.requests(body jsonb);
      create function net.http_post(url text, body jsonb, headers jsonb, timeout_milliseconds integer)
        returns bigint language plpgsql as $$
        begin
          if headers->>'Authorization' <> 'Bearer ' || repeat('x',32) then raise exception 'Bad dispatch header'; end if;
          insert into net.requests values(body); return 1;
        end $$;`);
    const migrations = new URL("../supabase/migrations/", import.meta.url);
    const files = (await readdir(migrations)).filter(name => name.endsWith(".sql")).sort();
    const detailMigration = files.findIndex(name => name.endsWith("_round_debrief_items.sql"));
    assert.ok(detailMigration > 0);
    for (const name of files.slice(0, detailMigration)) {
      await db.exec(await readFile(new URL(name, migrations), "utf8"));
    }
    for (const who of [owner, other, unsubscribedOwner]) {
      await query("insert into auth.users values ($1)", [who]);
      await query("insert into flashcards_private.app_owner(owner_id) values ($1)", [who]);
    }
    await open(owner, round);
    await asUser(owner);
    await assert.rejects(arm(round), { code: "PT409" });
    await assert.rejects(rpc("subscribe", subscription), { code: "42501" });
    await service();
    assert.equal(await rpc("subscribe", subscription), true);
    await assert.rejects(rpc("subscribe", { ...subscription, url:"https://other.example/" }), { code:"PT409" });
    await assert.rejects(arm(round), { code: "42501" });
    await asUser(other);
    await assert.rejects(arm(round), { code:"42501" });
    await asUser(owner, { client_id:randomUUID() });
    await assert.rejects(arm(round), { code:"42501" });
    await asUser(owner);
    assert.equal(await arm(round), true);
    assert.equal(await arm(round), true);
    await finish(round);
    await finish(round);
    await assert.rejects(arm(round), { code:"42501" });
    await admin();
    // An already-queued delivery must keep the promise made by the older UI.
    for (const name of files.slice(detailMigration)) {
      await db.exec(await readFile(new URL(name, migrations), "utf8"));
    }
    const [request] = await query("select body from net.requests");
    const delivery = request.body;
    assert.deepEqual(Object.keys(delivery), ["delivery_id"]);
    assert.equal(await scalar("select count(*)::integer from net.requests"), 1);
    await query(`update flashcards_private.round_completions
      set outcomes = '{"easy":2,"yes":1,"some text":99,"hard":"private"}' where round_id=$1`, [round]);
    await service();
    const claim = await rpc("claim", delivery);
    assert.deepEqual(claim.outcomes, { easy:2, yes:1 });
    assert.equal(claim.subscription_id, subscription.id);
    assert.equal(claim.secret, secret);
    assert.deepEqual(Object.keys(claim).sort(), [
      "id","delivery_id","subscription_id","url","secret","finished_at","review_count","action_count","superseded_count","outcomes"
    ].sort());
    assert.equal(await rpc("claim", delivery), null);
    await rpc("ack", { ...delivery, http_status:200 });
    await rpc("ack", { ...delivery, http_status:500 });
    await admin();
    assert.equal(await scalar("select state from habit_notify.deliveries"), "accepted");

    // Renewing an existing listener keeps its one-round approval.
    await service();
    await rpc("subscribe", subscription);
    await asUser(owner);
    const legacy = randomUUID();
    await admin();
    await open(owner, legacy);
    await asUser(owner);
    await finish(legacy);
    await admin();
    assert.equal(await scalar("select count(*)::integer from net.requests"), 1);

    // A successful old enrollment cannot authorize delivery to a replacement listener.
    const replaced = randomUUID();
    await open(owner, replaced);
    await asUser(owner);
    await arm(replaced);
    await service();
    await rpc("unsubscribe", subscription);
    await rpc("subscribe", { ...subscription, id:"new-sub" });
    await asUser(owner);
    await finish(replaced);
    await admin();
    assert.equal(await scalar("select count(*)::integer from net.requests"), 1);

    const missingConfig = randomUUID();
    await open(owner, missingConfig);
    await asUser(owner);
    await arm(missingConfig);
    await admin();
    await db.exec("delete from vault.decrypted_secrets");
    await asUser(owner);
    await finish(missingConfig);
    await admin();
    assert.equal(await scalar("select count(*)::integer from flashcards_private.round_completions"), 4);
    assert.equal(await scalar("select state from habit_notify.deliveries where round_id=$1", [missingConfig]), "failed");
    assert.equal(await scalar("select count(*)::integer from net.requests"), 1);

    await t.test("Finish sends ordered snapshots and only the dates assigned by this round", async () => {
      await query("insert into vault.decrypted_secrets values ('habit_notify_dispatch_url',$1), ('habit_notify_dispatch_secret',repeat('x',32))",
        ["https://fixture.supabase.co/functions/v1/neckardt-apps-mcp/deliver"]);
      const roundId = randomUUID();
      const recall = randomUUID(), paired = randomUUID(), skipped = randomUUID(), retired = randomUUID();
      const originalDue = "2026-01-01T00:00:00+00:00";
      const at = new Date().toISOString();
      const nextDue = new Date(Date.now() + 86400000).toISOString();
      const card = (id, kind, name, cue = null) => query(`insert into flashcards_private.cards
        (id,owner_id,kind,front,back,due_at,cue_card_id) values ($1,$2,$3,$4,'Expected answer',$5,$6)`,
        [id, owner, kind, name, originalDue, cue]);
      await card(recall, "habit-recall", "Recall the cue");
      await card(paired, "habit-action", "Take a walk", recall);
      await card(skipped, "habit-action", "Skipped habit");
      await card(retired, "fact", "Retired during round");
      for (const [id, prompt] of [[paired,"Did you walk?"], [skipped,"Did you practice?"]])
        await query(`insert into flashcards_private.action_opportunities
          (owner_id,card_id,prompt,cue,available_at) values ($1,$2,$3,'After lunch',now()-interval '1 hour')`,
          [owner,id,prompt]);
      // A second owner may legitimately use the very same client-chosen round ID.
      await open(other, roundId);
      await query(`insert into flashcards_private.round_items
        (owner_id,round_id,position,item_kind,card_id,revision,front,back,paired_action)
        values ($1,$2,0,'review',$3,0,'Unrelated owner','Unrelated answer',false)`, [other,roundId,randomUUID()]);
      await asUser(owner);
      const manifest = await query("select * from public.recall_open_round($1)", [roundId]);
      assert.equal(manifest.length, 4);
      await asUser(other, {client_id:randomUUID()});
      await assert.rejects(scalar("select public.habit_notify_arm($1,true)", [roundId]), {code:"42501"});
      await asUser(owner);
      await arm(roundId); // Upgrade a legacy opt-in only through the detailed UI.
      assert.equal(await scalar("select public.habit_notify_arm($1,true)", [roundId]), true);
      await arm(roundId); // A replay from an old tab keeps the explicit choice.
      const row = id => manifest.find(item => item.card_id === id);
      await query("select * from public.recall_record_action($1,$2,$3,0,'skip',$4)",
        [row(skipped).event_id,row(skipped).opportunity_id,skipped,at]);
      await service();
      for (const [id, grade] of [[recall,"hard"], [paired,"medium"]]) {
        await query(`select * from public.recall_commit_answer($1,$2,$3,0,$4,$5,$6,
          '{}'::jsonb,'{}'::jsonb,'test','{}'::jsonb,$7)`,
          [owner,row(id).event_id,id,grade,at,nextDue,row(id).opportunity_id]);
      }
      await admin();
      await query("update flashcards_private.cards set active=false where id=$1", [retired]);
      await asUser(owner);
      await finish(roundId);
      await finish(roundId);
      await admin();
      await query("update flashcards_private.cards set front='Later edit',due_at=now()+interval '9 days' where owner_id=$1", [owner]);
      const deliveryId = await scalar("select delivery_id from habit_notify.deliveries where round_id=$1", [roundId]);
      const messages = [];
      const dispatch = randomBytes(32).toString("hex");
      const events = createEvents(rpc, dispatch, async (_url, post) => {
        messages.push(JSON.parse(post.body));
        return {status:200,body:""};
      });
      const dispatchRequest = () => new Request("https://fixture.invalid/deliver", {
        method:"POST",headers:{Authorization:"Bearer " + dispatch},body:JSON.stringify({delivery_id:deliveryId})
      });
      await service();
      assert.equal((await events.deliver(dispatchRequest())).status, 204);
      assert.equal((await events.deliver(dispatchRequest())).status, 204);
      assert.equal(messages.length, 1);
      const { data } = messages[0];
      assert.equal(data.round_id, roundId);
      assert.deepEqual(data.outcomes, {hard:1, yes:1, skip:1});
      assert.deepEqual([data.review_count,data.action_count,data.superseded_count], [1,2,1]);
      assert.deepEqual(data.items.map(i => i.card_id), manifest.map(i => i.card_id));
      for (const [position, item] of data.items.entries()) {
        const orig = manifest[position], id = orig.card_id;
        const scheduled = id === recall || id === paired;
        const iso = time => time === null ? null : new Date(time).toISOString();
        assert.deepEqual({ ...item, answered_at:iso(item.answered_at), next_due_at:iso(item.next_due_at) }, {
          position, card_id:id, item_kind:orig.item_kind,
          card_name: id === paired ? "Take a walk" : id === skipped ? "Skipped habit" : orig.front,
          front:orig.front, back:orig.back,
          answer: id === paired ? "yes" : id === recall ? "hard" : id === skipped ? "skip" : "superseded",
          grade: id === paired ? "medium" : id === recall ? "hard" : null,
          due_at: orig.item_kind === "review" ? originalDue : null,
          answered_at: id === retired ? null : at,
          next_due_at: scheduled ? nextDue : null,
        });
      }
    });

    await admin();
    const beforeRevocationChecks = await scalar("select count(*)::integer from net.requests");
    const automatic = { ...subscription, id:"automatic" };
    const register = () => scalar("select public.habit_notify_subscribe_automatic($1)", [automatic]);
    await asUser(owner);
    await assert.rejects(register(), { code:"42501" });
    await service();
    await rpc("unsubscribe", { ...subscription, id:"new-sub" });
    await register();

    // Preserve the first-party claims while creating synthetic round rows for the trigger.
    const start = async (who, claims = {}) => {
      await asUser(who, claims);
      await admin();
      const id = randomUUID();
      await open(who, id);
      return id;
    };
    const delegated = await start(owner, { client_id:randomUUID() });
    await asUser(owner);
    await finish(delegated);
    const unrelated = await start(unsubscribedOwner);
    await asUser(unsubscribedOwner);
    await finish(unrelated);
    const expired = await start(owner);
    await admin();
    await query("update habit_notify.listeners set expires_at = now() - interval '1 second' where owner_id=$1", [owner]);
    await asUser(owner);
    await finish(expired);
    await service();
    await register();
    const revoked = await start(owner);
    await service();
    await rpc("unsubscribe", automatic);
    await register();
    await asUser(owner);
    await finish(revoked);
    await admin();
    assert.equal(await scalar("select count(*)::integer from net.requests"), beforeRevocationChecks);
  } finally {
    await db.close();
  }
});
