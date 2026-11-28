import { useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import type { Task } from "./contract";
import { shiftDate } from "./model";
import { TaskIcon } from "./icons";

const civilFormat = (options: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat("en-US", { ...options, timeZone: "UTC" });
const shortDate = civilFormat({ month: "short", day: "numeric" });
const fullDate = civilFormat({ weekday: "long", month: "long", day: "numeric", year: "numeric" });
const monthName = civilFormat({ month: "short", year: "numeric" });
const weekdays = ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"];
const asDate = (day: string) => new Date(day + "T12:00:00Z");
const mondayIndex = (day: Date) => (day.getUTCDay() + 6) % 7;

export function dateLabel(day: string) { return shortDate.format(asDate(day)); }

export function timeLabel(time: string) {
  const [hour, minute] = time.split(":");
  return `${Number(hour) % 12 || 12}:${minute} ${Number(hour) < 12 ? "AM" : "PM"}`;
}

function calendarMonths(today: string, offset: number) {
  const start = asDate(today);
  return Array.from({ length: 3 }, (_, index) => {
    const year = start.getUTCFullYear(), month = start.getUTCMonth() + offset + index;
    const first = new Date(Date.UTC(year, month, 1, 12));
    const count = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
    const firstDay = offset === 0 && index === 0 ? Math.max(1, start.getUTCDate() - mondayIndex(start)) : 1;
    const days = Array.from({ length: count - firstDay + 1 }, (_, i) => {
      const value = new Date(Date.UTC(year, month, firstDay + i, 12));
      return { iso: value.toISOString().slice(0, 10), number: value.getUTCDate(), weekday: mondayIndex(value), label: fullDate.format(value) };
    });
    return { title: monthName.format(first), short: monthName.formatToParts(first).find(part => part.type === "month")!.value, days };
  });
}

function CalendarDays({ today, selected, onSelect }: { today: string; selected: string | null; onSelect: (date: string) => void }) {
  const [offset, setOffset] = useState(0);
  const [focused, setFocused] = useState(selected ?? today);
  const calendar = useRef<HTMLDivElement>(null);
  const pendingFocus = useRef<string | null>(null);
  const months = useMemo(() => calendarMonths(today, offset), [today, offset]);
  const first = months[0].days[0].iso, last = months[2].days.at(-1)!.iso;
  const tabDay = focused >= first && focused <= last ? focused : today >= first && today <= last ? today : first;

  useLayoutEffect(() => {
    const panel = calendar.current!.closest<HTMLElement>(".tasks-schedule")!;
    const container = calendar.current!.querySelector<HTMLElement>(".tasks-months")!;
    const days = container.querySelectorAll<HTMLElement>("[data-date]");
    function fit() {
      delete panel.dataset.fortnight;
      panel.style.removeProperty("--tasks-day-height");
      if (panel.clientWidth > 540 || !matchMedia("(max-width: 720px)").matches) return;
      const bottom = (window.visualViewport?.offsetTop ?? 0) + (window.visualViewport?.height ?? innerHeight) - 8;
      const available = bottom - days[0].getBoundingClientRect().top;
      const rowHeight = days[0].getBoundingClientRect().height;
      const weeks = Math.round((days[days.length - 1].offsetTop - days[0].offsetTop) / rowHeight) + 1;
      if (weeks * rowHeight <= available) return;
      // A narrower screen keeps seven generous columns. Roomier phones fit two
      // weeks across, bringing the third month within a swipe-and-tap reach.
      const twoWeeks = available < weeks * 26 && panel.clientWidth >= 336;
      if (twoWeeks) panel.dataset.fortnight = "";
      const height = Math.max(26, Math.min(32, Math.floor(available / (twoWeeks ? Math.ceil(weeks / 2) : weeks))));
      panel.style.setProperty("--tasks-day-height", height + "px");
    }
    fit();
    if (pendingFocus.current) {
      calendar.current!.querySelector<HTMLElement>(`[data-date="${pendingFocus.current}"]`)?.focus();
      pendingFocus.current = null;
    }
    window.addEventListener("resize", fit);
    return () => window.removeEventListener("resize", fit);
  }, [months]);

  function navigate(event: KeyboardEvent, date: string, weekday: number) {
    const stride = calendar.current!.closest(".tasks-schedule")?.hasAttribute("data-fortnight") ? 14 : 7;
    const steps: Record<string, number> = { ArrowRight: 1, ArrowLeft: -1, ArrowUp: -stride, ArrowDown: stride, Home: -weekday, End: 6 - weekday };
    if (!Object.hasOwn(steps, event.key)) return;
    event.preventDefault();
    const next = shiftDate(date, steps[event.key]);
    if (next < first || next > last) {
      pendingFocus.current = next;
      setOffset(value => value + (next < first ? -1 : 1));
    } else calendar.current!.querySelector<HTMLElement>(`[data-date="${next}"]`)?.focus();
  }
  return <div className="tasks-calendar" role="group" aria-label="Calendar dates" ref={calendar}>
    <div className="tasks-month-controls">
      <span aria-live="polite">{months[0].title} – {months[2].title}</span>
      <button type="button" aria-label="Previous month" title="Previous month" onClick={() => setOffset(offset - 1)}><TaskIcon name="left" size={16} /></button>
      <button type="button" aria-label="Next month" title="Next month" onClick={() => setOffset(offset + 1)}><TaskIcon name="right" size={16} /></button>
    </div>
    <div aria-hidden="true" className="tasks-weekdays tasks-continuous-days">
      {[...weekdays, ...weekdays].map((day, i) => <span key={i}>{day}</span>)}
    </div>
    <div className="tasks-months">{months.map(month => <div className="tasks-month" key={month.title}>
      <div className="tasks-month-title">{month.title}</div>
      <div className="tasks-weekdays tasks-month-days" aria-hidden="true">{weekdays.map(day => <span key={day}>{day}</span>)}</div>
      <div className="tasks-dates">{month.days.map((day, i) => <button type="button" key={day.iso} data-date={day.iso}
        style={{ gridColumnStart: i === 0 ? day.weekday + 1 : undefined }} aria-label={day.label}
        aria-pressed={selected === day.iso} aria-current={today === day.iso ? "date" : undefined}
        tabIndex={day.iso === tabDay ? 0 : -1} onFocus={() => setFocused(day.iso)}
        onKeyDown={event => navigate(event, day.iso, day.weekday)} onClick={() => onSelect(day.iso)}>
        {i === 0 && <small aria-hidden="true">{month.short}</small>}{day.number}
      </button>)}</div>
    </div>)}</div>
  </div>;
}

type Props = { task: Task; today: string; inFocus: boolean; busy: boolean; focusOnOpen: boolean;
  onChoose: (date: string, time: string | null) => void; onDrop: () => void; onClose: () => void };

export function TaskCalendar({ task, today, inFocus, busy, focusOnOpen, onChoose, onDrop, onClose }: Props) {
  const [time, setTime] = useState(task.plannedTime ?? "");
  const panel = useRef<HTMLElement>(null);
  const weekday = mondayIndex(asDate(today));
  const shortcuts = [
    { label: "Tomorrow", icon: "tomorrow", days: 1 }, { label: "Later this week", icon: "week", days: weekday < 6 ? Math.min(3, 6 - weekday) : null },
    { label: "Weekend", icon: "weekend", days: (5 - weekday + 7) % 7 || 7 }, { label: "Next week", icon: "nextWeek", days: 7 - weekday },
    { label: "Later", icon: "later", days: 14 }
  ] as const;
  const title = useId();
  useLayoutEffect(() => { if (focusOnOpen) panel.current?.focus({ preventScroll: true }); }, [focusOnOpen]);
  function choose(date: string) { if (!busy) onChoose(date, time || null); }
  return <section ref={panel} tabIndex={-1} className="tasks-schedule" aria-label={"Reschedule " + task.title}
    onKeyDown={event => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      document.getElementById("task-date-toggle-" + task.id)?.focus({ preventScroll: true });
      onClose();
    }}>
    <fieldset disabled={busy}>
      <div className="tasks-schedule-heading">
        <h3 id={title}>Reschedule</h3>
        {inFocus && <button className="tasks-drop" type="button" title="Move to Everything Else and keep dates" onClick={onDrop}>
          <TaskIcon name="deprioritize" size={15} />Deprioritize</button>}
        <button type="button" aria-label="Close reschedule" title="Close reschedule" onClick={onClose}><TaskIcon name="close" size={16} /></button>
      </div>
      <div role="group" aria-label="Quick dates" className="tasks-presets">
        {shortcuts.map(({ label, icon, days }) => <button key={label} type="button" aria-label={label}
          title={days === null ? "No days left this week" : `${label} · ${dateLabel(shiftDate(today, days))}`}
          disabled={days === null} onClick={() => { if (days !== null) choose(shiftDate(today, days)); }}><TaskIcon name={icon} size={21} /></button>)}
      </div>
      <CalendarDays today={today} selected={task.plannedDate} onSelect={choose} />
      <div className="tasks-schedule-time">
        <label>Pacific time <input type="time" aria-label="Time (optional)" value={time} onChange={event => setTime(event.target.value)} /></label>
        {task.plannedDate && time !== (task.plannedTime ?? "") && <button type="button" onClick={() => choose(task.plannedDate!)}>Save time</button>}
      </div>
    </fieldset>
  </section>;
}
