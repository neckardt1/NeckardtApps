import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { resetRound } from "../hosted-worker.mjs";
import { checkSuiteNavigation, phones } from "../mobile-layout.mjs";

export default async function cardMotion(worker) {
  const { page, origin } = worker;
  const first = await resetRound(worker);
  const endpoint = worker.config.url + "/rest/v1/rpc/recall_open_round";
  const second = randomUUID(), nextEvent = randomUUID();
  await page.route(endpoint, async route => {
    const response = await route.fetch();
    const [item] = await response.json();
    // Keep the first real fixture review and receipt. A second display-only
    // item lets us observe navigation without grading an invented card.
    await route.fulfill({ response, json: [item, { ...item, card_id: second, event_id: nextEvent,
      position: 1, front: "Second fixture prompt", back: "Second fixture answer" }] });
  });
  const button = name => page.getByRole("button", { name, exact: true });
  const surface = page.locator(".card-surface"), rotor = page.locator(".card-rotor");
  const grades = [];
  const record = req => {
    if (req.method() === "POST" && req.url().endsWith("/functions/v1/recall-grade") && req.postDataJSON()?.grade) grades.push(req.postDataJSON());
  };
  page.on("request", record);
  try {
    await page.goto(origin + "/recall/");
    await button("Start round").click();
    let firstFlip = true;
    for (const { width, height } of phones) {
      await page.setViewportSize({ width, height });
      for (const colorScheme of ["light", "dark"]) {
        await page.emulateMedia({ colorScheme });
        await button("Reveal answer").dblclick({ position: { x: width * .8, y: 20 } });
        if (firstFlip) {
          await button("Show question").waitFor();
          firstFlip = false;
        } else {
          await button("Reveal answer").waitFor();
        }
        // Only the first flip has a time gate. A subsequent double-tap may
        // turn over twice, but can never submit the grade underneath it.
        assert.equal(grades.length, 0);
        await rotor.evaluate(async el => { await Promise.all(el.getAnimations().map(a => a.finished)); });
        if (await button("Show question").count()) await button("Show question").click();
        await button("Reveal answer").waitFor();
        await checkSuiteNavigation(page, "Habits");
        await surface.click({ position: { x: 20, y: 20 } });
        await button("Show question").waitFor();
        await rotor.evaluate(async el => { await Promise.all(el.getAnimations().map(a => a.finished)); });
        const { x, y } = await surface.boundingBox();
        const start = x + 15;
        await page.mouse.move(start, y + 30);
        await page.mouse.down();
        const initial = await rotor.evaluate(el => parseFloat(el.style.transform.slice(8)));
        await page.mouse.move(start + width / 4, y + 30);
        const angle = () => rotor.evaluate(el => parseFloat(el.style.transform.slice(8)));
        assert.ok(Math.abs(await angle() - initial - 180) < 2);
        await page.mouse.move(start + width / 2, y + 30);
        assert.ok(Math.abs(await angle() - initial - 360) < 2);
        await page.mouse.move(start + width / 4, y + 30);
        await page.mouse.up();
        await button("Reveal answer").waitFor();
        assert.equal(await button("Easy").count(), 0);
        assert.equal(await page.locator(".card-enter").count(), 0);
      }
    }
    // Hold the fixture round's persistence lock while flipping. The face
    // should still respond, and grading must wait for the durable state.
    await page.evaluate(key => new Promise(ready => {
      void navigator.locks.request(key, () => new Promise(release => {
        window.releaseCardMotionLock = release;
        ready();
      }));
    }), `recall.round.v3.${worker.config.url}.${worker.id}`);
    try {
      await button("Reveal answer").click();
      assert(await button("Easy").isDisabled());
      await page.locator(".screen-content").focus();
      await page.keyboard.press("Space");
      await button("Show question").waitFor();
      await button("Show question").click();
      await button("Reveal answer").waitFor();
    } finally {
      await page.evaluate(() => window.releaseCardMotionLock());
    }
    await page.emulateMedia({ reducedMotion: "reduce" });
    await button("Reveal answer").focus();
    await page.keyboard.press("Space");
    await button("Show question").waitFor();
    assert.equal(await rotor.evaluate(el => getComputedStyle(el).transform), "none");
    const box = await surface.boundingBox();
    const start = box.x + box.width - 15;
    await page.mouse.move(start, box.y + 30);
    await page.mouse.down();
    await page.mouse.move(start - page.viewportSize().width / 4, box.y + 30);
    await page.mouse.up();
    await button("Reveal answer").waitFor();
    assert.equal(grades.length, 0);
    await button("Reveal answer").click();
    await page.emulateMedia({ reducedMotion: "no-preference" });
    const [receipt] = await Promise.all([
      page.waitForResponse(r => r.url().endsWith("/functions/v1/recall-grade") && r.request().postDataJSON()?.grade === "medium"),
      button("Good").click(),
    ]);
    assert.equal((await receipt.json()).card_id, first);
    assert.equal(grades.length, 1);
    await page.getByRole("heading", { name: "Second fixture prompt" }).waitFor();
    assert.equal(await page.locator(".card-enter").count(), 1);
  } finally {
    page.off("request", record);
    await page.unroute(endpoint);
  }
}
