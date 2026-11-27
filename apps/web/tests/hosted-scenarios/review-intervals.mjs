import assert from "node:assert/strict";
import { prepareRound } from "../hosted-worker.mjs";

export async function checkNewCardIntervals(page) {
  await page.getByRole("button", { name: "Reveal answer" }).click();
  for (const [grade, interval] of Object.entries({ Again: "1 min", Hard: "6 min", Good: "10 min", Easy: "8 days" })) {
    await page.getByRole("button", { name: grade, exact: true }).getByText(interval, { exact: true }).waitFor();
  }
}

export default async function reviewIntervals(worker) {
  const { page } = worker;
  const viewport = page.viewportSize();
  const calls = [];
  const trackRequest = request => {
    if (request.method() === "POST") calls.push(new URL(request.url()).pathname);
  };
  page.on("request", trackRequest);
  try {
    await page.setViewportSize({ width: 375, height: 667 });
    const [card, response] = await Promise.all([
      prepareRound(worker),
      page.waitForResponse(response => response.url().endsWith("/functions/v1/recall-grade")
        && response.request().method() === "POST" && response.request().postDataJSON()?.preview === true)
    ]);
    assert.equal((await response.json()).card_id, card);
    await checkNewCardIntervals(page);
    assert.deepEqual(calls.filter(path => /rpc\/recall_(open|latest)_round$/.test(path)), ["/rest/v1/rpc/recall_open_round"]);
    assert.equal(calls.filter(path => path.endsWith("/functions/v1/recall-grade")).length, 1);
  } finally {
    page.off("request", trackRequest);
    if (viewport) await page.setViewportSize(viewport);
  }
}
