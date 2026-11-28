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

export function weekTasks(snapshot: TaskSnapshot, now: Date): Task[] {
  const today = pacificDate(now);
  const weekday = new Date(today + "T12:00:00Z").getUTCDay();
  const monday = shiftDate(today, -((weekday + 6) % 7));
  const sunday = shiftDate(monday, 6);
  const date = (task: Task) => task.plannedDate ?? task.deadlineDate;
  return snapshot.tasks.filter(task => {
    const day = date(task);
    return day !== null && day >= monday && day <= sunday;
  }).sort((a, b) => date(a)!.localeCompare(date(b)!) || compareTasks(a, b));
}
