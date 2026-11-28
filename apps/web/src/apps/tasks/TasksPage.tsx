import { useCallback, useEffect, useRef, useState } from "react";
import type { Task, TaskList, TaskSnapshot, TasksAdapter } from "./contract";
import { taskTimeZone } from "./contract";
import { gateOpen, pacificDate, todaySections, weekTasks } from "./model";
import { TaskCalendar, dateLabel } from "./TaskCalendar";
import { TaskEditor, TasksDialog, listName, type FormDraft, type SaveResult } from "./TaskEditor";
import { TaskRow } from "./TaskRow";
import { TaskIcon } from "./icons";
import "./tasks.css";

type Panel = { kind: "create"; listId: string; requestId: string } | { kind: "edit"; task: Task }
  | { kind: "date"; task: Task; keyboard: boolean };
type Notice = { text: string; error?: boolean };
const weekday = new Intl.DateTimeFormat("en-US", { weekday: "long", timeZone: taskTimeZone });

function Navigation({ lists, view, choose }: { lists: TaskList[]; view: string; choose: (view: string) => void }) {
  const item = (id: string, label: string, icon: "today" | "week" | "private" | "household") =>
    <button type="button" key={id} aria-current={view === id ? "page" : undefined} onClick={() => choose(id)}><TaskIcon name={icon} />{label}</button>;
  return <nav aria-label="Task views" className="tasks-navigation">
    {item("today", "Today", "today")}{item("week", "This Week", "week")}
    {lists.length > 0 && <><h3>Lists</h3>{lists.map(list => item(list.id, listName(list), list.kind))}</>}
  </nav>;
}

