import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { test } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import * as fsrs from "ts-fsrs";
import { schedulerFor } from "../supabase/functions/recall-grade/grade.mjs";

test("only disposable users can reset and expire, preserving other owners and their review history", async () => {
  const db = new PGlite();
  const query = async (sql, params = []) => (await db.query(sql, params)).rows;
  const asUser = async id => {
    await db.exec("reset role; set role authenticated");
    await query("select set_config('request.jwt.claim.sub', $1, false)", [id]);
  };
  const reset = async () => (await query("select public.recall_reset_fixture() as card"))[0].card;
  const snapshot = async owner => {
    const result = {};
    for (const table of ["app_owner", "cards", "reviews", "action_opportunities", "action_responses"]) {
      result[table] = await query(`select * from flashcards_private.${table} where owner_id = $1`, [owner]);
    }
    result.auth = await query("select * from auth.users where id = $1", [owner]);
    return result;
  };
  const grade = async (owner, card) => {
    const when = new Date().toISOString();
    const next = schedulerFor(fsrs)({ state: null, due_at: when }, "medium", when);
    await query("select public.recall_commit_review($1,$2,$3,0,'medium',$4,$5,$6,$7,$8,$9)",
      [owner, randomUUID(), card, when, next.dueAt, next.state, next.log, next.build, next.config]);
  };
  try {
    await db.exec(`create role anon; create role authenticated; create role service_role; create role supabase_auth_admin;
      create schema auth;
      create table auth.users(id uuid primary key, email text, raw_app_meta_data jsonb, raw_user_meta_data jsonb, created_at timestamptz);
      create function auth.uid() returns uuid language sql stable as $$
        select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
      grant usage on schema auth to authenticated;`);
    const migrations = new URL("../supabase/migrations/", import.meta.url);
    for (const name of (await readdir(migrations)).filter(name => name.endsWith(".sql")).sort()) {
      await db.exec(await readFile(new URL(name, migrations), "utf8"));
    }

    const [ordinary, workerA, workerB, spoofed, mislabeled] = Array.from({ length: 5 }, () => randomUUID());
    const marker = { neckardt_fixture: "habit-practice-v1" };
    const workerEmail = id => `worker-${id}@example.test`;
    for (const fields of [
      [ordinary, "ordinary@example.test", {}, {}, "7 days"],
      [workerA, workerEmail(workerA), marker, {}, "49 hours"],
      [workerB, workerEmail(workerB), marker, {}, "47 hours"],
      [spoofed, workerEmail(spoofed), {}, marker, "7 days"],
      [mislabeled, "other@example.test", marker, {}, "7 days"]
    ]) {
      await query("insert into auth.users values ($1,$2,$3,$4,now() - $5::interval)", fields);
    }
    await query("insert into flashcards_private.app_owner(owner_id) values ($1)", [ordinary]);
    const [{ id: originalCard }] = await query(`insert into flashcards_private.cards(owner_id, front, back)
      values ($1, 'Personal card', 'Personal answer') returning id`, [ordinary]);
    await grade(ordinary, originalCard);
    const [{ opportunity_id: opportunity }] = await query(`insert into flashcards_private.action_opportunities(owner_id,card_id,prompt)
      values ($1,$2,'Did it happen?') returning opportunity_id`, [ordinary, originalCard]);
    await query(`insert into flashcards_private.action_responses(owner_id,action_id,opportunity_id,card_id,revision,outcome,answered_at)
      values ($1,$2,$3,$4,0,'yes',now())`, [ordinary, randomUUID(), opportunity, originalCard]);
    const original = await snapshot(ordinary);
    assert.ok(Object.values(original).every(rows => rows.length === 1));
    assert.equal(original.cards[0].revision, 1);

    await db.exec("set role anon");
    await assert.rejects(reset(), { code: "42501" });
    for (const id of [ordinary, spoofed, mislabeled]) {
      await asUser(id);
      await assert.rejects(reset(), { code: "42501" });
    }
    await asUser(workerB);
    const cardB = await reset();
    await asUser(workerA);
    const first = await reset();
    await db.exec("reset role");
    await grade(workerA, first);
    await asUser(workerA);
    const second = await reset();
    assert.notEqual(first, second);
    assert.deepEqual(await query("select card_id, revision from public.recall_due()"), [{ card_id: second, revision: 0 }]);
    await assert.rejects(query("select flashcards_private.clear_worker_deck($1)", [ordinary]), { code: "42501" });
    await assert.rejects(query("select flashcards_private.expire_habit_fixtures()"), { code: "42501" });

    await db.exec("reset role");
    assert.deepEqual((await snapshot(workerA)).reviews, []);
    await grade(workerA, second);
    // The hosted cron job calls this same owner-only function.
    await query("select flashcards_private.expire_habit_fixtures()");
    assert.ok(Object.values(await snapshot(workerA)).every(rows => rows.length === 0));
    assert.deepEqual(await snapshot(ordinary), original);
    assert.deepEqual(new Set((await query("select id from auth.users")).map(row => row.id)),
      new Set([ordinary, workerB, spoofed, mislabeled]));
    await asUser(workerB);
    assert.deepEqual(await query("select card_id, revision from public.recall_due()"), [{ card_id: cardB, revision: 0 }]);
  } finally {
    await db.close();
  }
});
