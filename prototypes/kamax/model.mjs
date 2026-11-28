// The fixture and every user edit belong to this browser's sample workspace.
export const people = ["Nick", "Stacey"];
export const palette = ["violet", "teal", "amber", "rose", "blue"];
export const priorities = ["High", "Medium", "Low"];
export const localDay = (date) =>
  [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("-");
export const localTime = (date) => date.toTimeString().slice(0, 5);
export const localStamp = (date) => localDay(date) + "T" + localTime(date);
export function addDays(day, amount) {
  const date = new Date(day + "T12:00:00");
  date.setDate(date.getDate() + amount);
  return localDay(date);
}
const dayNumber = (day) => Date.parse(day + "T00:00:00Z") / 86400000;
const distance = (a, b) => dayNumber(b) - dayNumber(a);
export const access = (project, who) => project && (project.owner === who || project.shared);
export const dayLabel = (day, options = { month: "short", day: "numeric" }) =>
  new Date(day + "T12:00:00").toLocaleDateString("en-US", options);
export const timeLabel = (time) =>
  time
    ? new Date("2000-01-01T" + time).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })
    : "";
export const keyOf = (id, slot) => id + "/" + slot;

export function createTask(fields, today, id = crypto.randomUUID()) {
  const { mode = "once", interval = 1, unit = "week", ...values } = fields;
  return {
    id,
    anchor: fields.planned || today,
    mode,
    interval,
    unit,
    next: [],
    edits: {},
    title: "",
    notes: "",
    priority: "Medium",
    planned: "",
    time: "",
    after: "",
    deadline: "",
    ...values,
  };
}

export function seed(now) {
  const day = localDay(now);
  const projects = [
    { id: "interview", name: "Interview prep", owner: "Nick", shared: false, color: "violet" },
    { id: "home", name: "Household", owner: "Nick", shared: true, color: "teal" },
    { id: "trip", name: "Weekend away", owner: "Stacey", shared: true, color: "amber" },
    { id: "personal-n", name: "Personal", owner: "Nick", shared: false, color: "rose" },
    { id: "personal-s", name: "Personal", owner: "Stacey", shared: false, color: "rose" },
  ];
  const make = (id, project, title, priority, offset, time = "", extras = {}) =>
    createTask(
      { project, title, priority, planned: offset == null ? "" : addDays(day, offset), time, ...extras },
      day,
      id,
    );
  const tasks = [
    make("stories", "interview", "Outline two interview stories", "High", 0, "09:00", {
      deadline: addDays(day, 3),
      notes: "Pick one example of solving a technical problem and one of working through a disagreement.",
    }),
    make("cabin", "trip", "Book the lakeside cabin", "High", 0, "12:30", {
      deadline: addDays(day, 2),
      notes: "Compare the two saved cabins and check the cancellation windows.",
    }),
    make("dinner", "home", "Plan dinners for next week", "Medium", 0, "17:30", {
      mode: "fixed",
      interval: 1,
      unit: "week",
    }),
    make("appointment", "personal-n", "Book an annual checkup", "High", -1),
    make("groceries", "home", "Make a grocery list", "Low", null),
    make("daypack", "trip", "Check the daypacks", "Low", null),
    make("prompts", "interview", "Practice the system design prompt", "Medium", 1, "10:00"),
    make("flight", "trip", "Check in for the flight", "High", 2, "19:00", {
      after: addDays(day, 2) + "T18:00",
      deadline: addDays(day, 3),
    }),
    make("filter", "home", "Replace the water filter", "Medium", 3, "", {
      mode: "after",
      interval: 4,
      unit: "week",
    }),
    make("route", "trip", "Choose a trail for Saturday", "Medium", 4),
    make("library", "personal-s", "Pick up the library holds", "High", 0, "15:00"),
    make("returns", "personal-s", "Return the spare charger", "Low", null),
  ];
  const checkup = tasks.find((t) => t.id === "appointment");
  checkup.edits.first = {
    history: [
      { at: addDays(day, -6) + "T09:10", who: "Nick", from: addDays(day, -6), to: addDays(day, -3) },
      { at: addDays(day, -3) + "T11:20", who: "Nick", from: addDays(day, -3), to: addDays(day, -1) },
    ],
  };
  const chosen = (ids) =>
    ids.map((id) => ({ key: keyOf(id, id === "dinner" ? day : "first"), chosen: true }));
  return {
    version: 1,
    rev: "seed",
    projects,
    tasks,
    focus: {
      Nick: { [day]: chosen(["stories", "cabin", "dinner"]) },
      Stacey: { [day]: chosen(["cabin", "library"]) },
    },
    settings: { Nick: { nudges: 0, blocks: false }, Stacey: { nudges: 0, blocks: false } },
  };
}

