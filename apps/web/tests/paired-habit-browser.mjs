import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { chromium } from "playwright-core";
import * as fsrs from "ts-fsrs";
import { gradeHandler, schedulerFor } from "../../backend/supabase/functions/recall-grade/grade.ts";

import { checkNewCardIntervals } from "./hosted-scenarios/review-intervals.mjs";

const migrations = new URL("../../backend/supabase/migrations/", import.meta.url);
const userRpcs = new Set(["recall_latest_round", "recall_open_round", "recall_finish_round",
  "recall_record_action", "recall_check_in", "recall_due", "recall_opportunities"]);

async function bootstrap(db) {
  await db.exec(`
    create role anon; create role authenticated; create role service_role; create role supabase_auth_admin;
    create schema auth;
    create table auth.users (id uuid primary key);
    create function auth.uid() returns uuid stable language sql as $$
      select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid
    $$;
    grant usage on schema auth to anon,authenticated,service_role;
  `);
  for (const file of (await readdir(migrations)).filter(f => f.endsWith(".sql")).sort()) {
    await db.exec(await readFile(new URL(file, migrations), "utf8"));
  }
}

// Only the transport and sign-in are simulated. SQL roles, grants, transactions,
// the grading handler, FSRS and the compiled UI all run their production code.
async function rpc(db, owner, name, args = {}) {
  const columns = Object.keys(args);
  assert(columns.every(k => /^p_[a-z_]+$/.test(k)));
  const signature = columns.map((c, i) => c + " => $" + (i + 1)).join(",");
  const sql = "select * from public." + name + "(" + signature + ")";
  const rows = await db.transaction(async tx => {
    if (owner) {
      assert(userRpcs.has(name));
      await tx.exec("set local role authenticated");
      await tx.query("select set_config('request.jwt.claim.sub',$1,true)", [owner]);
    } else {
      assert(["recall_prepare_answer", "recall_commit_answer"].includes(name));
      await tx.exec("set local role service_role");
    }
    return (await tx.query(sql, Object.values(args))).rows;
  });
  // Match timestamp serialization at the HTTP boundary.
  return JSON.parse(JSON.stringify(rows));
}

async function seed(db, cueDue) {
  const owner = randomUUID(), cue = randomUUID(), action = randomUUID();
  await db.query("insert into auth.users values($1)", [owner]);
  await db.query("insert into flashcards_private.app_owner(owner_id) values($1)", [owner]);
  await db.query(`insert into flashcards_private.cards (owner_id,id,kind,front,back,due_at)
    values ($1,$2,'habit-recall','What follows the cue?','Practice the habit.',
      now() + case when $3::boolean then interval '-1 day' else interval '1 day' end)`, [owner, cue, cueDue]);
  await db.query(`insert into flashcards_private.cards (owner_id,id,kind,cue_card_id,front,back,due_at)
    values ($1,$2,'habit-action',$3,'Did it happen?','Check the occasion.',now()-interval '1 day')`,
      [owner, action, cue]);
  await db.query(`insert into flashcards_private.action_opportunities (owner_id,card_id,revision,prompt,available_at)
    values ($1,$2,7,'Did you do it this time?',now()-interval '1 minute')`, [owner, action]);
  return { owner, cue, action };
}

function fixtureGrader(db, owner, token) {
  const single = async (name, args) => {
    const rows = await rpc(db, null, name, args);
    assert.equal(rows.length, 1);
    return rows[0];
  };
  return gradeHandler({
    getOwner: async value => value === token ? owner : null,
    prepare: args => single("recall_prepare_answer", args),
    commit: args => single("recall_commit_answer", args),
    schedule: schedulerFor(fsrs)
  });
}

