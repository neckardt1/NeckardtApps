import { useEffect, useId, useRef, useState } from "react";
import type { Task, TaskList } from "./contract";
import { dateLabel, timeLabel } from "./TaskCalendar";
import { listName } from "./TaskEditor";
import { TaskIcon } from "./icons";
import { useTaskSwipe } from "./useTaskSwipe";

type Props = {
  task: Task; list: TaskList; today: string; atHome: boolean; inFocus: boolean; gated: boolean; busy: boolean; expanded: boolean;
  onEdit: () => void; onSchedule: (keyboard: boolean) => void; onPromote: () => void; onDrop: () => void; onComplete: () => void;
};

function RowMenu({ atHome, inFocus, gated, busy, onPromote, onDrop, onComplete }: Pick<Props, "atHome" | "inFocus" | "gated" | "busy" | "onPromote" | "onDrop" | "onComplete">) {
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const popover = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const close = () => popover.current?.hidePopover();
    window.addEventListener("resize", close);
    window.addEventListener("scroll", close, true);
    return () => { window.removeEventListener("resize", close); window.removeEventListener("scroll", close, true); };
  }, [open]);
  function choose(run: () => void) { popover.current!.hidePopover(); run(); }

  return <>
    <button ref={trigger} type="button" className="tasks-icon-button" aria-label="More actions" title="More actions"
      aria-haspopup="menu" aria-expanded={open} aria-controls={id} popoverTarget={id} disabled={busy}><TaskIcon name="more" /></button>
    <div id={id} ref={popover} popover="auto" className="tasks-more" role="menu" aria-label="Task actions"
      onToggle={event => {
        const menu = event.currentTarget;
        const visible = menu.matches(":popover-open");
        setOpen(visible);
        if (!visible) return;
        const bounds = trigger.current!.getBoundingClientRect();
        menu.style.left = Math.max(4, Math.min(innerWidth - 4, bounds.right) - menu.offsetWidth) + "px";
        menu.style.top = (bounds.bottom + menu.offsetHeight + 4 <= innerHeight ? bounds.bottom + 2 : Math.max(4, bounds.top - menu.offsetHeight - 2)) + "px";
        menu.querySelector<HTMLElement>("button:not(:disabled)")?.focus({ preventScroll: true });
      }}
      onBlur={event => { if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget as Node)) popover.current?.hidePopover(); }}
      onKeyDown={event => {
        if (event.key === "Escape") { event.preventDefault(); popover.current?.hidePopover(); trigger.current?.focus(); return; }
        const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")];
        const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
        const step: Record<string, number> = { ArrowDown: index + 1, ArrowUp: index - 1, Home: 0, End: buttons.length - 1 };
        if (Object.hasOwn(step, event.key)) { event.preventDefault(); buttons.at((step[event.key] + buttons.length) % buttons.length)?.focus(); }
      }}>
      {!gated && <button role="menuitem" type="button" onClick={() => choose(onPromote)}><TaskIcon name="focus" />{!inFocus ? "Prioritize" : atHome ? "Move to top" : "Move to top of Focus"}</button>}
      {inFocus && <button role="menuitem" type="button" onClick={() => choose(onDrop)}><TaskIcon name="deprioritize" />Deprioritize</button>}
      <button role="menuitem" type="button" onClick={() => choose(onComplete)}><TaskIcon name="check" />Complete task</button>
    </div>
  </>;
}

export function TaskRow(props: Props) {
  const { task, list, today, atHome, inFocus, gated, busy, expanded, onEdit, onSchedule, onPromote, onDrop, onComplete } = props;
  const metaId = useId();
  const swipeDropsFocus = expanded && inFocus;
  const wrap = useTaskSwipe(side => {
    if (busy) return;
    if (side === "right") onPromote();
    else if (swipeDropsFocus) onDrop();
    else onSchedule(false);
  });
  return <div ref={wrap} className="tasks-swipe" data-task={task.title} data-schedule-open={expanded || undefined}>
    <div aria-hidden="true" className="tasks-hint tasks-hint-promote"><TaskIcon name="focus" />Prioritize</div>
    <div aria-hidden="true" className="tasks-hint tasks-hint-schedule"><TaskIcon name={swipeDropsFocus ? "deprioritize" : "today"} />
      {swipeDropsFocus ? "Deprioritize" : "Reschedule"}</div>
    <div className="tasks-row">
      <label className="tasks-check">
        <input type="checkbox" checked={false} disabled={busy} onChange={onComplete} aria-label={"Complete " + task.title} />
        <span aria-hidden="true"><TaskIcon name="check" size={13} /></span>
      </label>
      <button className="tasks-copy" type="button" disabled={busy} aria-label={task.title} aria-describedby={metaId} aria-haspopup="dialog" onClick={onEdit}>
        <span className="tasks-title">{task.title}</span>
        <span className="tasks-meta" id={metaId}>
          <span className={"tasks-list-dot " + list.kind}>{listName(list)}</span>
          {task.plannedDate && (task.plannedDate !== today || task.plannedTime) && <span>
            {task.plannedDate !== today && dateLabel(task.plannedDate)} {task.plannedTime && timeLabel(task.plannedTime)}</span>}
          {task.deadlineDate && <span>Due {dateLabel(task.deadlineDate)} {task.deadlineTime && timeLabel(task.deadlineTime)}</span>}
          {gated && task.showAfterDate && <span>Show after {dateLabel(task.showAfterDate)} {task.showAfterTime && timeLabel(task.showAfterTime)}</span>}
        </span>
      </button>
      <div className="tasks-row-actions">
        <button type="button" className="tasks-icon-button" aria-label="Edit task" title="Edit task" disabled={busy} onClick={onEdit}><TaskIcon name="edit" /></button>
        <button type="button" className="tasks-icon-button" id={"task-date-toggle-" + task.id} aria-label="Set date" title="Set date" disabled={busy} aria-expanded={expanded}
          onClick={() => onSchedule(true)}><TaskIcon name="today" /></button>
        <RowMenu {...{ atHome, inFocus, gated, busy, onPromote, onDrop, onComplete }} />
      </div>
    </div>
  </div>;
}
