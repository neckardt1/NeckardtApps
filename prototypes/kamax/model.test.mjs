import assert from "node:assert/strict";
import test from "node:test";
import {
  addDays,
  calendarBlocks,
  calendarEvents,
  changeFocus,
  complete,
  createTask,
  dayView,
  editTask,
  keyOf,
  lookup,
  occurrences,
  seed,
} from "./model.mjs";

const stamp = "2026-11-28T08:45";
const day = stamp.slice(0, 10);
const fresh = () => seed(new Date(stamp));
const drawerKeys = (view) => view.drawer.map((t) => t.key);

test("focus swaps are personal and carry-forward leaves schedules, deadlines and deferral counts intact", () => {
  const s = fresh(),
    id = "groceries/first";
  assert.equal(changeFocus(s, "Nick", stamp, id), false);
  assert.equal(changeFocus(s, "Nick", stamp, id, "cabin/first"), true);
  assert.equal(dayView(s, "Nick", stamp).focus.length, 3);
  assert.ok(dayView(s, "Stacey", stamp).focus.some((t) => t.key === "cabin/first"));
  assert.ok(drawerKeys(dayView(s, "Nick", stamp)).includes("cabin/first"));
  const before = structuredClone(s);
  assert.ok(drawerKeys(dayView(s, "Nick", "2026-11-29T08:00")).includes("cabin/first"));
  assert.deepEqual(s, before);
});
test("show-after gates Today and Muse eligibility, while later planned times stay visible", () => {
  const s = fresh();
  assert.ok(dayView(s, "Nick", stamp).focus.some((t) => t.time === "17:30"));
  assert.ok(!drawerKeys(dayView(s, "Nick", "2026-11-30T17:59")).includes("flight/first"));
  assert.equal(changeFocus(s, "Nick", "2026-11-30T17:59", "flight/first"), false);
  assert.ok(dayView(s, "Nick", "2026-11-30T18:00").focus.some((t) => t.id === "flight"));
  assert.equal(dayView(s, "Nick", "2026-11-30T18:00").checkIn.length, 0);
});
test("choosing a future occurrence pulls it into the day only once a slot is available", () => {
  const s = fresh(),
    key = "prompts/first";
  assert.equal(changeFocus(s, "Nick", stamp, key), false);
  assert.equal(lookup(s, "Nick", key).planned, "2026-11-29");
  assert.equal(changeFocus(s, "Nick", stamp, key, "stories/first"), true);
  assert.ok(dayView(s, "Nick", stamp).focus.some((t) => t.key === key));
});
test("moving or completing a fixed occurrence preserves adjacent canonical slots and its independent deadline", () => {
  const s = fresh(),
    base = s.tasks.find((t) => t.id === "dinner");
  base.deadline = addDays(day, 1);
  const key = keyOf(base.id, day),
    nextDay = addDays(day, 7);
  editTask(s, "Nick", stamp, key, { planned: addDays(day, 8), time: "19:00" });
  const next = occurrences(s, "Stacey", addDays(day, 9)).filter((t) => t.id === base.id);
  assert.deepEqual(
    next.map((t) => t.planned),
    [addDays(day, 8), nextDay],
  );
  assert.equal(next[0].deadline, addDays(day, 1));
  assert.equal(next[1].time, "17:30");
  assert.equal(next[0].history.length, 1);
  assert.equal(complete(s, "Stacey", stamp, key), true);
  assert.equal(lookup(s, "Nick", keyOf(base.id, nextDay)).done, "");
});
test("completion-relative cadence uses the actual completion day and retries do not create duplicates", () => {
  const s = fresh(),
    key = "filter/first";
  editTask(s, "Nick", stamp, key, { planned: addDays(day, 12) });
  const finished = addDays(day, 15) + "T22:00";
  assert.equal(complete(s, "Stacey", finished, key), true);
  assert.equal(complete(s, "Nick", finished, key), false);
  const next = occurrences(s, "Nick", addDays(day, 100)).filter((t) => t.id === "filter" && !t.done);
  assert.equal(next.length, 1);
  assert.equal(next[0].planned, addDays(day, 43));
});
test("a collaborator can edit shared occurrences but private rows and revoked projects leave every day projection", () => {
  const s = fresh();
  assert.equal(lookup(s, "Stacey", "stories/first"), null);
  assert.equal(editTask(s, "Stacey", stamp, "stories/first", { title: "No" }), false);
  assert.equal(editTask(s, "Stacey", stamp, "cabin/first", { title: "Pick the cabin" }), true);
  assert.equal(lookup(s, "Nick", "cabin/first").title, "Pick the cabin");
  s.projects.find((p) => p.id === "trip").shared = false;
  assert.equal(lookup(s, "Nick", "cabin/first"), null);
  assert.ok(!dayView(s, "Nick", stamp).checkIn.some((t) => t.id === "cabin"));
});
test("a completed choice frees its slot, stays in check-in and leaves no unselected task there", () => {
  const s = fresh();
  complete(s, "Nick", stamp, "stories/first");
  changeFocus(s, "Nick", stamp, "groceries/first");
  const v = dayView(s, "Nick", stamp);
  assert.equal(v.focus.length, 3);
  assert.ok(v.checkIn.find((t) => t.id === "stories").done);
  assert.ok(!v.checkIn.some((t) => t.id === "appointment"));
  assert.equal(v.revisit.id, "appointment");
});
test("only one high-priority deferred task resurfaces and sample focus blocks avoid calendar collisions", () => {
  const s = fresh();
  const low = createTask(
    { title: "Low-priority task", project: "home", priority: "Low", planned: day },
    day,
    "low",
  );
  low.edits.first = { history: [{}, {}, {}] };
  s.tasks.push(low);
  const v = dayView(s, "Nick", stamp);
  assert.equal(v.revisit.key, "appointment/first");
  const events = calendarEvents("Nick", day),
    all = [...events, ...calendarBlocks(v, events)].sort((a, b) => a.start.localeCompare(b.start));
  assert.ok(all.every((v, i) => !i || all[i - 1].end <= v.start));
});

