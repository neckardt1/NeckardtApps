import assert from "node:assert/strict";
import { prepareRound } from "../hosted-worker.mjs";

export default async function revealAnswer(worker) {
  await prepareRound(worker);
  const answer = worker.page.getByText("Fixture answer", { exact: true });
  assert.equal(await answer.isVisible(), false, "The answer should be hidden on the card front.");
  await worker.page.getByRole("button", { name: "Reveal answer" }).click();
  await answer.waitFor({ state: "visible" });
}