// A device can record an answer while the opportunity is valid but send it after expiry.
async function checkLateAnswer(db, finishFirst) {
  const { owner, action } = await seed(db, false);
  const args = { p_round_id: randomUUID() };
  const [item] = await rpc(db, owner, "recall_open_round", args);
  const { rows: [clock] } = await db.query("select clock_timestamp() - interval '1 millisecond' as answered");
  const event = { action_id: item.event_id, opportunity_id: item.opportunity_id, card_id: action,
    revision: item.revision, outcome: "yes", answered_at: clock.answered.toISOString() };
  await db.query("update flashcards_private.action_opportunities set expires_at=clock_timestamp() where opportunity_id=$1",
    [item.opportunity_id]);
  if (finishFirst) {
    const [row] = await rpc(db, owner, "recall_finish_round", args);
    assert.equal(row.answer, "superseded");
  }
  const token = randomUUID();
  const response = await fixtureGrader(db, owner, token)(new Request("https://fixture.invalid/recall-grade", {
    method: "POST", headers: { authorization: "Bearer " + token }, body: JSON.stringify(event)
  }));
  assert.equal(response.status, finishFirst ? 409 : 200, await response.text());
  const [summary] = await rpc(db, owner, "recall_finish_round", args);
  assert.equal(summary.answer, finishFirst ? "superseded" : "yes");
  for (const table of ["reviews", "action_responses"]) {
    const rows = await db.query("select count(*)::int as n from flashcards_private." + table + " where card_id=$1", [action]);
    assert.equal(rows.rows[0].n, finishFirst ? 0 : 1, table + " during late delivery");
  }
}

async function openBrowser(browser, origin, remote, db, owner, fault = {}) {
  const context = await browser.newContext();
  const token = randomUUID();
  await context.addInitScript(({ key, owner, token }) => {
    localStorage.setItem(key, JSON.stringify({ access_token: token, refresh_token: "synthetic",
      token_type: "bearer", expires_at: Math.floor(Date.now() / 1000) + 3600,
      user: { id: owner, aud: "authenticated", email: "fixture@example.invalid" } }));
  }, { key: "sb-" + new URL(remote).hostname.split(".")[0] + "-auth-token", token, owner });
  const handler = fixtureGrader(db, owner, token);
  await context.route("**/*", async route => {
    const req = route.request(), url = new URL(req.url());
    if (url.origin === origin) return route.continue();
    if (url.origin !== remote) return route.abort();
    const headers = { "access-control-allow-origin": origin, "access-control-allow-methods": "POST,OPTIONS",
      "access-control-allow-headers": req.headers()["access-control-request-headers"] ?? "*" };
    if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers });
    if (req.headers().authorization !== "Bearer " + token) return route.fulfill({ status: 401, headers });
    try {
      const args = req.postDataJSON();
      if (url.pathname === "/functions/v1/recall-grade") {
        const response = await handler(new Request(req.url(), {
          method: "POST", headers: req.headers(), body: JSON.stringify(args)
        }));
        if (response.ok && args.action_id && fault.actionAttempts) {
          fault.actionAttempts.push(args.action_id);
          if (fault.actionAttempts.length === 1) return route.abort("failed"); // commit succeeded; ACK lost
        }
        return route.fulfill({ status: response.status, headers, contentType: "application/json", body: await response.text() });
      }
      const name = url.pathname.match(/^\/rest\/v1\/rpc\/([a-z_]+)$/)?.[1];
      assert(userRpcs.has(name), url.pathname);
      const rows = await rpc(db, owner, name, args ?? {});
      if (name === "recall_finish_round" && fault.duplicateFinish) {
        const replay = await rpc(db, owner, name, args);
        assert.deepEqual(replay, rows);
        fault.finished = args.p_round_id;
      }
      let result = rows;
      if (name === "recall_record_action") result = rows[0].recall_record_action;
      if (req.headers().accept?.includes("vnd.pgrst.object")) {
        assert.equal(rows.length, 1);
        result = rows[0];
      }
      return route.fulfill({ status: 200, headers, json: result });
    } catch (error) {
      fault.errors?.push(error.message);
      return route.fulfill({ status: 400, headers, json: { code: error.code ?? "TEST", message: error.message } });
    }
  });
  const page = await context.newPage();
  page.setDefaultTimeout(12000);
  await page.goto(origin + "/recall/");
  return { context, page };
}

