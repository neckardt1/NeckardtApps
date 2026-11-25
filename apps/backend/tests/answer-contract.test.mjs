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

test("all four previews use the stored FSRS history and never commit an answer", async () => {
  const schedule = schedulerFor(fsrs);
  const card_id = randomUUID();
  const previous = new Date(Date.now() - 20 * 86400000).toISOString();
  const first = schedule({ kind: "new_card", revision: 0, due_at: previous, scheduler_state: null }, "easy", previous);
  const snapshot = { kind: "studied_card", card_id, revision: 1, due_at: first.dueAt, scheduler_state: first.state };
  let previewTime;
  const handle = gradeHandler({
    getOwner: async () => "fixture",
    prepare: async args => {
      previewTime = args.p_reviewed_at;
      return { ...snapshot, review_id: args.p_review_id };
    },
    schedule, commit: () => assert.fail("preview wrote a review")
  });
  const response = await handle(new Request("https://fixture.invalid/recall-grade", {
    method: "POST", headers: { Authorization: "Bearer fixture" }, body: JSON.stringify({ preview: true, card_id, revision: 1 })
  }));
  assert.equal(response.status, 200);
  const { minutes } = await response.json();
  for (const grade of ["miss", "hard", "medium", "easy"]) {
    assert.equal(Date.parse(previewTime) + minutes[grade] * 60000, Date.parse(schedule(snapshot, grade, previewTime).dueAt));
  }
  assert.ok(minutes.easy > 8 * 1440, "the studied card must not use new-card intervals");
});
