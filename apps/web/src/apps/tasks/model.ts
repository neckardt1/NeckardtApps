import { taskTimeZone, type Task, type TaskSnapshot } from "./contract.ts";

const pacificDay = new Intl.DateTimeFormat("en", {
  timeZone: taskTimeZone, year: "numeric", month: "2-digit", day: "2-digit",
});

export function pacificDate(now: Date): string {
  const parts = pacificDay.formatToParts(now);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find(part => part.type === type)!.value;
  return [part("year"), part("month"), part("day")].join("-");
}

// Arithmetic on civil dates, independent of the device timezone and DST.
export function shiftDate(day: string, days: number): string {
  const date = new Date(day + "T12:00:00Z");
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export function gateOpen(task: Task, now: Date): boolean {
  return task.showAfterAt === null || Date.parse(task.showAfterAt) <= now.getTime();
}

function compareTasks(a: Task, b: Task): number {
  const key = (task: Task) => [
    task.deadlineDate ?? "9999", task.deadlineTime ?? "24:00",
    task.plannedDate ?? "9999", task.plannedTime ?? "24:00",
  ].join(" ");
  return key(a).localeCompare(key(b)) || a.title.localeCompare(b.title) || a.id.localeCompare(b.id);
}

export function todaySections(snapshot: TaskSnapshot, now: Date) {
  const today = pacificDate(now);
  const tomorrow = shiftDate(today, 1);
  const eligible = snapshot.tasks.filter(task => gateOpen(task, now));
  const byId = new Map(eligible.map(task => [task.id, task]));
  // Preserve the server's most-recent-promotion-first order, even for future plans.
  const manual: Task[] = [];
  const suppressed = new Set<string>();
  for (const choice of snapshot.focus) {
    const task = byId.get(choice.taskId);
    if (task && choice.state === "promoted") {
      manual.push(task);
      byId.delete(task.id);
    } else if (choice.state === "deprioritized" && snapshot.focusDay === today) {
      suppressed.add(choice.taskId);
    }
  }
  const suggested: Task[] = [];
  const everythingElse: Task[] = [];
  for (const task of byId.values()) {
    if (task.plannedDate && task.plannedDate > today && !suppressed.has(task.id)) continue;
    const timely = (task.plannedDate && task.plannedDate <= today)
      || (task.deadlineDate && task.deadlineDate <= tomorrow);
    if (timely && !suppressed.has(task.id)) suggested.push(task);
    else everythingElse.push(task);
  }
  return { focus: [...manual, ...suggested.sort(compareTasks)], everythingElse: everythingElse.sort(compareTasks) };
}

export function inboxTasks(snapshot: TaskSnapshot, now: Date): Task[] {
  const privateList = snapshot.lists.find(list => list.kind === "private");
  return snapshot.tasks.filter(task => task.listId === privateList?.id
    && !task.plannedDate && !task.deadlineDate && gateOpen(task, now));
}

export function upcomingSections(snapshot: TaskSnapshot, now: Date) {
  const today = pacificDate(now);
  const groups = new Map<string, Task[]>();
  for (const task of snapshot.tasks) {
    // Show each task once, at its next plan or deadline. A deferred capture
    // with neither still has a day when it will become available.
    const next = [task.plannedDate, task.deadlineDate]
      .filter((date): date is string => date !== null && date >= today).sort()[0]
      ?? (gateOpen(task, now) ? null : task.showAfterDate);
    if (!next) continue;
    const group = groups.get(next);
    if (group) group.push(task);
    else groups.set(next, [task]);
  }
  return [...groups].sort(([a], [b]) => a.localeCompare(b))
    .map(([date, tasks]) => ({ date, tasks: tasks.sort(compareTasks) }));
}
