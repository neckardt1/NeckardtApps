import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import * as fsrs from "ts-fsrs";
import { gradeHandler, schedulerFor } from "../supabase/functions/recall-grade/grade.ts";

test("a missing or malformed stored state never schedules a new card", async () => {
  const schedule = schedulerFor(fsrs);
  const review = {
    card_id: randomUUID(), review_id: randomUUID(), revision: 1,
    reviewed_at: "2026-10-03T08:00:00.000Z", grade: "medium"
  };
  const due = "2026-10-03T07:58:00.000Z";
  const studied = {
    kind: "studied_card", revision: 1, card_id: review.card_id, review_id: review.review_id, due_at: due
  };

  async function post(snapshot, saved) {
    let writes = 0;
    const handle = gradeHandler({
      getOwner: async () => "fixture",
      prepare: async () => snapshot,
      schedule,
      commit: async () => { writes++; return saved; }
    });
    const response = await handle(new Request("https://fixture.invalid/recall-grade", {
      method: "POST", headers: { Authorization: "Bearer fixture" }, body: JSON.stringify(review)
    }));
    return { status: response.status, writes };
  }

  for (const broken of [studied, { ...studied, scheduler_state: null },
    { ...studied, state: {}, scheduler_state: {} }, { ...studied, kind: "new_card", scheduler_state: null }]) {
    assert.deepEqual(await post(broken, null), { status: 503, writes: 0 });
  }
  const first = schedule({ ...studied, kind: "new_card", scheduler_state: null, revision: 0 },
    "medium", review.reviewed_at);
  const next = { ...studied, due_at: first.dueAt, scheduler_state: first.state };
  assert.equal(schedule(next, "medium", first.dueAt).state.reps, 2);
  assert.deepEqual(await post(next, {revision: 2}), { status: 503, writes: 1 });
});
