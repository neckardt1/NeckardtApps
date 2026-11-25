import assert from "node:assert/strict";
import { prepareRound, gradeRound } from "../hosted-worker.mjs";

export default async function automaticReview(worker) {
  const card = await prepareRound(worker);
  const manualSteps = worker.page.getByRole("button", { name: /^(Start review|Resume review|Request Dot debrief|Finish)$/ });
  assert.equal(await manualSteps.count(), 0);
  await gradeRound(worker, card);
  assert.equal(await manualSteps.count(), 0);
}