test("initial plans do not count as postponements, and punted commitments stay in the check-in", () => {
  const s = fresh(),
    key = "groceries/first";
  editTask(s, "Nick", stamp, key, { planned: day, time: "18:00" });
  assert.equal(lookup(s, "Nick", key).history.length, 0);
  editTask(s, "Nick", stamp, "cabin/first", { planned: addDays(day, 1) }, true);
  changeFocus(s, "Nick", stamp, key);
  const checkIn = dayView(s, "Nick", stamp).checkIn;
  assert.equal(checkIn.find((t) => t.id === "cabin").planned, addDays(day, 1));
  assert.equal(checkIn.find((t) => t.id === "cabin").history.length, 1);
});

test("simulated calendar blocks respect the current clock and a newly released gate", () => {
  const s = fresh(),
    clock = "2026-11-30T18:01";
  const blocks = calendarBlocks(dayView(s, "Nick", clock), calendarEvents("Nick", clock.slice(0, 10)));
  assert.ok(blocks.length > 0);
  assert.ok(blocks.every((b) => b.start >= "18:15"));
});
test("a long-cadence project keeps its next fixed occurrence visible after completion", () => {
  const s = fresh();
  s.tasks.push(
    createTask(
      {
        project: "home",
        title: "Smoke alarm check",
        planned: day,
        mode: "fixed",
        interval: 13,
        unit: "week",
      },
      day,
      "alarm",
    ),
  );
  complete(s, "Nick", stamp, keyOf("alarm", day));
  assert.ok(
    occurrences(s, "Nick", addDays(day, 7), day).some(
      (t) => t.id === "alarm" && !t.done && t.planned === addDays(day, 91),
    ),
  );
});

test("a gated commitment whose slot was filled returns to the drawer and stays in check-in", () => {
  const s = fresh(),
    key = "cabin/first",
    later = day + "T10:00";
  editTask(s, "Nick", stamp, key, { after: later });
  assert.equal(changeFocus(s, "Nick", stamp, "groceries/first"), true);
  const ready = dayView(s, "Nick", later);
  assert.equal(ready.focus.length, 3);
  assert.ok(ready.drawer.some((t) => t.key === key));
  assert.ok(ready.checkIn.some((t) => t.key === key));
  assert.equal(changeFocus(s, "Nick", later, key), false);
  assert.equal(changeFocus(s, "Nick", later, key, "groceries/first"), true);
  assert.equal(dayView(s, "Nick", later).checkIn.filter((t) => t.key === key).length, 1);
});

test("merging separate planned-date and time edits cannot leave a time without a date", () => {
  const s = fresh(),
    key = "groceries/first";
  editTask(s, "Nick", stamp, key, { planned: day });
  const opening = lookup(s, "Stacey", key);
  assert.equal(editTask(s, "Nick", stamp, key, { planned: "" }, false, opening), true);
  assert.equal(editTask(s, "Stacey", stamp, key, { time: "11:30" }, false, opening), false);
  assert.equal(lookup(s, "Nick", key).time, "");
});