export async function checkPairedHabit(origin, remote) {
  const db = new PGlite();
  let browser;
  try {
    await bootstrap(db);
    await checkLateAnswer(db, false);
    await checkLateAnswer(db, true);
    browser = await chromium.launch(process.env.CHROME_BIN
      ? { executablePath: process.env.CHROME_BIN } : { channel: "chrome" });
    for (const outcome of ["Yes", "No", "No opportunity"]) {
      const checkRetry = outcome === "Yes";
      const { owner, cue, action } = await seed(db, checkRetry);
      const fault = { errors: [], duplicateFinish: true, actionAttempts: checkRetry ? [] : undefined };
      const { page, context } = await openBrowser(browser, origin, remote, db, owner, fault);
      const click = label => page.getByRole("button", { name: label, exact: true }).click();
      try {
        await click("Start review");
        await click(outcome);
        if (checkRetry) {
          await click("Retry save");
          const beforeCue = await db.query("select revision from flashcards_private.cards where id=$1", [cue]);
          assert.equal(beforeCue.rows[0].revision, 0, "doing the action must not grade recall of the cue");
          await checkNewCardIntervals(page);
          const untouched = await db.query("select revision, scheduler_state from flashcards_private.cards where id=$1", [cue]);
          assert.deepEqual(untouched.rows, [{ revision: 0, scheduler_state: null }]);
          await click("Good");
        }
        await click("Finish");
        await page.getByRole("heading", { name: "Saved." }).waitFor();
      } catch (cause) {
        throw new Error([outcome, await page.locator("body").innerText(), ...fault.errors].join("\n"), { cause });
      }
      await context.close();
      if (checkRetry) {
        const { rows: [review] } = await db.query("select reviewed_at, next_due_at from flashcards_private.reviews where card_id=$1", [cue]);
        assert.equal(review.next_due_at - review.reviewed_at, 10 * 60000, "Good matches the displayed 10-minute interval");
        assert.equal(fault.actionAttempts.length, 2);
        assert.equal(fault.actionAttempts[0], fault.actionAttempts[1]);
      }
      const { rows: reviews } = await db.query(`select r.review_id,r.grade,r.reviewed_at,c.due_at,c.revision,
        c.scheduler_state,r.fsrs_log from flashcards_private.reviews r
        join flashcards_private.cards c on c.id=r.card_id where r.card_id=$1`, [action]);
      const { rows: answers } = await db.query("select action_id,outcome from flashcards_private.action_responses where card_id=$1", [action]);
      assert.equal(answers.length, 1);
      assert.equal(answers[0].outcome, outcome.toLowerCase().replace(" ", "_"));
      if (outcome === "No opportunity") {
        assert.equal(reviews.length, 0);
        const { rows: [card] } = await db.query("select revision,scheduler_state from flashcards_private.cards where id=$1", [action]);
        assert.equal(card.revision, 0);
        assert.equal(card.scheduler_state, null);
      } else {
        assert.equal(reviews.length, 1);
        const [review] = reviews;
        assert.equal(review.review_id, answers[0].action_id);
        assert.equal(review.grade, checkRetry ? "medium" : "miss");
        assert.equal(review.fsrs_log.rating, checkRetry ? fsrs.Rating.Good : fsrs.Rating.Again);
        assert.equal(review.revision, 1);
        assert.equal(review.scheduler_state.reps, 1);
        assert.equal(Date.parse(review.due_at) - Date.parse(review.reviewed_at), (checkRetry ? 10 : 1) * 60000);
      }
      const { rows: events } = await db.query("select * from flashcards_private.round_completions where owner_id=$1", [owner]);
      assert.equal(events.length, 1, "two Finish writes produce one completion");
      assert.equal(events[0].round_id, fault.finished);
      assert.equal(events[0].review_count, checkRetry ? 1 : 0);
      assert.equal(events[0].action_count, 1);
      if (checkRetry) {
        const second = await openBrowser(browser, origin, remote, db, owner);
        await second.page.getByRole("heading", { name: "Saved." }).waitFor();
        assert.match(await second.page.locator("body").innerText(), /1 habit check.*1 card reviewed/);
        await second.context.close();
        const other = await seed(db, false);
        assert.deepEqual(await rpc(db, other.owner, "recall_latest_round"), []);
        await assert.rejects(rpc(db, other.owner, "recall_finish_round", { p_round_id: fault.finished }), { code: "PT404" });
        await db.query(`insert into flashcards_private.cards(owner_id,kind,front,back)
          select $1,'fact','Fact '||i,'Answer' from generate_series(1,7) i`, [other.owner]);
        const limited = await rpc(db, other.owner, "recall_open_round", { p_round_id: randomUUID() });
        assert.equal(limited.filter(item => item.item_kind === "review").length, 5);
      }
    }
  } finally {
    await browser?.close();
    await db.close();
  }
}
