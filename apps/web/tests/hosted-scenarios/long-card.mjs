import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { resetRound } from "../hosted-worker.mjs";

export default async function longCard(worker) {
  const { page, origin, config } = worker;
  const card = await resetRound(worker);
  const viewport = page.viewportSize();
  const endpoint = config.url + "/rest/v1/rpc/recall_latest_round";
  const front = "While planning a weekend walk with a friend, what details should you agree on so it is easy for both of you to show up?";
  const back = [
    "Choose a meeting spot you can both find and agree on a time to be there.",
    "- Pick a route that suits the time you have.",
    "- Check whether either of you needs a shorter walk.",
    "- Decide where to meet if the weather changes.",
    "Send a short confirmation with the place and time."
  ].join("\n");
  await page.route(endpoint, route => route.fulfill({ json: [{
    round_id: randomUUID(), event_id: randomUUID(), card_id: card, item_kind: "review",
    position: 0, revision: 0, front, back, paired_action: false, opportunity_id: null,
    due_at: null, finished_at: null, answered_at: null, answer: null
  }] }));
  try {
    await page.setViewportSize({ width: 375, height: 667 });
    await page.goto(origin + "/recall/?dot=1");
    const prompt = page.getByRole("heading", { name: front });
    const start = page.getByRole("button", { name: "Start review" });
    await prompt.or(start).waitFor();
    if (await start.isVisible()) await start.click();
    await prompt.waitFor();
    await page.getByRole("button", { name: "Reveal answer" }).click();
    const lastLine = page.getByText(back.split("\n").at(-1), { exact: true });
    await lastLine.waitFor();
    const end = await lastLine.boundingBox();
    const rating = await page.getByRole("button", { name: /^Good\b/i }).boundingBox();
    assert.ok(end && rating && end.y + end.height <= rating.y, "The full answer should fit above the ratings.");
    assert.ok(rating.height >= 44 && rating.y + rating.height <= 667, "The rating should be visible and tappable.");
    assert.ok(await page.evaluate(() => window.scrollY === 0 &&
      document.documentElement.scrollWidth <= window.innerWidth), "Reading this card should require no scrolling.");
  } finally {
    await page.unroute(endpoint);
    if (viewport) await page.setViewportSize(viewport);
  }
}
