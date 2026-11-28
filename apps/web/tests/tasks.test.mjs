import assert from "node:assert/strict";
import test from "node:test";
import { gateOpen, inboxTasks, pacificDate, shiftDate, todaySections, upcomingSections } from "../src/apps/tasks/model.ts";

const task = (id, fields = {}) => ({
  id, listId: "household", title: id, version: 1,
  plannedDate: null, plannedTime: null, deadlineDate: null, deadlineTime: null,
  showAfterDate: null, showAfterTime: null, showAfterAt: null, ...fields,
});
const today = "2026-03-08";
const snapshot = (tasks, focus = []) => ({ lists: [], tasks, focus, focusDay: today });
const ids = tasks => tasks.map(item => item.id);

test("Household dates use the Pacific day through travel, midnight and both DST transitions", () => {
  for (const [instant, expected] of [
    ["2026-03-08T07:59Z", "2026-03-07"], ["2026-03-08T08:00Z", today],
    ["2026-03-08T10:01Z", today], ["2026-11-01T08:30Z", "2026-11-01"],
    ["2026-11-01T09:30Z", "2026-11-01"],
  ]) assert.equal(pacificDate(new Date(instant)), expected);
  assert.equal(shiftDate("2026-03-07", 2), "2026-03-09");
  assert.equal(shiftDate("2026-11-02", -1), "2026-11-01");
});

test("the plan is visible that morning and only an explicit Show after delays Today", () => {
  const morning = new Date("2026-03-08T16:00Z");
  const scheduled = task("evening", { plannedDate: today, plannedTime: "19:00" });
  const gated = { ...scheduled, id: "gated", showAfterDate: today, showAfterTime: "19:00", showAfterAt: "2026-03-09T02:00:00Z" };
  const saved = snapshot([scheduled, gated], [{ taskId: "gated", state: "promoted" }]);
  assert.deepEqual(ids(todaySections(saved, morning).focus), ["evening"]);
  assert.deepEqual(todaySections(saved, morning).everythingElse, []);
  assert.equal(gateOpen(gated, new Date("2026-03-09T01:59:59Z")), false);
  assert.deepEqual(ids(todaySections(saved, new Date(gated.showAfterAt)).focus), ["gated", "evening"]);
  assert.deepEqual(saved.tasks[0], scheduled);
});

test("personal choices order uncapped Focus ahead of date suggestions and retain all shared dates", () => {
  const now = new Date("2026-03-08T15:00Z");
  const future = task("future", { plannedDate: "2026-04-03", deadlineDate: "2026-04-06" });
  const due = task("due", { deadlineDate: today });
  const older = task("unfinished", { plannedDate: "2026-02-17" });
  const extra = ["four", "three", "two", "one"].map(id => task(id));
  const saved = snapshot([future, due, older, ...extra]);
  const manual = [future, ...extra].map(t => ({ taskId: t.id, state: "promoted" }));
  const chosen = { ...saved, focus: [...manual, { taskId: "unfinished", state: "deprioritized" }] };
  assert.deepEqual(ids(todaySections(chosen, now).focus), ["future", ...ids(extra), "due"]);
  assert.deepEqual(ids(todaySections(chosen, now).everythingElse), ["unfinished"]);
  assert.deepEqual(ids(todaySections(saved, now).focus), ["due", "unfinished"]);
  assert(!ids(todaySections(saved, now).everythingElse).includes("future"));
  assert.equal(future.plannedDate, "2026-04-03");
  assert.equal(older.plannedDate, "2026-02-17");
  const next = todaySections(chosen, new Date("2026-03-09T16:00Z"));
  assert(next.focus.some(t => t.id === "unfinished"));
});

test("Upcoming groups each active task at its next Pacific date across weeks, months and years", () => {
  const saved = snapshot([
    task("past", { plannedDate: "2026-03-01" }), task("undated"),
    task("far", { deadlineDate: "2027-01-03" }), task("today", { plannedDate: today }),
    task("monday", { plannedDate: "2026-03-09", deadlineDate: "2026-04-01" }),
    task("deadline first", { plannedDate: "2026-04-08", deadlineDate: "2026-03-10" }),
    task("past plan", { plannedDate: "2026-03-05", deadlineDate: "2026-03-15" }),
    task("past deadline", { plannedDate: "2026-04-01", deadlineDate: "2026-03-04" }),
    task("deferred", { showAfterDate: "2026-04-02", showAfterAt: "2026-04-02T07:00:00Z" }),
  ]);
  const agenda = now => upcomingSections(saved, new Date(now)).map(({ date, tasks }) => [date, ids(tasks)]);
  assert.deepEqual(agenda("2026-03-09T00:30Z"), [
    [today, ["today"]], ["2026-03-09", ["monday"]], ["2026-03-10", ["deadline first"]],
    ["2026-03-15", ["past plan"]], ["2026-04-01", ["past deadline"]],
    ["2026-04-02", ["deferred"]], ["2027-01-03", ["far"]],
  ]);
  assert.deepEqual(agenda("2026-04-01T07:00Z")[0], ["2026-04-01", ["past deadline", "monday"]]);
});

test("Inbox collects unscheduled private tasks when their Show after gate opens", () => {
  const privateTask = (id, fields) => task(id, { listId: "mine", ...fields });
  const saved = { ...snapshot([
    privateTask("capture"), privateTask("scheduled", { plannedDate: today }), privateTask("due", { deadlineDate: today }),
    privateTask("deferred", { showAfterDate: today, showAfterAt: "2026-03-09T02:00:00Z" }), task("shared"),
  ]), lists: [{ id: "mine", kind: "private" }, { id: "household", kind: "household" }] };
  assert.deepEqual(ids(inboxTasks(saved, new Date("2026-03-08T16:00Z"))), ["capture"]);
  assert.deepEqual(ids(inboxTasks(saved, new Date("2026-03-09T02:00Z"))), ["capture", "deferred"]);
});
