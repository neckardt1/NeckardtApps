import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  access,
  addDays,
  byPriority,
  calendarBlocks,
  calendarEvents,
  changeFocus,
  complete,
  createTask,
  dayLabel,
  dayView,
  dropFocus,
  editTask,
  eligible,
  localDay,
  localStamp,
  lookup,
  occurrences,
  palette,
  people,
  seed,
  timeLabel,
} from "./model.mjs";
import { Brand, Icon } from "./icons.jsx";
import {
  Actions,
  Dot,
  EventList,
  IconButton,
  Modal,
  ProjectTag,
  ScheduleForm,
  TaskForm,
  TaskRow,
} from "./components.jsx";
import "./styles.css";

const storageKey = "kamax.sample-workspace.v1";
const stored = () => {
  const raw = localStorage.getItem(storageKey);
  if (!raw) return null;
  const value = JSON.parse(raw);
  return value.version === 1 && Array.isArray(value.tasks) && Array.isArray(value.projects) ? value : null;
};
function initialState() {
  try {
    const existing = stored();
    if (existing) return existing;
    const sample = seed(new Date());
    localStorage.setItem(storageKey, JSON.stringify(sample));
    return sample;
  } catch {
    return seed(new Date());
  }
}
function App() {
  const [state, setState] = useState(initialState),
    stateRef = useRef(state);
  const [who, setWho] = useState(() => {
    try {
      return sessionStorage.getItem("kamax.sample-profile") === "Stacey" ? "Stacey" : "Nick";
    } catch {
      return "Nick";
    }
  });
  const [view, setView] = useState("Today"),
    [projectId, setProjectId] = useState(""),
    [menu, setMenu] = useState(false);
  const [drawer, setDrawer] = useState(false),
    [doneOpen, setDoneOpen] = useState(false),
    [dialog, setDialog] = useState(null);
  const [clock, setClock] = useState(""),
    [tick, setTick] = useState(() => new Date()),
    [weekOffset, setWeekOffset] = useState(0);
  const [notice, setNotice] = useState(null),
    [diskError, setDiskError] = useState(false);
  const now = clock ? new Date(clock) : tick,
    stamp = localStamp(now),
    day = localDay(now);
  const projects = state.projects.filter((p) => access(p, who)),
    project = projects.find((p) => p.id === projectId);
  const actualView = view === "Project" && !project ? "Projects" : view;
  const daily = dayView(state, who, stamp),
    events = calendarEvents(who, day);
  const settings = state.settings[who],
    title = actualView === "Project" ? project.name : actualView;
  const selected = dialog?.key ? lookup(state, who, dialog.key) : null;
  const selectedFocus = selected && daily.focus.find((t) => t.key === selected.key);
  const personRef = useRef(who);
  personRef.current = who;
  const navRef = useRef(null),
    burgerRef = useRef(null);
  useEffect(() => {
    if (!menu) return;
    const sidebar = navRef.current;
    const buttons = () => [...sidebar.querySelectorAll("button")].filter((b) => b.offsetWidth > 0);
    buttons()[0]?.focus();
    function handleKey(e) {
      if (e.key === "Escape") {
        e.preventDefault();
        setMenu(false);
        return;
      }
      if (e.key !== "Tab") return;
      const items = buttons(),
        first = items[0],
        last = items.at(-1);
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      }
      if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
    const media = matchMedia("(max-width:720px)");
    const resized = () => {
      if (!media.matches) setMenu(false);
    };
    document.addEventListener("keydown", handleKey);
    media.addEventListener("change", resized);
    return () => {
      document.removeEventListener("keydown", handleKey);
      media.removeEventListener("change", resized);
      burgerRef.current?.querySelector("button")?.focus();
    };
  }, [menu]);
  const noticeRef = useRef(null);
  noticeRef.current = notice;
  useEffect(() => {
    const id = setInterval(() => setTick(new Date()), 20000);
    return () => clearInterval(id);
  }, []);
  useEffect(() => {
    document.title = title + " · Kamax";
  }, [title]);
  useEffect(() => {
    function sync(e) {
      if (e.key === storageKey) {
        try {
          const value = stored();
          if (value) {
            stateRef.current = value;
            setState(value);
            setNotice(null);
          }
        } catch {
          setDiskError(true);
        }
      }
    }
    window.addEventListener("storage", sync);
    return () => window.removeEventListener("storage", sync);
  }, []);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), 8500);
    return () => clearTimeout(timer);
  }, [notice]);
  useEffect(() => {
    if (dialog?.key && !selected) setDialog(null);
  }, [dialog, selected]);
  function go(next, id = "") {
    setView(next);
    setProjectId(id);
    setWeekOffset(0);
    setMenu(false);
    setDialog(null);
    window.scrollTo(0, 0);
  }
  function switchProfile(p) {
    personRef.current = p;
    setWho(p);
    try {
      sessionStorage.setItem("kamax.sample-profile", p);
    } catch {
      /* The sample still runs in memory. */
    }
    setDrawer(false);
    setDoneOpen(false);
    setNotice(null);
    go("Today");
  }
  // Re-read under the origin's write lock so separate sample tabs can collaborate safely.
  async function mutate(change, message, undoable = false) {
    const execute = () => {
      if (personRef.current !== who) return;
      let base = stateRef.current;
      try {
        if (!diskError) base = stored() || base;
      } catch {
        setDiskError(true);
      }
      const next = structuredClone(base);
      if (change(next) === false) {
        stateRef.current = base;
        setState(base);
        setDialog(null);
        setNotice({ text: "The task changed. Check its current details." });
        return;
      }
      next.rev = crypto.randomUUID();
      try {
        localStorage.setItem(storageKey, JSON.stringify(next));
        setDiskError(false);
      } catch {
        setDiskError(true);
      }
      stateRef.current = next;
      setState(next);
      setDialog(null);
      setNotice(message ? { text: message, ...(undoable ? { before: base, rev: next.rev } : {}) } : null);
    };
    if (navigator.locks) await navigator.locks.request(storageKey, execute);
    else execute();
  }
  const undo = () => {
    const n = noticeRef.current;
    if (n?.before)
      void mutate((s) => {
        if (s.rev !== n.rev) return false;
        Object.assign(s, n.before);
      }, "Completion undone");
  };
  function choose(item, replace = "") {
    if (item.done || (item.after && item.after > stamp)) {
      setNotice({ text: "This task is available after its show-after time." });
      return;
    }
    if (!replace && daily.focus.length === 3 && !daily.focus.some((t) => t.key === item.key)) {
      setDialog({ kind: "replace", key: item.key });
      return;
    }
    void mutate((s) => changeFocus(s, who, stamp, item.key, replace), "Chosen for today's focus");
  }
  function finish(item) {
    void mutate((s) => complete(s, who, stamp, item.key), "Completed “" + item.title + "”", true);
  }
  function saveSchedule(item, changes, original = item) {
    void mutate(
      (s) => editTask(s, who, stamp, item.key, changes, true, original),
      changes.planned ? "Planned for " + dayLabel(changes.planned) : "Schedule updated",
    );
  }
  const openItem = (kind, key) => setDialog({ kind, key });
  const addTask = (project = "") => setDialog({ kind: "new", project });
  const taskRows = (list, focus = false, showDeadline = false) =>
    list.map((item) => (
      <TaskRow
        key={item.key}
        item={item}
        day={day}
        focused={focus}
        showDeadline={showDeadline}
        project={projects.find((p) => p.id === item.project)}
        onOpen={() => openItem("detail", item.key)}
        onMenu={() => openItem("actions", item.key)}
        onComplete={() => finish(item)}
        onFocus={() => choose(item)}
        onPunt={() => openItem("schedule", item.key)}
      />
    ));
  const navButton = (name, icon, badge) => (
    <button
      className={"nav-item" + (actualView === name ? " selected" : "")}
      aria-current={actualView === name ? "page" : undefined}
      onClick={() => go(name)}
    >
      <Icon name={icon} size={19} />
      <span>{name}</span>
      {badge != null && <span className="nav-count">{badge}</span>}
    </button>
  );
  const dayEvents = [...events, ...(settings.blocks ? calendarBlocks(daily, events) : [])].sort((a, b) =>
    a.start.localeCompare(b.start),
  );
  const start = addDays(day, -((now.getDay() + 6) % 7) + weekOffset * 7),
    last = addDays(start, 6);
  const weekTasks = actualView === "This Week" ? occurrences(state, who, last) : [];
  const displayDialog = dialog && (!dialog.key || selected);
  return (
    <div className="app">
      <aside
        ref={navRef}
        role={menu ? "dialog" : undefined}
        aria-modal={menu || undefined}
        className={"sidebar" + (menu ? " open" : "")}
        aria-label="Workspace navigation"
      >
        <div className="brand-line">
          <Brand />
          <span className="mobile-close">
            <IconButton icon="close" label="Close navigation" onClick={() => setMenu(false)} />
          </span>
        </div>
        <nav aria-label="Planning">
          {navButton("Today", "today", daily.focus.length)}
          {navButton("This Week", "week")}
        </nav>
        <div className="side-projects">
          <div className="side-label">
            <button onClick={() => go("Projects")}>Projects</button>
            <IconButton
              icon="plus"
              label="New project"
              onClick={() => {
                setMenu(false);
                setDialog({ kind: "project-new" });
              }}
            />
          </div>
          <nav aria-label="Projects">
            {projects.map((p) => (
              <button
                key={p.id}
                className={"project-link" + (actualView === "Project" && p.id === projectId ? " active" : "")}
                onClick={() => go("Project", p.id)}
              >
                <Dot project={p} />
                <span>{p.name}</span>
                {p.shared && <Icon name="people" size={14} />}
              </button>
            ))}
          </nav>
        </div>
        <div className="side-bottom">
          {navButton("Preview lab", "sliders")}
          <button
            className="profile"
            onClick={() => {
              setMenu(false);
              setDialog({ kind: "profile" });
            }}
            aria-label={"Switch sample profile, current profile " + who}
          >
            <span aria-hidden="true" className={"avatar " + who.toLowerCase()}>
              {who[0]}
            </span>
            <span>
              <b>{who}</b>
              <small>Sample profile</small>
            </span>
            <Icon name="down" size={16} />
          </button>
        </div>
      </aside>
      {menu && (
        <button
          tabIndex={-1}
          className="scrim"
          aria-label="Dismiss navigation"
          onClick={() => setMenu(false)}
        />
      )}
      <main className="workspace" inert={menu || undefined}>
        <header className="topbar">
          <div className="crumb">
            <span ref={burgerRef} className="mobile-burger">
              <IconButton icon="menu" label="Open navigation" onClick={() => setMenu(true)} />
            </span>
            <Icon name="panel" size={17} />
            <span>Workspace</span>
            <span className="slash">/</span>
            <strong>{title}</strong>
          </div>
          <button className="sample-button" onClick={() => setDialog({ kind: "profile" })}>
            <span className="sample-light" />
            Sample workspace
          </button>
        </header>
        <div className="page-content">
          <div className="page-heading">
            <div>
              {actualView === "Today" && (
                <div className="date-line">
                  <Icon name="sun" size={16} />
                  {dayLabel(day, { weekday: "long", month: "long", day: "numeric" })}
                  {clock && " · Simulated time"}
                </div>
              )}
              <h1>{title}</h1>
              {actualView === "This Week" && (
                <p>
                  {dayLabel(start)} – {dayLabel(last, { month: "short", day: "numeric", year: "numeric" })}
                </p>
              )}
              {actualView === "Project" && (
                <p className="scope-label">
                  <Icon name={project.shared ? "people" : "lock"} size={15} />
                  {project.shared ? "Shared with the household" : "Private to " + project.owner}
                </p>
              )}
              {actualView === "Preview lab" && (
                <p>Try Muse and calendar ideas with this profile’s sample tasks.</p>
              )}
              {actualView === "Projects" && <p>Your private and household projects.</p>}
            </div>
            {["Today", "This Week", "Project"].includes(actualView) && (
              <button
                className="primary add-task"
                onClick={() => addTask(actualView === "Project" ? projectId : "")}
              >
                <Icon name="plus" size={16} />
                Add task
              </button>
            )}
          </div>

          {actualView === "Today" && (
            <>
              <section className="focus-card" aria-label="Today's focus">
                <div className="focus-head">
                  <div className="focus-symbol">
                    <Icon name="target" size={23} />
                  </div>
                  <div>
                    <h2>Today's focus</h2>
                    <p>Up to three tasks across your projects.</p>
                  </div>
                  <div className="slot-count" aria-label={daily.focus.length + " of 3 focus slots filled"}>
                    <div className="slot-bars">
                      {[0, 1, 2].map((i) => (
                        <i key={i} className={i < daily.focus.length ? "filled" : ""} />
                      ))}
                    </div>
                    <span>{daily.focus.length} of 3</span>
                  </div>
                </div>
                <div className="focus-rows">{taskRows(daily.focus, true)}</div>
                {daily.focus.length < 3 && (
                  <button
                    className="fill-slot"
                    onClick={() => {
                      setDrawer(true);
                      requestAnimationFrame(() => document.getElementById("more-tasks")?.focus());
                    }}
                  >
                    <Icon name="plus" size={16} />
                    {daily.focus.length ? "Choose another focus task" : "Choose a focus task"}
                  </button>
                )}
              </section>
              <section className="drawer-section">
                <button
                  id="more-tasks"
                  className="drawer-toggle"
                  aria-expanded={drawer}
                  aria-controls="drawer-list"
                  onClick={() => setDrawer(!drawer)}
                >
                  <span className="drawer-icon">
                    <Icon name="stack" size={22} />
                  </span>
                  <span>
                    <strong>
                      Everything else <em>{daily.drawer.length}</em>
                    </strong>
                    <small>Unselected tasks carry forward.</small>
                  </span>
                  <Icon name={drawer ? "down" : "right"} size={18} />
                </button>
                {drawer && (
                  <div id="drawer-list" className="drawer-list">
                    <p className="gesture-hint">
                      Swipe right to focus, left to reschedule, or use the task menu.
                    </p>
                    {daily.drawer.length ? (
                      taskRows(daily.drawer)
                    ) : (
                      <p className="empty">All caught up here.</p>
                    )}
                  </div>
                )}
              </section>
              {daily.revisit && (
                <div className="revisit">
                  <span className="revisit-icon">
                    <Icon name="revisit" size={19} />
                  </span>
                  <div>
                    <h3>Worth revisiting</h3>
                    <p>
                      {daily.revisit.title} <span>· Deferred {daily.revisit.history.length} times</span>
                    </p>
                  </div>
                  <button onClick={() => openItem("detail", daily.revisit.key)}>Review</button>
                </div>
              )}
              <section className="calendar-section">
                <div className="section-title">
                  <Icon name="week" size={18} />
                  <h2>On the calendar</h2>
                  <span className="small-label">Simulation</span>
                </div>
                <EventList events={dayEvents} />
              </section>
              {daily.completed.length > 0 && (
                <section className="done-section">
                  <button
                    className="disclose"
                    aria-expanded={doneOpen}
                    onClick={() => setDoneOpen(!doneOpen)}
                  >
                    <Icon name={doneOpen ? "down" : "right"} size={15} />
                    Completed today ({daily.completed.length})
                  </button>
                  {doneOpen && taskRows(daily.completed)}
                </section>
              )}
            </>
          )}
          {actualView === "This Week" && (
            <>
              <div className="week-controls">
                <button className="secondary" onClick={() => setWeekOffset(0)}>
                  Current week
                </button>
                <IconButton icon="left" label="Previous week" onClick={() => setWeekOffset(weekOffset - 1)} />
                <IconButton icon="right" label="Next week" onClick={() => setWeekOffset(weekOffset + 1)} />
              </div>
              {Array.from({ length: 7 }, (_, i) => addDays(start, i)).map((d) => {
                const list = weekTasks
                  .filter((t) => !t.done && (t.planned === d || (!t.planned && t.deadline === d)))
                  .sort((a, b) => (a.time || "99").localeCompare(b.time || "99") || byPriority(a, b));
                const ev = calendarEvents(who, d),
                  bs = settings.blocks && d === day ? calendarBlocks(daily, ev) : [];
                return (
                  <section className={"week-day" + (d === day ? " current" : "")} key={d}>
                    <h2>
                      {dayLabel(d, { weekday: "long", month: "short", day: "numeric" })}
                      {d === day && <span>Today</span>}
                    </h2>
                    {taskRows(list, false, true)}
                    <EventList events={[...ev, ...bs].sort((a, b) => a.start.localeCompare(b.start))} />
                  </section>
                );
              })}
              <details className="week-loose">
                <summary>Unscheduled &amp; earlier tasks</summary>
                {taskRows(
                  weekTasks
                    .filter(
                      (t) =>
                        !t.done &&
                        (t.planned
                          ? t.planned < start
                          : !t.deadline || t.deadline < start || t.deadline > last),
                    )
                    .sort(byPriority),
                  false,
                  true,
                )}
              </details>
            </>
          )}
          {actualView === "Projects" && (
            <div className="project-grid">
              {projects.map((p) => (
                <button key={p.id} onClick={() => go("Project", p.id)}>
                  <Dot project={p} />
                  <b>{p.name}</b>
                  <small>{p.shared ? "Household" : "Private"}</small>
                  <Icon name="right" size={16} />
                </button>
              ))}
              <button onClick={() => setDialog({ kind: "project-new" })}>
                <Icon name="plus" />
                New project
              </button>
            </div>
          )}
          {actualView === "Project" && (
            <>
              {project.owner === who && (
                <button
                  className="secondary sharing"
                  onClick={() => setDialog({ kind: "sharing", project: project.id })}
                >
                  <Icon name="people" size={16} />
                  Manage sharing
                </button>
              )}
              <div className="project-tasks">
                {(() => {
                  const items = occurrences(state, who, addDays(day, 7), day)
                    .filter((t) => t.project === projectId && !t.done)
                    .sort(
                      (a, b) => (a.planned || "9999").localeCompare(b.planned || "9999") || byPriority(a, b),
                    );
                  return items.length ? (
                    items.map((t) => (
                      <div key={t.key} className="project-occurrence">
                        <p>
                          {t.planned
                            ? dayLabel(t.planned, { weekday: "short", month: "short", day: "numeric" })
                            : "Unscheduled"}
                          {t.after
                            ? " · Shows " +
                              dayLabel(t.after.slice(0, 10)) +
                              " at " +
                              timeLabel(t.after.slice(11))
                            : ""}
                          {t.deadline ? " · Deadline " + dayLabel(t.deadline) : ""}
                        </p>
                        {taskRows([t])}
                      </div>
                    ))
                  ) : (
                    <p className="empty">This project has no open tasks.</p>
                  );
                })()}
              </div>
            </>
          )}
          {actualView === "Preview lab" && (
            <Lab
              {...{ who, daily, settings, events, stamp, clock }}
              onClock={(value) => {
                setClock(value);
                setTick(new Date());
                setNotice({ text: value ? "Preview clock updated" : "Using the device clock" });
              }}
              onSettings={(updates) =>
                void mutate((s) => Object.assign(s.settings[who], updates), "Preview preference saved")
              }
              onDone={finish}
              onTomorrow={(t) => saveSchedule(t, { planned: addDays(day, 1) })}
            />
          )}
          {diskError && (
            <p role="status" className="disk-warning">
              Browser storage is unavailable. This session keeps changes in memory.
            </p>
          )}
        </div>
      </main>
      {displayDialog && (
        <Modal
          key={dialog.kind + "-" + (dialog.key || "")}
          title={
            {
              new: "New task",
              detail: "Task details",
              actions: "Task actions",
              schedule: "Reschedule",
              replace: "Make room in focus",
              profile: "Sample profiles",
              "project-new": "New project",
              sharing: "Project sharing",
            }[dialog.kind]
          }
          small={!["new", "detail"].includes(dialog.kind)}
          onClose={() => setDialog(null)}
        >
          {dialog.kind === "profile" && (
            <div className="action-list">
              <p className="modal-subtitle">
                Two sample profiles share this browser. Private projects appear only in their owner’s view.
              </p>
              {people.map((p) => (
                <button key={p} onClick={() => switchProfile(p)}>
                  <span aria-hidden="true" className={"avatar " + p.toLowerCase()}>
                    {p[0]}
                  </span>
                  {p}
                  {who === p && <Icon name="check" />}
                </button>
              ))}
            </div>
          )}
          {dialog.kind === "replace" && (
            <div className="action-list">
              <p className="modal-subtitle">
                Choose a task to return to the drawer so “{selected.title}” can take its place.
              </p>
              {daily.focus.map((t) => (
                <button key={t.key} onClick={() => choose(selected, t.key)}>
                  <Icon name="stack" />
                  {t.title}
                </button>
              ))}
            </div>
          )}
          {dialog.kind === "actions" && (
            <Actions
              item={{ ...selected, chosen: selectedFocus?.chosen }}
              isFocus={!!selectedFocus}
              stamp={stamp}
              onFocus={() => choose(selected)}
              onDrop={() =>
                void mutate((s) => dropFocus(s, who, stamp, selected.key), "Returned to the drawer")
              }
              onPunt={() => openItem("schedule", selected.key)}
              onOpen={() => openItem("detail", selected.key)}
            />
          )}
          {dialog.kind === "schedule" && (
            <ScheduleForm
              item={selected}
              now={now}
              onSave={(changes, original) => saveSchedule(selected, changes, original)}
            />
          )}
          {(dialog.kind === "new" || dialog.kind === "detail") &&
            (selected?.done ? (
              <div className="completed-detail">
                <h3>{selected.title}</h3>
                <ProjectTag project={projects.find((p) => p.id === selected.project)} />
                <p>
                  Completed {dayLabel(selected.done.slice(0, 10))} at {timeLabel(selected.done.slice(11))}.
                </p>
                {selected.notes && <p>{selected.notes}</p>}
              </div>
            ) : (
              <TaskForm
                item={selected}
                template={selected && state.tasks.find((t) => t.id === selected.id)}
                projects={projects}
                activeProject={dialog.project}
                onCancel={() => setDialog(null)}
                onSave={(data, original) =>
                  void mutate(
                    (s) => {
                      if (selected) {
                        return editTask(s, who, stamp, selected.key, data, false, original);
                      }
                      if (
                        !access(
                          s.projects.find((p) => p.id === data.project),
                          who,
                        )
                      )
                        return false;
                      s.tasks.push(createTask(data, day));
                      return true;
                    },
                    selected ? "Task updated" : "Task added",
                  )
                }
              >
                {selected && (
                  <div className="detail-actions">
                    {(!selected.after || selected.after <= stamp) && !selectedFocus?.chosen && (
                      <button type="button" className="secondary" onClick={() => choose(selected)}>
                        <Icon name="target" size={15} />
                        Focus today
                      </button>
                    )}
                    <button
                      type="button"
                      className="secondary"
                      onClick={() => openItem("schedule", selected.key)}
                    >
                      <Icon name="today" size={15} />
                      Reschedule
                    </button>
                  </div>
                )}
              </TaskForm>
            ))}
          {dialog.kind === "project-new" && (
            <ProjectForm
              who={who}
              onSave={(name, shared) => {
                const id = crypto.randomUUID();
                void mutate((s) => {
                  s.projects.push({
                    id,
                    name,
                    owner: who,
                    shared,
                    color: palette[s.projects.length % palette.length],
                  });
                }, "Project created").then(() => go("Project", id));
              }}
            />
          )}
          {dialog.kind === "sharing" && project && (
            <div className="sharing-form">
              <p>
                {project.shared
                  ? "Both sample profiles can see and edit every task in this project."
                  : "Only " +
                    who +
                    " sees this project. Sharing it will make every task visible and editable for both sample profiles."}
              </p>
              <button
                className="primary"
                onClick={() =>
                  void mutate((s) => {
                    const p = s.projects.find((p) => p.id === projectId);
                    if (!p || p.owner !== who) return false;
                    p.shared = !project.shared;
                  }, "Project sharing updated")
                }
              >
                {project.shared ? "Make private" : "Share with household"}
              </button>
            </div>
          )}
        </Modal>
      )}
      {notice && (
        <div className="toast" role="status">
          <Icon name="check" size={17} />
          <span>{notice.text}</span>
          {notice.before && <button onClick={undo}>Undo</button>}
          <IconButton icon="close" label="Dismiss message" onClick={() => setNotice(null)} />
        </div>
      )}
    </div>
  );
}

