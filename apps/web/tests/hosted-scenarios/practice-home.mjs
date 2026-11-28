import assert from "node:assert/strict";
import { resetRound } from "../hosted-worker.mjs";

export default async function practiceHome(worker) {
  const { page, origin } = worker;
  const card = "Worker card " + worker.id;
  const button = name => page.getByRole("button", { name, exact: true });
  await resetRound(worker);
  const opens = [];
  const opening = request => {
    if (new URL(request.url()).pathname.endsWith("/rpc/recall_open_round")) opens.push(request);
  };
  page.on("request", opening);
  try {
    await page.goto(origin + "/recall/");
    await button("Browse all cards").click();
    await page.getByLabel("Search cards").fill("no-such-fixture");
    await page.getByText("No matching cards.").waitFor();
    await page.getByLabel("Search cards").fill("Fixture answer");
    await page.getByText(card, { exact: true }).click();
    await page.getByText("Fixture answer", { exact: true }).waitFor();
    await button("← Practice home").click();
    assert.equal(opens.length, 0);
    await button("Start round").click();
    await button("Reveal answer").click();
    await page.getByRole("button", { name: "Good", exact: true }).waitFor();
    await page.reload();
    await button("Continue round").click();
    await page.getByRole("heading", { name: card }).waitFor();
    await page.getByText("Fixture answer", { exact: true }).waitFor();
  } finally { page.off("request", opening); }
}
