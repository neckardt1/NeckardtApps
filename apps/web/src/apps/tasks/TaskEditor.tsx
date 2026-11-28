import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from "react";
import type { Task, TaskFields, TaskList } from "./contract";
import { TaskIcon } from "./icons";

export const listName = (list: TaskList) => list.kind === "private" ? "Private" : "Household";

export function TasksDialog({ title, children, busy = false, onClose }: {
  title: string; children: ReactNode; busy?: boolean; onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const heading = useId();
  useEffect(() => {
    const node = dialog.current!;
    const previous = document.activeElement;
    node.showModal();
    // iOS can shrink and pan the visual viewport when the title keyboard opens.
    const viewport = window.visualViewport;
    function fitSheet() {
      if (!viewport) return;
      node.style.setProperty("--tasks-visible-height", viewport.height + "px");
      const covered = document.documentElement.clientHeight - viewport.offsetTop - viewport.height;
      node.style.setProperty("--tasks-covered-bottom", Math.max(0, covered) + "px");
    }
    fitSheet();
    viewport?.addEventListener("resize", fitSheet);
    viewport?.addEventListener("scroll", fitSheet);
    return () => {
      viewport?.removeEventListener("resize", fitSheet);
      viewport?.removeEventListener("scroll", fitSheet);
      node.close();
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus({ preventScroll: true });
    };
  }, []);
  return <dialog className="tasks-dialog" ref={dialog} aria-labelledby={heading}
    onCancel={event => { event.preventDefault(); if (!busy) onClose(); }}
    onClick={event => {
      if (event.target !== event.currentTarget || busy) return;
      const bounds = event.currentTarget.getBoundingClientRect();
      if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) onClose();
    }}>
    <header><h2 id={heading}>{title}</h2>
      <button type="button" className="tasks-icon-button" aria-label="Close dialog" onClick={onClose} disabled={busy}><TaskIcon name="close" /></button>
    </header>
    {children}
  </dialog>;
}

function DatePair({ label, field, task }: { label: string; field: "planned" | "deadline" | "showAfter"; task?: Task }) {
  const [date, setDate] = useState(task?.[`${field}Date`] ?? "");
  const [time, setTime] = useState(task?.[`${field}Time`] ?? "");
  return <div className="tasks-field-pair">
    <label>{label} date<input name={field + "Date"} type="date" value={date}
      onChange={event => { setDate(event.target.value); if (!event.target.value) setTime(""); }} /></label>
    <label>{label} time<input name={field + "Time"} type="time" value={time} disabled={!date}
      onChange={event => setTime(event.target.value)} /></label>
  </div>;
}

export type SaveResult = "saved" | "failed" | "invalid" | "conflict";
export type FormDraft = { listId: string; fields: TaskFields };
type Props = {
  task?: Task; listId: string; lists: TaskList[]; busy: boolean; error: string | null; conflict: boolean; latest?: Task;
  onClose: () => void; onSave: (draft: FormDraft) => Promise<SaveResult>; onLoadLatest: (task: Task) => void;
  history?: ReactNode;
  focusAction?: { label: string; run: () => void };
};

export function TaskEditor({ task, listId, lists, busy, error, conflict, latest, onClose, onSave, onLoadLatest, focusAction, history }: Props) {
  const [historyOpen, setHistoryOpen] = useState(false);
  const [attempt, setAttempt] = useState<FormDraft | null>(null);
  const [titleError, setTitleError] = useState("");
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || conflict) return;
    let draft = attempt;
    if (!draft) {
      const form = new FormData(event.currentTarget);
      const value = (name: string) => String(form.get(name) ?? "") || null;
      const title = value("title")?.trim();
      if (!title) { setTitleError("Give the task a title."); return; }
      setTitleError("");
      draft = { listId: value("listId") ?? listId, fields: { title,
        plannedDate: value("plannedDate"), plannedTime: value("plannedTime"), deadlineDate: value("deadlineDate"),
        deadlineTime: value("deadlineTime"), showAfterDate: value("showAfterDate"), showAfterTime: value("showAfterTime") } };
      if (!task) setAttempt(draft);
    }
    const result = await onSave(draft);
    // An uncertain create can already exist. Retry that exact request, even if a
    // collaborator has since edited or finished the task.
    if (result === "invalid") setAttempt(null);
  }
  return <TasksDialog title={task ? "Edit task" : "New task"} onClose={onClose} busy={busy}>
    <form className="tasks-form" onSubmit={submit}>
      <div className="tasks-form-fields">
        <fieldset disabled={busy || !!attempt || conflict}>
          <label>Title<input name="title" type="text" required defaultValue={task?.title}
            ref={input => { if (input) input.autofocus = true; }} /></label>
          {task ? <p className="tasks-read-list">List <strong>{listName(lists.find(list => list.id === task.listId)!)}</strong></p> :
            <label>List<select name="listId" defaultValue={listId}>{lists.map(list => <option value={list.id} key={list.id}>{listName(list)}</option>)}</select></label>}
          <p className="tasks-zone">Dates and times use Pacific time.</p>
          <DatePair field="planned" label="Planned" task={task} />
          <DatePair field="deadline" label="Deadline" task={task} />
          <DatePair field="showAfter" label="Show after" task={task} />
        </fieldset>
        {history && <details className="tasks-history" onToggle={e => setHistoryOpen(e.currentTarget.open)}>
          <summary>Activity</summary>{historyOpen && history}
        </details>}
        {(titleError || error) && <p className="tasks-error" role="alert">{titleError || error}</p>}
      </div>
      <div className="tasks-form-actions">
        {focusAction && !conflict && <button type="button" className="tasks-focus-action" onClick={focusAction.run} disabled={busy}>{focusAction.label}</button>}
        <button type="button" onClick={onClose} disabled={busy}>{conflict ? "Close" : "Cancel"}</button>
        {conflict ? latest && <button type="button" className="tasks-primary" disabled={busy} onClick={() => onLoadLatest(latest)}>Load latest version</button> :
          <button type="submit" className="tasks-primary" disabled={busy}>{busy ? "Saving…" : task ? "Save changes" : attempt ? "Retry add" : "Add task"}</button>}
      </div>
    </form>
  </TasksDialog>;
}