const period = (task) => task.interval * (task.unit === "week" ? 7 : 1);
export function repeatLabel(task) {
  if (task.mode === "once") return "Does not repeat";
  const span = task.interval === 1 ? task.unit : task.interval + " " + task.unit + "s";
  return task.mode === "after"
    ? "One occurrence every " + span + " after completion"
    : "Every " + span + " on a fixed schedule";
}
function offsetField(value, first, date) {
  if (!value) return "";
  return addDays(value.slice(0, 10), distance(first, date)) + value.slice(10);
}
export function occurrence(task, slot) {
  let origin = task.anchor;
  if (task.mode === "fixed") {
    if (
      !/^\d{4}-\d\d-\d\d$/.test(slot) ||
      slot < task.anchor ||
      distance(task.anchor, slot) % period(task) !== 0
    )
      return null;
    origin = slot;
  } else if (slot !== "first") {
    const next = task.next.find((n) => n.slot === slot);
    if (!next) return null;
    origin = next.date;
  }
  return {
    key: keyOf(task.id, slot),
    id: task.id,
    slot,
    origin,
    project: task.project,
    title: task.title,
    notes: task.notes,
    priority: task.priority,
    planned: task.planned ? origin : "",
    time: task.time,
    after: offsetField(task.after, task.anchor, origin),
    deadline: offsetField(task.deadline, task.anchor, origin),
    done: "",
    history: [],
    ...task.edits[slot],
  };
}
export function lookup(state, who, key) {
  const [id, slot] = key.split("/");
  const task = state.tasks.find((t) => t.id === id);
  if (
    !task ||
    !access(
      state.projects.find((p) => p.id === task.project),
      who,
    )
  )
    return null;
  return occurrence(task, slot);
}
export function occurrences(state, who, until, projectDay = "") {
  const projects = new Set(state.projects.filter((p) => access(p, who)).map((p) => p.id));
  return state.tasks
    .filter((t) => projects.has(t.project))
    .flatMap((task) => {
      let slots;
      if (task.mode === "fixed") {
        // Edited slots keep their original identity even when moved across another occurrence.
        slots = new Set([task.anchor, ...Object.keys(task.edits)]);
        let date = task.anchor;
        for (; date <= until; date = addDays(date, period(task))) slots.add(date);
        if (
          projectDay &&
          ![...slots].some((slot) => {
            const item = occurrence(task, slot);
            return !item.done && item.planned >= projectDay;
          })
        ) {
          while (task.edits[date]) date = addDays(date, period(task));
          slots.add(date);
        }
      } else slots = ["first", ...task.next.map((n) => n.slot)];
      return [...slots].map((s) => occurrence(task, s));
    });
}
export const eligible = (task, stamp) =>
  !task.done && (!task.planned || task.planned <= stamp.slice(0, 10)) && (!task.after || task.after <= stamp);
export function byPriority(a, b) {
  return (
    priorities.indexOf(a.priority) - priorities.indexOf(b.priority) ||
    (a.planned || "9999").localeCompare(b.planned || "9999") ||
    (a.time || "99").localeCompare(b.time || "99") ||
    a.title.localeCompare(b.title)
  );
}
export function dayView(state, who, stamp) {
  const day = stamp.slice(0, 10);
  const all = occurrences(state, who, day);
  const ready = all.filter((t) => eligible(t, stamp)).sort(byPriority);
  const plan =
    state.focus[who][day] ??
    ready
      .filter((t) => t.priority === "High" && t.planned === day)
      .slice(0, 3)
      .map((t) => ({ key: t.key, chosen: false }));
  const focus = plan
    .filter((entry) => !entry.checkInOnly)
    .flatMap((entry) => {
      const t = ready.find((t) => t.key === entry.key);
      return t ? [{ ...t, chosen: entry.chosen }] : [];
    })
    .slice(0, 3);
  const drawer = ready.filter((t) => !focus.some((f) => f.key === t.key));
  const revisit = drawer
    .filter((t) => t.priority === "High" && t.history.length >= 2)
    .sort((a, b) => b.history.length - a.history.length || byPriority(a, b))[0];
  const checkIn = plan
    .filter((entry) => entry.chosen)
    .map((entry) => lookup(state, who, entry.key))
    .filter(Boolean);
  return {
    day,
    stamp,
    focus,
    drawer,
    revisit,
    checkIn,
    completed: all.filter((t) => t.done?.slice(0, 10) === day),
  };
}