export function TasksPage({ adapter, isCurrent }: { adapter: TasksAdapter; isCurrent: () => boolean }) {
  const [snapshot, setSnapshot] = useState<TaskSnapshot | null>(null);
  const [view, setView] = useState("today");
  const [navOpen, setNavOpen] = useState(false);
  const [panel, setPanel] = useState<Panel | null>(null);
  const [conflict, setConflict] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [writing, setWriting] = useState(false);
  const [loading, setLoading] = useState(true);
  const [now, setNow] = useState(() => new Date());
  const mounted = useRef(false);
  const readNumber = useRef(0);
  const writeLock = useRef(false);

  const read = useCallback(async () => {
    if (!mounted.current || !isCurrent()) return false;
    const request = ++readNumber.current;
    const current = () => mounted.current && isCurrent() && request === readNumber.current;
    setLoading(true);
    try {
      const result = await adapter.read();
      if (!current()) return false;
      setSnapshot(result);
      setNow(new Date());
      return true;
    } catch {
      if (current()) {
        setSnapshot(null);
        setPanel(null);
        setNotice({ text: "Couldn’t load Tasks. Use Refresh to try again.", error: true });
      }
      return false;
    } finally { if (current()) setLoading(false); }
  }, [adapter, isCurrent]);
  useEffect(() => {
    mounted.current = true;
    void read();
    return () => { mounted.current = false; readNumber.current++; };
  }, [read]);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    function tick() {
      clearTimeout(timer);
      setNow(new Date());
      timer = setTimeout(tick, 60_000 - Date.now() % 60_000 + 5);
    }
    tick();
    document.addEventListener("visibilitychange", tick);
    return () => { clearTimeout(timer); document.removeEventListener("visibilitychange", tick); };
  }, []);

  function close() {
    setPanel(null);
    setConflict(false);
    setNotice(null);
  }
  function chooseView(selected: string) {
    setView(selected);
    setNavOpen(false);
    close();
    window.scrollTo({ top: 0, behavior: "instant" });
  }

  async function write(action: () => Promise<unknown>, success: string): Promise<SaveResult> {
    if (!mounted.current || !isCurrent() || writeLock.current || loading) return "failed";
    writeLock.current = true;
    setWriting(true);
    setNotice(null);
    try {
      await action();
      if (!mounted.current || !isCurrent()) return "failed";
      close();
      if (await read()) setNotice({ text: success });
      return "saved";
    } catch (cause) {
      if (!mounted.current || !isCurrent()) return "failed";
      const error = cause instanceof Error ? cause : Error("Couldn’t confirm this change. Try again.");
      if (error.name === "TaskConflictError") {
        setConflict(panel?.kind === "edit");
        if (panel?.kind !== "edit") setPanel(null);
        setNotice({ text: error.message, error: true });
        await read();
        return "conflict";
      }
      setNotice({ text: error.message, error: true });
      return error.name === "TaskValidationError" ? "invalid" : "failed";
    } finally {
      writeLock.current = false;
      if (mounted.current && isCurrent()) setWriting(false);
    }
  }

  const lists = snapshot?.lists ?? [];
  const currentList = lists.find(list => list.id === view);
  const title = currentList ? listName(currentList) : view === "week" ? "This Week" : "Today";
  const day = pacificDate(now);
  const { focus, everythingElse } = snapshot ? todaySections(snapshot, now) : { focus: [], everythingElse: [] };
  const focusIds = new Set(focus.map(task => task.id));
  const busy = writing || loading;
  const editor = panel?.kind === "create" || panel?.kind === "edit" ? panel : null;

  function create() {
    const list = currentList ?? lists.find(list => list.kind === "private") ?? lists[0];
    if (busy || !list) return;
    close();
    setPanel({ kind: "create", listId: list.id, requestId: crypto.randomUUID() });
  }
  function edit(task: Task) {
    close();
    setPanel({ kind: "edit", task });
  }
  function save(draft: FormDraft): Promise<SaveResult> {
    if (editor?.kind === "create") return write(() => adapter.create(draft.listId, editor.requestId, draft.fields), "Task added.");
    if (editor?.kind === "edit") return write(() => adapter.edit(editor.task, draft.fields), "Task saved.");
    return Promise.resolve("failed");
  }
  function promote(task: Task) {
    if (!gateOpen(task, new Date())) {
      setNotice({ text: "The Show after time has not arrived.", error: true });
      return;
    }
    void write(() => adapter.promote(task), "Moved to the top of your Focus.");
  }
  function drop(task: Task) { void write(() => adapter.deprioritize(task), "Moved to Everything Else."); }
  function rows(tasks: Task[]) {
    return <ul className="tasks-rows">{tasks.map(task => {
      const list = lists.find(item => item.id === task.listId)!;
      const inFocus = focusIds.has(task.id);
      const datePanel = panel?.kind === "date" && panel.task.id === task.id ? panel : null;
      return <li key={task.id} aria-label={task.title}>
        <TaskRow {...{ task, list, today: day, inFocus, busy }} gated={!gateOpen(task, now)} expanded={!!datePanel}
          onEdit={() => edit(task)} onSchedule={keyboard => {
            setNotice(null);
            setPanel(datePanel ? null : { kind: "date", task, keyboard });
          }}
          onPromote={() => promote(task)} onDrop={() => drop(task)}
          onComplete={() => { void write(() => adapter.complete(task), "Task completed."); }} />
        {datePanel && <TaskCalendar task={datePanel.task} today={day} inFocus={inFocus} busy={busy} focusOnOpen={datePanel.keyboard}
          onClose={close} onDrop={() => drop(task)} onChoose={(date, time) => {
            void write(() => adapter.reschedule(datePanel.task, date, time), "Planned date saved.");
          }} />}
      </li>;
    })}</ul>;
  }
  function section(label: string, tasks: Task[], empty: string) {
    return <section className="tasks-section" key={label} aria-label={label}><h2>{label}</h2>
      {tasks.length ? rows(tasks) : <p className="tasks-empty">{empty}</p>}
    </section>;
  }
  const week = new Map<string, Task[]>();
  if (snapshot && view === "week") {
    for (const task of weekTasks(snapshot, now)) {
      const day = (task.plannedDate ?? task.deadlineDate)!;
      const group = week.get(day) ?? [];
      group.push(task);
      week.set(day, group);
    }
  }
  const edited = editor?.kind === "edit" ? editor.task : undefined;
  const focusAction = !edited || !gateOpen(edited, now) ? undefined : focusIds.has(edited.id)
    ? { label: "Deprioritize", run: () => drop(edited) } : { label: "Prioritize", run: () => promote(edited) };
  return <div className="tasks-app">
    <aside className="tasks-sidebar"><div className="tasks-brand"><TaskIcon name="tasks" size={22} />Tasks</div>
      <Navigation lists={lists} view={view} choose={chooseView} /></aside>
    <div className="tasks-page">
      <header className="tasks-heading">
        <h1>{title}</h1>
        {view === "today" && <time dateTime={day}>{dateLabel(day)}<span className="tasks-heading-weekday"> · {weekday.format(now)}</span></time>}
        <div className="tasks-heading-actions">
          <button type="button" className="tasks-icon-button tasks-mobile-nav" aria-haspopup="dialog" aria-expanded={navOpen}
            onClick={() => setNavOpen(true)}><TaskIcon name="menu" />Task views</button>
          <button type="button" className="tasks-icon-button" aria-label="Refresh" title="Refresh" disabled={busy}
            onClick={() => { setNotice(null); void read(); }}><TaskIcon name="refresh" size={17} /></button>
          {lists.length > 0 && <button type="button" className="tasks-add" aria-label="Add task" title="Add task" disabled={busy} onClick={create}>
            <TaskIcon name="add" /><span>Add task</span></button>}
        </div>
      </header>
      {notice && !editor && <p role={notice.error ? "alert" : "status"} className={notice.error ? "tasks-error" : "tasks-notice"}>{notice.text}</p>}
      {!snapshot ? loading && <p className="tasks-empty" role="status">Loading tasks…</p>
        : !lists.length ? <p className="tasks-empty">Tasks isn’t enabled for this account.</p>
        : currentList ? rows(snapshot.tasks.filter(task => task.listId === currentList.id))
        : view === "week" ? week.size ? [...week].map(([date, tasks]) => section(dateLabel(date), tasks, ""))
          : <p className="tasks-empty">No tasks planned for this week.</p>
        : <>{section("Focus", focus, "Prioritize a task to bring it here.")}{section("Everything Else", everythingElse, "All caught up here.")}</>}
      {currentList && !snapshot?.tasks.some(task => task.listId === currentList.id) && <p className="tasks-empty">No tasks in this list.</p>}
    </div>
    {navOpen && <TasksDialog title="Tasks" drawer onClose={() => setNavOpen(false)}>
      <Navigation lists={lists} view={view} choose={chooseView} /></TasksDialog>}
    {editor && <TaskEditor key={editor.kind === "create" ? editor.requestId : editor.task.id + "/" + editor.task.version}
      task={edited} listId={editor.kind === "create" ? editor.listId : editor.task.listId} lists={lists}
      busy={writing || (conflict && loading)} error={notice?.error ? notice.text : null} conflict={conflict}
      latest={snapshot?.tasks.find(task => task.id === edited?.id)} focusAction={focusAction}
      onClose={close} onSave={save} onLoadLatest={edit} />}
  </div>;
}
