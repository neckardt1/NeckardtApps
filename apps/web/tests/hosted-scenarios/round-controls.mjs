import assert from "node:assert/strict";
import { resetRound } from "../hosted-worker.mjs";

export default async function roundControls(worker) {
  const { page, origin } = worker;
  const card = "Worker card " + worker.id;
  const button = name => page.getByRole("button", { name, exact: true });
  const opens = [];
  const recordOpen = req => {
    if (req.method() === "POST" && req.url().endsWith("/rpc/recall_open_round")) opens.push(req.postDataJSON());
  };
  page.on("request", recordOpen);
  try {
    await resetRound(worker);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(origin + "/recall/");
    await page.getByText("0 check-ins · 1 recall card", { exact: true }).waitFor();
    assert.equal(await page.getByLabel("Recall cards per round").inputValue(), "5");
    await button("Browse all cards").click();
    const summary = page.locator("summary").filter({ hasText: card });
    await summary.getByText(/Due now/).waitFor();
    const due = await summary.locator("time").getAttribute("datetime");
    await button("Select cards").click();
    await page.getByRole("checkbox", { name: "Select " + card, exact: true }).check();
    await button("Pause 1").click();
    await summary.getByText(/Paused/).waitFor();
    assert.equal(await summary.locator("time").getAttribute("datetime"), due);
    await button("← Practice home").click();
    await page.getByText("No cards due right now.").waitFor();
    assert.equal(await button("Start round").count(), 0);
    await button("Browse all cards").click();
    await page.getByLabel("Status", { exact: true }).selectOption("paused");
    await summary.click();
    await button("Resume card").click();
    await page.getByText("No matching cards.").waitFor();
    await page.getByLabel("Status", { exact: true }).selectOption("active");
    await summary.getByText(/Due now/).waitFor();
    assert.equal(await summary.locator("time").getAttribute("datetime"), due);
    await button("← Practice home").click();
    await page.getByLabel("Recall cards per round").selectOption("10");
    assert.equal(opens.length, 0);
    await button("Start round").click();
    await page.getByRole("heading", { name: card }).waitFor();
    assert.equal(opens[0].p_review_limit, 10);
    await page.reload();
    await page.getByText("0 check-ins · 1 recall card left").waitFor();
    assert.equal(await page.getByLabel("Recall cards per round").count(), 0);
    await button("Continue round").click();
    await page.getByRole("heading", { name: card }).waitFor();
    assert.equal(opens.at(-1).p_round_id, opens[0].p_round_id);
  } finally { page.off("request", recordOpen); }
}