// An earlier commitment can stay in check-in after its focus slot has been reassigned.
function retainedCheckIn(view, changingKey) {
  return view.checkIn
    .filter((t) => t.key !== changingKey && !view.focus.some((active) => active.key === t.key))
    .map((t) => ({ key: t.key, chosen: true, checkInOnly: true }));
}

export function changeFocus(state, who, stamp, key, replace = "") {
  const view = dayView(state, who, stamp);
  const item = lookup(state, who, key);
  if (!item || item.done || (item.after && item.after > stamp)) return false;
  const entries = view.focus.map(({ key, chosen }) => ({ key, chosen }));
  const existing = entries.find((e) => e.key === key);
  if (existing) existing.chosen = true;
  else if (entries.length < 3) entries.push({ key, chosen: true });
  else {
    const index = entries.findIndex((e) => e.key === replace);
    if (index < 0) return false;
    entries[index] = { key, chosen: true };
  }
  // Pull a future occurrence into today only after an explicit choice and any replacement.
  if (item.planned > view.day) editTask(state, who, stamp, key, { planned: view.day });
  state.focus[who][view.day] = [...entries, ...retainedCheckIn(view, key)];
  return true;
}
export function dropFocus(state, who, stamp, key) {
  const view = dayView(state, who, stamp);
  state.focus[who][view.day] = [
    ...view.focus.filter((t) => t.key !== key).map(({ key, chosen }) => ({ key, chosen })),
    ...retainedCheckIn(view, key),
  ];
}
export function editTask(state, who, stamp, key, updates, deliberatePunt = false, original = null) {
  const old = lookup(state, who, key);
  if (!old || old.done) return false;
  const task = state.tasks.find((t) => t.id === old.id);
  if (original && Object.keys(updates).some((k) => old[k] !== original[k] && old[k] !== updates[k]))
    return false;
  const planned = updates.planned ?? old.planned,
    time = updates.time ?? old.time;
  if (!planned && (time || task.mode !== "once")) return false;
  const edits = { ...task.edits[old.slot], ...updates };
  if (
    ("planned" in updates && old.planned !== updates.planned) ||
    ("time" in updates && old.time !== updates.time)
  ) {
    const before = [old.planned, old.time].filter(Boolean).join("T");
    const after = [updates.planned ?? old.planned, updates.time ?? old.time].filter(Boolean).join("T");
    const laterDate = old.planned && planned > old.planned;
    const laterTime = old.planned === planned && old.time && time > old.time;
    const newlyPunted =
      deliberatePunt && !old.time && (!old.planned || old.planned === planned) && after > stamp;
    if (laterDate || laterTime || newlyPunted)
      edits.history = [...old.history, { at: stamp, who, from: before, to: after }];
  }
  task.edits[old.slot] = edits;
  return true;
}
export function complete(state, who, stamp, key) {
  const old = lookup(state, who, key);
  if (!old || old.done) return false;
  const task = state.tasks.find((t) => t.id === old.id);
  task.edits[old.slot] = { ...task.edits[old.slot], done: stamp };
  if (task.mode === "after") {
    task.next.push({
      slot: "next-" + (task.next.length + 1),
      date: addDays(stamp.slice(0, 10), period(task)),
    });
  }
  return true;
}
export function calendarEvents(who, day) {
  const weekday = new Date(day + "T12:00:00").getDay();
  if (weekday === 0 || weekday === 6) return [{ title: "Coffee with Jamie", start: "10:30", end: "11:00" }];
  return who === "Nick"
    ? [{ title: "Design catch-up", start: "10:00", end: "10:30" }]
    : [{ title: "Team check-in", start: "09:30", end: "10:00" }];
}
export function calendarBlocks(view, events) {
  const toMinute = (time) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3));
  const toTime = (n) => [Math.floor(n / 60), n % 60].map((v) => String(v).padStart(2, "0")).join(":");
  const busy = events.map((e) => [toMinute(e.start), toMinute(e.end)]);
  return [...view.focus, ...view.drawer]
    .filter((t) => t.priority === "High")
    .sort(byPriority)
    .slice(0, 3)
    .flatMap((t) => {
      const available = Math.max(toMinute(view.stamp.slice(11)), t.time ? toMinute(t.time) : 9 * 60);
      let start = Math.ceil(available / 15) * 15;
      while (start + 30 <= 24 * 60 && busy.some(([a, b]) => start < b && start + 30 > a)) start += 15;
      if (start + 30 >= 24 * 60) return [];
      busy.push([start, start + 30]);
      return [{ title: t.title, start: toTime(start), end: toTime(start + 30), block: true }];
    });
}
