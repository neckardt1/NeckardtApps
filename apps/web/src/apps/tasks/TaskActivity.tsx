import { useCallback, useEffect, useState, type ReactNode } from "react";
import { taskTimeZone, type CompletedTask, type TaskActivity, type TaskList, type TasksAdapter } from "./contract";
import { timeLabel } from "./TaskCalendar";
import { listName } from "./TaskEditor";

const timestamp = new Intl.DateTimeFormat("en-US", {
  year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
  timeZone: taskTimeZone, timeZoneName: "short",
});
const civilDate = new Intl.DateTimeFormat("en-US", { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" });

function plan(date: string | null, time: string | null) {
  if (!date) return "Unscheduled";
  const label = civilDate.format(new Date(date + "T12:00:00Z"));
  return time ? label + " at " + timeLabel(time) : label;
}

const actions: Record<string, [string, string]> = {
  created: ["Created task", "creation"],
  edited: ["Edited task", "edit"],
  rescheduled: ["Rescheduled task", "reschedule"],
  completed: ["Completed task", "completion"],
  promoted: ["Moved to top of Focus", "Focus move"],
  deprioritized: ["Deprioritized in Focus", "deprioritization"],
};

const homeActions: typeof actions = {
  ...actions,
  promoted: ["Moved to top of today’s picks", "priority change"],
  deprioritized: ["Deprioritized task", "deprioritization"],
};

function Pages<T>({ load, empty, children }: {
  load: (last?: T) => Promise<T[]>; empty: string; children: (row: T) => ReactNode;
}) {
  const [rows, setRows] = useState<T[]>([]);
  const [page, setPage] = useState<{ after?: T }>({});
  const [state, setState] = useState<"loading" | "more" | "done" | "error">("loading");
  useEffect(() => {
    let active = true;
    void load(page.after).then(next => {
      if (!active) return;
      setRows(previous => page.after ? [...previous, ...next] : next);
      setState(next.length === 50 ? "more" : "done");
    }, () => { if (active) setState("error"); });
    return () => { active = false; };
  }, [load, page]);
  function request(after?: T) { setState("loading"); setPage({ after }); }
  return <>
    {rows.length > 0 && <ul className="tasks-activity-list">{rows.map(children)}</ul>}
    {state === "done" && !rows.length && <p className="tasks-empty">{empty}</p>}
    {state === "more" && <button type="button" className="tasks-page-link" onClick={() => request(rows.at(-1))}>Show older</button>}
    {state === "loading" && <p className="tasks-empty" role="status">Loading…</p>}
    {state === "error" && <p className="tasks-error" role="alert">Couldn’t load this page.{" "}
      <button type="button" className="tasks-page-link" onClick={() => request(page.after)}>Try again</button></p>}
  </>;
}

export function TaskHistory({ adapter, taskId, atHome = false }: { adapter: TasksAdapter; taskId: string; atHome?: boolean }) {
  const load = useCallback((last?: TaskActivity) => adapter.history(taskId, last?.event_id), [adapter, taskId]);
  return <Pages load={load} empty="No activity recorded since tracking began.">{event => {
    const [label, noun] = (atHome ? homeActions : actions)[event.action] ?? ["Updated task", "update"];
    return <li key={event.event_id}>
      <strong>{event.is_undo ? "Undid " + noun : label}</strong>
      {(event.from_date || event.to_date) && <span>{plan(event.from_date,event.from_time)} → {plan(event.to_date,event.to_time)}</span>}
      <small>{event.by_you ? "You" : "Household member"} · <time dateTime={event.happened_at}>{timestamp.format(new Date(event.happened_at))}</time></small>
    </li>;
  }}</Pages>;
}

export function CompletedTasks({ adapter, lists, open }: {
  adapter: TasksAdapter; lists: TaskList[]; open: (task: CompletedTask) => void;
}) {
  return <Pages load={adapter.completed} empty="No completed tasks.">{task => {
    const list = lists.find(l => l.id === task.list_id);
    return <li key={task.task_id}><button type="button" className="tasks-closed-task" aria-label={`Activity for ${task.title}`} aria-haspopup="dialog" onClick={() => open(task)}>
      <strong>{task.title}</strong><small>{list && listName(list) + " · "}
        <time dateTime={task.completed_at}>{timestamp.format(new Date(task.completed_at))}</time></small>
    </button></li>;
  }}</Pages>;
}
