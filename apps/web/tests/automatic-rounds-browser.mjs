import assert from "node:assert/strict";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { chromium } from "playwright-core";
import { createEvents } from "../../backend/supabase/functions/neckardt-apps-mcp/apps/habit-practice/events.ts";
import { bootstrap, openBrowser } from "./paired-habit-browser.mjs";
import { checkLongCardLayout, longBack, longFront } from "./hosted-scenarios/long-card.mjs";
import { checkNewCardIntervals } from "./hosted-scenarios/review-intervals.mjs";

// Both HTTP boundaries are local fixtures. The database, event protocol, signing,
// browser, grading handler and scheduler run the same code as the application.
function callbackFixture(db, owner) {
  const messages = [];
  const dispatch = "x".repeat(32);
  const url = "https://connectors.api.openai.com/private-fixture";
  const key = randomBytes(32);
  const events = createEvents(async (action, payload) => db.transaction(async tx => {
    await tx.exec("set local role service_role");
    const result = action === "subscribe_automatic"
      ? await tx.query("select public.habit_notify_subscribe_automatic($1) as value", [payload])
      : await tx.query("select public.habit_notify_rpc($1,$2) as value", [action,payload]);
    return result.rows[0].value;
  }), dispatch, async (target, post) => {
    assert.equal(target.href, url);
    const headers = post.headers;
    const expected = createHmac("sha256", key).update(
      [headers["webhook-id"],headers["webhook-timestamp"],post.body].join(".")).digest("base64");
    assert.equal(headers["webhook-signature"], "v1," + expected);
    const message = JSON.parse(post.body);
    if (message.type === "verification") return { status:200, body:JSON.stringify({challenge:message.challenge}) };
    messages.push(message);
    return { status:200, body:"" };
  });
  function scope(method, args) {
    return events.handle(method, {name:"habit.practice.round.completed", arguments:args,
      delivery:{mode:"webhook",url,secret:"whsec_" + key.toString("base64")}}, owner);
  }
  return {
    messages, subscribe: args => scope("events/subscribe", args), revoke: args => scope("events/unsubscribe", args),
    async queuedBody(roundId) {
      const { rows:[queued] } = await db.query(
        "select n.body from net.requests n join habit_notify.deliveries d on n.body->>'delivery_id'=d.delivery_id::text where d.owner_id=$1 and d.round_id=$2",
        [owner, roundId]);
      assert.ok(queued, "the saved round queued its delivery");
      return queued.body;
    },
    send(body) {
      return events.deliver(new Request("https://fixture.invalid/deliver", {method:"POST",
        headers:{Authorization:"Bearer " + dispatch}, body:JSON.stringify(body)}));
    }
  };
}

export async function checkAutomaticRounds(origin, remote) {
  const db = new PGlite();
  let browser;
  try {
    await bootstrap(db);
    const owner = randomUUID();
    await db.query("insert into auth.users values ($1)", [owner]);
    await db.query("insert into flashcards_private.app_owner(owner_id) values($1)", [owner]);
    const callback = callbackFixture(db, owner);
    browser = await chromium.launch(process.env.CHROME_BIN
      ? {executablePath:process.env.CHROME_BIN} : {channel:"chrome"});

    async function review(label, { long = false, retry = false, beforeGrade } = {}) {
      const front = long ? longFront : "Synthetic review prompt";
      const back = long ? longBack : "Synthetic expected answer";
      const card = randomUUID();
      await db.query("insert into flashcards_private.cards(owner_id,id,kind,front,back,due_at) values($1,$2,'fact',$3,$4,now()-interval '1 hour')",
        [owner,card,front,back]);
      const fault = { duplicateFinish:true, reviewAttempts:retry ? [] : undefined };
      const { page, context } = await openBrowser(browser, origin, remote, db, owner, fault);
      try {
        await page.setViewportSize({width:375,height:667});
        await page.getByRole("button", { name: "Start round" }).click();
        await page.getByRole("heading",{name:front,exact:true}).waitFor();
        const button = name => page.getByRole("button",{name,exact:true});
        for (const step of ["Start review","Request Dot debrief","Finish"]) assert.equal(await button(step).count(), 0);
        await checkNewCardIntervals(page);
        if (long) await checkLongCardLayout(page);
        if (beforeGrade) await beforeGrade();
        await button(label).click();
        if (retry) {
          await button("Retry save").waitFor();
          assert.equal(await page.getByRole("heading",{name:"Saved."}).count(), 0);
          assert.equal((await db.query("select 1 from habit_notify.deliveries d join flashcards_private.round_items i using(owner_id,round_id) where i.card_id=$1",[card])).rows.length,0);
          await button("Retry save").click();
        }
        await page.getByRole("heading",{name:"Saved.",exact:true}).waitFor();
        if (retry) assert.deepEqual(fault.reviewAttempts,[fault.reviewAttempts[0],fault.reviewAttempts[0]]);
        const { rows } = await db.query("select grade,reviewed_at,next_due_at from flashcards_private.reviews where owner_id=$1 and card_id=$2",[owner,card]);
        assert.equal(rows.length,1);
        return { card,front,back,roundId:fault.finished,receipt:rows[0] };
      } finally { await context.close(); }
    }

    async function deliver(round) {
      const before = callback.messages.length;
      const body = await callback.queuedBody(round.roundId);
      assert.equal((await callback.send(body)).status,204);
      assert.equal((await callback.send(body)).status,204);
      assert.equal(callback.messages.length,before+1);
      return callback.messages.at(-1).data;
    }

    const counts = {automatic:true};
    const details = {automatic:true,share_items:true};
    await callback.subscribe(counts);
    const summary = await deliver(await review("Good"));
    assert.deepEqual(Object.keys(summary).sort(),["finished_at","review_count","action_count","superseded_count","outcomes"].sort());
    assert.equal(summary.review_count,1);
    await callback.revoke(counts);
    await callback.subscribe(details);
    for (const label of ["Good","Easy"]) {
      const round = await review(label, { long:label === "Good", retry:label === "Good" });
      const result = await deliver(round);
      assert.equal(result.round_id,round.roundId);
      assert.equal(result.items.length,1);
      const [item] = result.items;
      assert.deepEqual([item.card_id,item.card_name,item.front,item.back,item.answer,item.grade],
        [round.card,round.front,round.front,round.back,round.receipt.grade,round.receipt.grade]);
      assert.equal(Date.parse(item.next_due_at),round.receipt.next_due_at.getTime());
      assert.equal(round.receipt.grade,label === "Good" ? "medium" : "easy");
      assert.equal(round.receipt.next_due_at - round.receipt.reviewed_at,
        (label === "Good" ? 10 : 8 * 24 * 60) * 60000);
    }
    // Revoking while a completed delivery is queued also applies to an already-open round.
    const queued = await review("Good");
    const body = await callback.queuedBody(queued.roundId);
    const revoked = await review("Good", { beforeGrade:() => callback.revoke(details) });
    await callback.subscribe(counts);
    assert.equal((await callback.send(body)).status,204);
    assert.equal(callback.messages.length,3);
    assert.equal((await db.query("select 1 from habit_notify.deliveries where owner_id=$1 and round_id=$2",[owner,revoked.roundId])).rows.length,0);
    const downgraded = await deliver(await review("Good"));
    assert.equal("items" in downgraded,false);
    assert.equal("round_id" in downgraded,false);
  } finally {
    await browser?.close();
    await db.close();
  }
}
