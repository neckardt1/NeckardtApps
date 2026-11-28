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
  "recall_browse_cards", "recall_round_preview", "recall_set_cards_active", "recall_record_action", "recall_check_in", "recall_due", "recall_opportunities"]);

export async function bootstrap(db) {
  await db.exec(`
    create role anon; create role authenticated; create role service_role; create role supabase_auth_admin;
    create schema auth;
    create table auth.users (id uuid primary key);
    create function auth.uid() returns uuid stable language sql as $$
      select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid
    $$;
    grant usage on schema auth to anon,authenticated,service_role;
    create schema vault; create table vault.decrypted_secrets(name text, decrypted_secret text);
    insert into vault.decrypted_secrets values
      ('habit_notify_dispatch_url','https://fixture.supabase.co/functions/v1/neckardt-apps-mcp/deliver'),
      ('habit_notify_dispatch_secret', repeat('x',32));
    create schema net; create table net.requests(body jsonb);
    create function net.http_post(url text,body jsonb,headers jsonb,timeout_milliseconds integer)
      returns bigint language plpgsql as $$
      begin insert into net.requests values(body); return 1; end $$;
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
      await tx.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({
        sub: owner, role: "authenticated", aud: "authenticated", is_anonymous: false
      })]);
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

export async function openBrowser(browser, origin, remote, db, owner, fault = {}) {
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
        if (response.ok && args.review_id && fault.reviewAttempts) {
          fault.reviewAttempts.push(args.review_id);
          if (fault.reviewAttempts.length === 1) return route.abort("failed");
        }
        if (response.ok && args.action_id && fault.actionAttempts) {
          fault.actionAttempts.push(args.action_id);
          if (fault.actionAttempts.length === 1) return route.abort("failed"); // commit succeeded; ACK lost
        }
        return route.fulfill({ status: response.status, headers, contentType: "application/json", body: await response.text() });
      }
      const name = url.pathname.match(/^\/rest\/v1\/rpc\/([a-z_]+)$/)?.[1];
      assert(userRpcs.has(name), url.pathname);
      const rows = await rpc(db, owner, name, args ?? {});
      if (name === "recall_set_cards_active" && fault.loseActivityReceipt) {
        fault.loseActivityReceipt = false;
        return route.abort("failed");
      }
      if (name === "recall_finish_round" && fault.duplicateFinish) {
        const replay = await rpc(db, owner, name, args);
        assert.deepEqual(replay, rows);
        fault.finished = args.p_round_id;
      }
      let result = rows;
      if (name === "recall_record_action" || name === "recall_set_cards_active") result = rows[0][name];
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

async function checkDeckControls(db, browser, origin, remote) {
  const { owner } = await seed(db, true);
  await db.query("update flashcards_private.cards set back=back || ' Trial batch' where owner_id=$1", [owner]);
  await db.query(`insert into flashcards_private.cards(owner_id,kind,front,back)
    select $1,'fact','Review '||i,case when i <= 4 then 'Trial batch' else 'Keeper' end
    from generate_series(1,14) i`, [owner]);
  await db.query(`insert into flashcards_private.cards(owner_id,kind,front,back,due_at) values
    ($1,'habit-action','No occasion yet','Later',now()),
    ($1,'fact','Future recall','Later',now()+interval '1 day')`, [owner]);
  const { page, context } = await openBrowser(browser, origin, remote, db, owner, { loseActivityReceipt: true });
  const click = label => page.getByRole("button", { name: label, exact: true }).click();
  const row = front => page.locator(".catalog-row").filter({ has: page.getByText(front, { exact: true }) });
  try {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByText("1 check-in · 5 of 15 due recall cards").waitFor();
    await click("Browse all cards");
    await row("No occasion yet").getByText(/Waiting for an occasion/).waitFor();
    await row("Future recall").getByText(/Next recall/).waitFor();
    assert.ok(await row("Future recall").locator("summary time").getAttribute("datetime"));
    await page.getByLabel("Search cards").fill("Trial batch");
    await page.getByText("6 cards", { exact: true }).waitFor();
    await row("Did it happen?").getByText(/Check-in ready/).waitFor();
    await row("What follows the cue?").locator("summary").click();
    await row("What follows the cue?").getByRole("button", { name: "Pause card" }).click();
    await row("Did it happen?").getByText(/Cue paused/).waitFor();
    await page.getByText(/Could not confirm the change/).waitFor();
    await page.getByLabel("Status", { exact: true }).selectOption("paused");
    await row("What follows the cue?").locator("summary").click();
    await click("Resume card");
    await page.getByText("No matching cards.").waitFor();
    await page.getByLabel("Status", { exact: true }).selectOption("");
    await click("Select cards");
    await click("Select all 6 results");
    await click("Pause 6");
    await page.getByText("Paused 6 cards.").waitFor();
    await page.getByRole("link", { name: "Habits home" }).click();
    await page.getByText("0 check-ins · 5 of 10 due recall cards").waitFor();
    await click("Browse all cards");
    await page.getByLabel("Status", { exact: true }).selectOption("paused");
    await click("Select cards");
    await click("Select all 6 results");
    await click("Resume 6");
    await page.getByText("No matching cards.").waitFor();
    await page.getByRole("link", { name: "Habits home" }).click();
    const size = page.getByLabel("Recall cards per round");
    await size.selectOption("1");
    await page.getByText("1 check-in · 1 of 15 due recall cards").waitFor();
    await size.selectOption("10");
    await page.getByText("1 check-in · 10 of 15 due recall cards").waitFor();
    assert.deepEqual(await rpc(db, owner, "recall_latest_round"), []);
    await click("Start round");
    await page.getByRole("heading", { name: "Did you do it this time?" }).waitFor();
    await page.getByRole("link", { name: "Habits home" }).click();
    await page.getByText("1 check-in · 10 recall cards left").waitFor();
    assert.equal(await size.count(), 0);
    const manifest = await rpc(db, owner, "recall_latest_round");
    assert.equal(manifest.length, 11);
    const second = await openBrowser(browser, origin, remote, db, owner);
    try {
      await second.page.getByRole("button", { name: "Continue round" }).click();
      await second.page.getByRole("heading", { name: "Did you do it this time?" }).waitFor();
      assert.deepEqual(await rpc(db, owner, "recall_latest_round"), manifest);
      await second.page.getByRole("button", { name: "Yes", exact: true }).click();
      for (let i = 0; i < 10; i++) {
        await second.page.getByRole("button", { name: "Reveal answer" }).click();
        await second.page.getByRole("button", { name: "Good", exact: true }).click();
      }
      await second.page.getByRole("heading", { name: "Saved." }).waitFor();
      await second.page.getByRole("button", { name: "Preview next round" }).click();
      await second.page.getByText("0 check-ins · 5 recall cards", { exact: true }).waitFor();
      assert.equal((await rpc(db, owner, "recall_latest_round"))[0].round_id, manifest[0].round_id);
      await page.reload();
      await page.getByText("0 check-ins · 5 recall cards", { exact: true }).waitFor();
      await click("Start round");
      await page.getByText("Card 1 of 5", { exact: true }).waitFor();
      assert.notEqual((await rpc(db, owner, "recall_latest_round"))[0].round_id, manifest[0].round_id);
    } finally { await second.context.close(); }
  } finally { await context.close(); }
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
    await checkDeckControls(db, browser, origin, remote);
    for (const outcome of ["Yes", "No", "No opportunity"]) {
      const checkRetry = outcome === "Yes";
      const { owner, cue, action } = await seed(db, checkRetry);
      if (checkRetry) {
        await db.query("select public.habit_notify_subscribe_automatic($1)", [{
          owner_id: owner, id: "fixture-sub", url: "https://example.invalid/callback",
          secret: "fixture-only", expires_at: new Date(Date.now() + 600000).toISOString()
        }]);
      }
      const fault = { errors: [], duplicateFinish: true, actionAttempts: checkRetry ? [] : undefined };
      const { page, context } = await openBrowser(browser, origin, remote, db, owner, fault);
      const click = label => page.getByRole("button", { name: label, exact: true }).click();
      try {
        if (checkRetry) {
          await click("Browse all cards");
          await page.getByLabel("Card type").selectOption("habit-action");
          await page.getByText("Did it happen?", { exact: true }).click();
          await page.getByText("Check the occasion.", { exact: true }).waitFor();
          assert.deepEqual(await rpc(db, owner, "recall_latest_round"), []);
          await page.getByRole("link", { name: "Habits home" }).click();
        }
        if (!checkRetry) {
          await page.getByText("1 check-in · 0 recall cards", { exact: true }).waitFor();
          assert.equal(await page.getByLabel("Recall cards per round").count(), 0);
        }
        await click("Start round");
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
      const { rows: deliveries } = await db.query(
        "select delivery_id from habit_notify.deliveries where owner_id=$1 and round_id=$2", [owner, fault.finished]);
      assert.equal(deliveries.length, checkRetry ? 1 : 0);
      if (checkRetry) {
        const { rows: requests } = await db.query("select body from net.requests");
        assert.deepEqual(requests, [{ body: { delivery_id: deliveries[0].delivery_id } }]);
        const { rows: [{ claim }] } = await db.query("select public.habit_notify_rpc('claim',$1) as claim", [requests[0].body]);
        assert.equal(claim.subscription_id, "fixture-sub");
        assert.equal("items" in claim, false);
        assert.equal("round_id" in claim, false);
        assert.equal(claim.review_count, 1);
        assert.equal(claim.action_count, 1);
        const second = await openBrowser(browser, origin, remote, db, owner);
        await second.page.getByText("No cards due right now.").waitFor();
        assert.equal(await second.page.getByRole("button", { name: "Start round" }).count(), 0);
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
