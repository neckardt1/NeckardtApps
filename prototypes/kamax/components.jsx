import React, { useEffect, useRef, useState } from "react";
import { Icon } from "./icons.jsx";
import { addDays, dayLabel, localDay, localTime, priorities, repeatLabel, timeLabel } from "./model.mjs";

export function Dot({ project }) {
  return <span className={"project-dot " + project.color} aria-hidden="true" />;
}
export function ProjectTag({ project }) {
  return (
    <span className="project-tag">
      <Dot project={project} />
      {project.name}
    </span>
  );
}
export function IconButton({ icon, label, onClick }) {
  return (
    <button type="button" className="icon-button" aria-label={label} title={label} onClick={onClick}>
      <Icon name={icon} />
    </button>
  );
}
export function Modal({ title, children, onClose, small = false }) {
  const ref = useRef(null);
  useEffect(() => {
    const dialog = ref.current;
    const previous = document.activeElement;
    dialog.showModal();
    return () => {
      dialog.close();
      if (previous?.isConnected) previous.focus({ preventScroll: true });
    };
  }, []);
  return (
    <dialog
      ref={ref}
      className={"modal" + (small ? " small" : "")}
      aria-labelledby="dialog-title"
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => {
        if (e.target === ref.current) {
          const b = ref.current.getBoundingClientRect();
          if (e.clientX < b.left || e.clientX > b.right || e.clientY < b.top || e.clientY > b.bottom)
            onClose();
        }
      }}
    >
      <div className="modal-bar">
        <h2 id="dialog-title">{title}</h2>
        <IconButton icon="close" label="Close dialog" onClick={onClose} />
      </div>
      {children}
    </dialog>
  );
}
export function TaskRow({
  item,
  project,
  day,
  focused,
  showDeadline,
  onOpen,
  onComplete,
  onMenu,
  onFocus,
  onPunt,
}) {
  const start = useRef(null),
    suppress = useRef(false),
    rowRef = useRef(null),
    [shift, setShift] = useState(0);
  useEffect(() => {
    const node = rowRef.current;
    function horizontal(e) {
      const s = start.current,
        t = e.touches[0];
      if (!s || !t || !e.cancelable || e.touches.length !== 1) return;
      const dx = Math.abs(t.clientX - s.x),
        dy = Math.abs(t.clientY - s.y);
      // Cancel horizontal panning so the next tap on the newly opened sheet gets a native click.
      if (dx > 12 && dx > dy * 1.4) e.preventDefault();
    }
    node.addEventListener("touchmove", horizontal, { passive: false });
    return () => node.removeEventListener("touchmove", horizontal);
  }, []);
  function reset() {
    start.current = null;
    setShift(0);
  }
  return (
    <div className="swipe-wrap" data-task={item.title}>
      {shift !== 0 && (
        <div className={"swipe-hint " + (shift > 0 ? "promote" : "punt")}>
          <Icon name={shift > 0 ? "target" : "today"} />
          {shift > 0 ? "Focus today" : "Reschedule"}
        </div>
      )}
      <div
        ref={rowRef}
        className="task-row"
        style={shift ? { transform: "translateX(" + shift + "px)" } : undefined}
        onPointerDown={(e) => {
          suppress.current = false;
          if (e.button !== 0 || !e.isPrimary || item.done || e.target.closest("input,.more-button")) return;
          start.current = { x: e.clientX, y: e.clientY, id: e.pointerId };
        }}
        onPointerMove={(e) => {
          const s = start.current;
          if (!s || e.pointerId !== s.id) return;
          const dx = e.clientX - s.x,
            dy = Math.abs(e.clientY - s.y);
          if (dy > 12 && dy > Math.abs(dx)) {
            reset();
            return;
          }
          if (Math.abs(dx) > 12 && Math.abs(dx) > dy * 1.4) {
            if (!e.currentTarget.hasPointerCapture(e.pointerId))
              e.currentTarget.setPointerCapture(e.pointerId);
            setShift(Math.max(-100, Math.min(100, dx)));
          }
        }}
        onPointerUp={(e) => {
          const s = start.current;
          if (!s) return;
          const dx = e.clientX - s.x,
            dy = Math.abs(e.clientY - s.y);
          if (Math.abs(dx) > 54 && Math.abs(dx) > dy * 1.5) {
            suppress.current = true;
            if (dx > 0) onFocus();
            else onPunt();
          }
          reset();
        }}
        onPointerCancel={reset}
        onClickCapture={(e) => {
          if (suppress.current) {
            e.preventDefault();
            e.stopPropagation();
            suppress.current = false;
          }
        }}
      >
        <label className="check-target">
          <input
            type="checkbox"
            aria-label={"Complete " + item.title}
            disabled={!!item.done}
            checked={!!item.done}
            onChange={onComplete}
          />
          <span className="check-ring">
            <Icon name="check" size={14} />
          </span>
        </label>
        <button className="task-copy" onClick={onOpen}>
          <span className="task-title">{item.title}</span>
          <span className="metadata">
            <ProjectTag project={project} />
            {item.time && (
              <span>
                <Icon name="clock" size={13} />
                {timeLabel(item.time)}
              </span>
            )}
            {item.planned && item.planned !== day && (
              <span>
                <Icon name="today" size={13} />
                {dayLabel(item.planned)}
              </span>
            )}
            {showDeadline && item.deadline && (
              <span>
                <Icon name="flag" size={13} />
                Deadline {dayLabel(item.deadline)}
              </span>
            )}
            {item.history.length > 0 && (
              <span className="defer-meta">
                <Icon name="revisit" size={13} />
                {item.history.length} {item.history.length === 1 ? "deferral" : "deferrals"}
              </span>
            )}
          </span>
        </button>
        {focused && !item.chosen && <span className="suggested">Suggested</span>}
        <span className={"priority " + item.priority.toLowerCase()}>
          <Icon name="flag" size={13} />
          {item.priority}
        </span>
        {!item.done && (
          <button
            className="more-button"
            onClick={onMenu}
            aria-label={"Actions for " + item.title}
            title="Task actions"
          >
            <Icon name="more" />
          </button>
        )}
      </div>
    </div>
  );
}
export function EventList({ events }) {
  return (
    <div className="events">
      {events.map((event, i) => (
        <div className={"event" + (event.block ? " block" : "")} key={i}>
          <span className="event-marker" />
          <span className="event-time">
            {timeLabel(event.start)} – {timeLabel(event.end)}
          </span>
          <span className="event-title">{event.title}</span>
          <span className="event-kind">{event.block ? "Focus block" : "Sample event"}</span>
        </div>
      ))}
    </div>
  );
}
export function TaskForm({ item, template, projects, activeProject, onSave, onCancel, children }) {
  const original = useRef(item).current;
  const [data, setData] = useState(() =>
    item
      ? { ...item }
      : {
          title: "",
          notes: "",
          project: activeProject || projects.find((p) => !p.shared)?.id || projects[0].id,
          priority: "Medium",
          planned: "",
          time: "",
          deadline: "",
          after: "",
          mode: "once",
          interval: 1,
          unit: "week",
        },
  );
  const [extras, setExtras] = useState(
    Boolean(item?.after || item?.deadline || (template?.mode !== "once" && template)),
  );
  const [error, setError] = useState("");
  const field = (key) => ({
    name: key,
    value: data[key],
    onChange: (e) => setData({ ...data, [key]: e.target.value }),
  });
  const active = projects.find((p) => p.id === data.project);
  function submit(e) {
    e.preventDefault();
    if (!data.title.trim()) {
      setError("Give the task a name.");
      return;
    }
    if (
      !data.planned &&
      (data.time || (data.mode && data.mode !== "once") || (template && template.mode !== "once"))
    ) {
      setError("Choose a planned date for a time or repeating task.");
      return;
    }
    const values = {
      ...data,
      title: data.title.trim(),
      notes: data.notes.trim(),
      interval: Number(data.interval) || 1,
    };
    if (!original) {
      onSave(values);
      return;
    }
    const changes = {};
    for (const field of ["title", "notes", "priority", "planned", "time", "after", "deadline"]) {
      if (values[field] !== original[field]) changes[field] = values[field];
    }
    onSave(changes, original);
  }
  return (
    <form className="task-form" onSubmit={submit}>
      <label>
        Task name
        <input
          required
          maxLength={180}
          autoFocus
          type="text"
          placeholder="What needs doing?"
          {...field("title")}
        />
      </label>
      <label>
        Notes
        <textarea rows="2" maxLength={1800} placeholder="Add a note" {...field("notes")} />
      </label>
      <div className="form-pair">
        <label>
          Project
          {item ? (
            <span className="read-field">
              <ProjectTag project={active} />
              <Icon name={active.shared ? "people" : "lock"} size={14} />
            </span>
          ) : (
            <select aria-label="Project" {...field("project")}>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} · {p.shared ? "Shared" : "Private"}
                </option>
              ))}
            </select>
          )}
        </label>
        <label>
          Priority
          <select aria-label="Priority" {...field("priority")}>
            {priorities.map((v) => (
              <option key={v}>{v}</option>
            ))}
          </select>
        </label>
      </div>
      <div className="form-pair">
        <label>
          Planned date
          <input type="date" {...field("planned")} />
        </label>
        <label>
          Planned time
          <input type="time" {...field("time")} />
        </label>
      </div>
      <button type="button" className="disclose" aria-expanded={extras} onClick={() => setExtras(!extras)}>
        <Icon name={extras ? "down" : "right"} size={15} /> Scheduling details
      </button>
      {extras && (
        <div className="extra-fields">
          <div className="form-pair">
            <label>
              Show after
              <input type="datetime-local" {...field("after")} />
            </label>
            <label>
              Deadline
              <input type="date" {...field("deadline")} />
            </label>
          </div>
          <p className="hint">
            Planned time is visible all day. Show after keeps a task out of Today until it opens.
          </p>
          {item ? (
            <div className="repeat-info">
              <Icon name="repeat" size={16} />
              <span>
                {repeatLabel(template)}
                {template.mode !== "once" && <small>Edits apply to this occurrence.</small>}
              </span>
            </div>
          ) : (
            <>
              <label>
                Recurrence
                <select aria-label="Recurrence" {...field("mode")}>
                  <option value="once">Does not repeat</option>
                  <option value="fixed">Fixed schedule</option>
                  <option value="after">After completion</option>
                </select>
              </label>
              {data.mode !== "once" && (
                <div className="form-pair">
                  <label>
                    Repeat every
                    <input type="number" min="1" max="365" required {...field("interval")} />
                  </label>
                  <label>
                    Interval unit
                    <select aria-label="Interval unit" {...field("unit")}>
                      <option value="day">Days</option>
                      <option value="week">Weeks</option>
                    </select>
                  </label>
                </div>
              )}
            </>
          )}
        </div>
      )}
      {!!item?.history.length && (
        <details className="history">
          <summary>Deferral history ({item.history.length})</summary>
          <ul>
            {item.history
              .slice()
              .reverse()
              .map((h, i) => (
                <li key={i}>
                  <b>{h.who}</b> · {dayLabel(h.at.slice(0, 10))}
                  <br />
                  {formatPlan(h.from)} → {formatPlan(h.to)}
                </li>
              ))}
          </ul>
        </details>
      )}
      {children}
      {error && (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}
      <div className="form-actions">
        <button type="button" className="secondary" onClick={onCancel}>
          Cancel
        </button>
        <button className="primary">{item ? "Save changes" : "Add task"}</button>
      </div>
    </form>
  );
}
export function formatPlan(value) {
  if (!value) return "Unscheduled";
  const [d, t] = value.split("T");
  return dayLabel(d) + (t ? ", " + timeLabel(t) : "");
}
export function ScheduleForm({ item, now, onSave }) {
  const day = localDay(now),
    weekday = new Date(day + "T12:00:00").getDay();
  const original = useRef(item).current;
  const [date, setDate] = useState(item.planned || day),
    [time, setTime] = useState(item.time);
  const later = new Date(now);
  later.setHours(later.getHours() + 2, 0, 0, 0);
  const choices = [
    ["Later today", "clock", day, localTime(later)],
    ["Tomorrow", "sun", addDays(day, 1), item.time],
    [
      weekday === 6 || weekday === 0 ? "Next weekend" : "This weekend",
      "week",
      addDays(day, (6 - weekday + 7) % 7 || 7),
      item.time,
    ],
    ["Next week", "today", addDays(day, (8 - weekday) % 7 || 7), item.time],
  ];
  return (
    <div className="schedule">
      <p className="modal-subtitle">{item.title}</p>
      <div className="quick-list">
        {choices
          .filter(([name]) => name !== "Later today" || localDay(later) === day)
          .map(([name, icon, d, t]) => (
            <button
              key={name}
              onClick={() => onSave(name === "Later today" ? { planned: d, time: t } : { planned: d }, item)}
            >
              <Icon name={icon} />
              <span>{name}</span>
              <small>
                {name === "Later today"
                  ? timeLabel(t)
                  : dayLabel(d, { weekday: "short", month: "short", day: "numeric" })}
              </small>
            </button>
          ))}
      </div>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          const changes = {};
          if (date !== original.planned) changes.planned = date;
          if (time !== original.time) changes.time = time;
          onSave(changes, original);
        }}
      >
        <div className="form-pair">
          <label>
            Pick a date
            <input type="date" required value={date} onChange={(e) => setDate(e.target.value)} />
          </label>
          <label>
            Time (optional)
            <input type="time" value={time} onChange={(e) => setTime(e.target.value)} />
          </label>
        </div>
        <div className="form-actions">
          <button className="primary">Reschedule occurrence</button>
        </div>
      </form>
    </div>
  );
}
export function Actions({ item, isFocus, stamp, onFocus, onDrop, onPunt, onOpen }) {
  return (
    <div className="action-list">
      <p className="modal-subtitle">{item.title}</p>
      {(!item.after || item.after <= stamp) && (
        <button onClick={isFocus && item.chosen ? onDrop : onFocus}>
          <Icon name="target" />
          {isFocus && item.chosen ? "Return to drawer" : "Choose for today's focus"}
        </button>
      )}
      <button onClick={onPunt}>
        <Icon name="today" />
        Reschedule occurrence
      </button>
      <button onClick={onOpen}>
        <Icon name="sliders" />
        Task details
      </button>
    </div>
  );
}