function ProjectForm({ who, onSave }) {
  const [name, setName] = useState(""),
    [shared, setShared] = useState(false);
  return (
    <form
      className="task-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (name.trim()) onSave(name.trim(), shared);
      }}
    >
      <label>
        Project name
        <input autoFocus required maxLength={70} value={name} onChange={(e) => setName(e.target.value)} />
      </label>
      <label>
        Visibility
        <select
          aria-label="Visibility"
          value={shared ? "shared" : "private"}
          onChange={(e) => setShared(e.target.value === "shared")}
        >
          <option value="private">Private to {who}</option>
          <option value="shared">Shared with household</option>
        </select>
      </label>
      <div className="form-actions">
        <button className="primary">Create project</button>
      </div>
    </form>
  );
}
function Lab({ who, daily, settings, events, stamp, clock, onClock, onSettings, onDone, onTomorrow }) {
  const [when, setWhen] = useState(clock || stamp),
    [showMuse, setShowMuse] = useState(false),
    [showEnd, setShowEnd] = useState(false);
  const nudges = [...daily.focus, ...daily.drawer].sort(byPriority).slice(0, 3);
  return (
    <div className="lab">
      <p className="lab-note">
        <Icon name="lock" size={16} />
        Sample data stays in this browser. All previews run here.
      </p>
      <section>
        <div className="section-title">
          <Icon name="spark" />
          <h2>Muse nudges</h2>
        </div>
        <p>Preview up to three available tasks for {who}, ordered by priority.</p>
        <label>
          Nudge frequency
          <select
            aria-label="Nudge frequency"
            value={settings.nudges}
            onChange={(e) => {
              setShowMuse(false);
              onSettings({ nudges: Number(e.target.value) });
            }}
          >
            <option value={0}>Off</option>
            <option value={1}>Once a day · morning</option>
            <option value={2}>Twice a day · morning and midday</option>
          </select>
        </label>
        <button className="secondary" disabled={!settings.nudges} onClick={() => setShowMuse(!showMuse)}>
          {showMuse ? "Hide nudges" : "Preview nudges"}
        </button>
        {showMuse && settings.nudges > 0 && (
          <div className="lab-result">
            {["Morning", ...(settings.nudges === 2 ? ["Midday"] : [])].map((period) => (
              <div key={period}>
                <h3>{period} nudge</h3>
                {nudges.length ? (
                  <ol>
                    {nudges.map((t) => (
                      <li key={t.key}>
                        {t.title} <small>· {t.priority}</small>
                      </li>
                    ))}
                  </ol>
                ) : (
                  <p>No available tasks.</p>
                )}
              </div>
            ))}
          </div>
        )}
      </section>
      <section>
        <div className="section-title">
          <Icon name="sunset" />
          <h2>End-of-day check-in</h2>
        </div>
        <p>Review tasks you explicitly chose for today.</p>
        <button className="secondary" onClick={() => setShowEnd(!showEnd)}>
          {showEnd ? "Hide check-in" : "Preview check-in"}
        </button>
        {showEnd && (
          <div className="lab-result">
            {daily.checkIn.length ? (
              daily.checkIn.map((t) => (
                <div className="checkin-item" key={t.key}>
                  <b>{t.title}</b>
                  {t.done ? (
                    <small>Completed</small>
                  ) : !eligible(t, stamp) ? (
                    <small>Rescheduled or gated</small>
                  ) : (
                    <span>
                      <button className="text-button" onClick={() => onDone(t)}>
                        Complete
                      </button>
                      <button className="text-button" onClick={() => onTomorrow(t)}>
                        Remind me tomorrow
                      </button>
                    </span>
                  )}
                </div>
              ))
            ) : (
              <p>No tasks explicitly chosen today.</p>
            )}
          </div>
        )}
      </section>
      <section>
        <div className="section-title">
          <Icon name="week" />
          <h2>Calendar blocks</h2>
        </div>
        <p>Place 30-minute blocks for high-priority tasks around sample events.</p>
        <label className="switch-label">
          <input
            type="checkbox"
            checked={settings.blocks}
            onChange={(e) => onSettings({ blocks: e.target.checked })}
          />
          Show simulated focus blocks
        </label>
        {settings.blocks && (
          <EventList
            events={[...events, ...calendarBlocks(daily, events)].sort((a, b) =>
              a.start.localeCompare(b.start),
            )}
          />
        )}
      </section>
      <section>
        <div className="section-title">
          <Icon name="clock" />
          <h2>Preview clock</h2>
        </div>
        <p>Move the sample day forward to try carry-forward, recurrence and show-after times.</p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            onClock(when);
          }}
        >
          <label>
            Local date and time
            <input type="datetime-local" required value={when} onChange={(e) => setWhen(e.target.value)} />
          </label>
          <button className="secondary">Set preview time</button>
          {clock && (
            <button
              type="button"
              className="text-button"
              onClick={() => {
                onClock("");
                setWhen(localStamp(new Date()));
              }}
            >
              Use device time
            </button>
          )}
        </form>
      </section>
    </div>
  );
}
createRoot(document.getElementById("root")).render(<App />);
