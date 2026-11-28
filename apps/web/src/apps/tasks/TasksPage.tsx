import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { useLocation } from "react-router";
import type { CompletedTask, Task, TaskList, TaskSnapshot, TasksAdapter } from "./contract";
import { taskTimeZone } from "./contract";
import { useAppHomeBusy, useAppView } from "../../shell/app-navigation";
import { gateOpen, inboxTasks, pacificDate, todaySections, upcomingSections } from "./model";
import { TaskCalendar, dateLabel } from "./TaskCalendar";
import { TaskEditor, TasksDialog, listName, type FormDraft, type SaveResult } from "./TaskEditor";
import { CompletedTasks, TaskHistory } from "./TaskActivity";
import { TaskToast, type UndoToast } from "./TaskToast";
import { TaskRow } from "./TaskRow";
import { TaskIcon } from "./icons";
import "./tasks.css";

type Panel = { kind: "create"; listId: string; requestId: string } | { kind: "edit"; task: Task }
  | { kind: "history"; task: CompletedTask } | { kind: "date"; task: Task; keyboard: boolean };
type Notice = { text: string; error?: boolean };
const weekday = new Intl.DateTimeFormat("en-US", { weekday: "long", timeZone: taskTimeZone });
const agendaDate = new Intl.DateTimeFormat("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
const views = [
  { id: "inbox", label: "Inbox", icon: "inbox" },
  { id: "today", label: "Today", icon: "today" },
  { id: "upcoming", label: "Upcoming", icon: "week" },
  { id: "browse", label: "Browse", icon: "browse" },
] as const;

function ViewButtons({ active, choose }: { active: string; choose: (view: string) => void }) {
  return views.map(({ id, label, icon }) => <button type="button" key={id}
    aria-current={active === id ? "page" : undefined} onClick={() => choose(id)}><TaskIcon name={icon} />{label}</button>);
}

function ListButtons({ lists, view, choose }: { lists: TaskList[]; view: string; choose: (view: string) => void }) {
  return lists.map(list => <button type="button" key={list.id} aria-current={view === list.id ? "page" : undefined}
    onClick={() => choose(list.id)}><TaskIcon name={list.kind} />{listName(list)}</button>);
}

export type TaskLayout = {
  renderHome?: (focusRows: ReactNode) => ReactNode;
  footer?: (busy: boolean) => ReactNode;
};

export function TasksPage({ adapter, isCurrent, renderHome, footer }: TaskLayout & { adapter: TasksAdapter; isCurrent: () => boolean }) {
  const [snapshot, setSnapshot] = useState<TaskSnapshot | null>(null);
  const [view, chooseView] = useAppView("today");
  const { key: entry } = useLocation();
  const previousEntry = useRef(entry);
  const [panel, setPanel] = useState<Panel | null>(null);
  const [conflict, setConflict] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [toast, setToast] = useState<UndoToast | null>(null);
  const dismissToast = useCallback(() => setToast(null), []);
  const [writing, setWriting] = useState(false);
  useAppHomeBusy(writing);
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
  const atHome = !!renderHome;
  useEffect(() => {
    if (!atHome || panel) return;
    const refresh = () => {
      if (!document.hidden && !writeLock.current) { setNotice(null); void read(); }
    };
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [atHome, panel, read]);
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
  useLayoutEffect(() => {
    if (entry === previousEntry.current) return;
    previousEntry.current = entry;
    if (writeLock.current || panel?.kind === "create" || panel?.kind === "edit") return;
    close();
    window.scrollTo({ top: 0, behavior: "instant" });
  }, [entry, panel]);

  async function write(action: () => Promise<string | null | void>, success: string, undoEvent?: string): Promise<SaveResult> {
    if (!mounted.current || !isCurrent() || writeLock.current || loading) return "failed";
    writeLock.current = true;
    setWriting(true);
    setNotice(null);
    try {
      const eventId = await action();
      if (!mounted.current || !isCurrent()) return "failed";
      close();
      setToast(eventId ? { text: success, eventId } : null);
      setNotice({ text: success });
      await read();
      return "saved";
    } catch (cause) {
      if (!mounted.current || !isCurrent()) return "failed";
      const error = cause instanceof Error ? cause : Error("Couldn’t confirm this change. Try again.");
      if (undoEvent) {
        setToast({ text: error.message, eventId: error.name === "TaskRequestError" ? undoEvent : undefined });
        setNotice({ text: error.message });
        if (error.name === "TaskConflictError") await read();
        return "failed";
      }
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
  const title = currentList ? listName(currentList) : view === "completed" ? "Completed" : views.find(item => item.id === view)?.label ?? "Today";
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
    if (editor?.kind === "create") return write(async () => { await adapter.create(draft.listId, editor.requestId, draft.fields); }, "Task added.");
    if (editor?.kind === "edit") return write(() => adapter.edit(editor.task, draft.fields), "Task saved.");
    return Promise.resolve("failed");
  }
  function promote(task: Task) {
    if (!gateOpen(task, new Date())) {
      setNotice({ text: "The Show after time has not arrived.", error: true });
      return;
    }
    void write(() => adapter.promote(task), `Moved “${task.title}” to the top of Focus.`);
  }
  function drop(task: Task) { void write(() => adapter.deprioritize(task), `Deprioritized “${task.title}”.`); }
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
          onComplete={() => { void write(() => adapter.complete(task), `Completed “${task.title}”.`); }} />
        {datePanel && <TaskCalendar task={datePanel.task} today={day} inFocus={inFocus} busy={busy} focusOnOpen={datePanel.keyboard}
          onClose={close} onDrop={() => drop(task)} onChoose={(date, time) => {
            void write(() => adapter.reschedule(datePanel.task, date, time), `Rescheduled “${task.title}”.`);
          }} />}
      </li>;
    })}</ul>;
  }
  function section(label: string, tasks: Task[], empty = "") {
    return <section className="tasks-section" key={label} aria-label={label}><h2>{label}</h2>
      {tasks.length ? rows(tasks) : <p className="tasks-empty">{empty}</p>}
    </section>;
  }
  const completedLink = <button type="button" aria-current={view === "completed" ? "page" : undefined}
    onClick={() => chooseView("completed")}><TaskIcon name="check" />Completed</button>;
  function viewContent() {
    if (!snapshot) return loading && <p className="tasks-empty" role="status">Loading tasks…</p>;
    if (!lists.length) return <p className="tasks-empty">Tasks isn’t enabled for this account.</p>;
    if (view === "completed") return !loading && <CompletedTasks adapter={adapter} lists={lists}
      open={task => setPanel({ kind: "history", task })} />;
    if (view === "browse") return <>
      <nav aria-label="Task lists" className="tasks-navigation tasks-directory">
        <h2>Lists</h2><ListButtons lists={lists} view={view} choose={chooseView} />
      </nav>
      <div className="tasks-navigation tasks-completed-link">{completedLink}</div>
    </>;
    if (view === "inbox") {
      const tasks = inboxTasks(snapshot, now);
      return <><p className="tasks-empty">{tasks.length ? "Unscheduled tasks from your Private list." : "No unscheduled tasks in your Private list."}</p>
        {tasks.length > 0 && rows(tasks)}</>;
    }
    if (currentList) {
      const tasks = snapshot.tasks.filter(task => task.listId === currentList.id);
      return tasks.length ? rows(tasks) : <p className="tasks-empty">No tasks in this list.</p>;
    }
    if (view === "upcoming") {
      const upcoming = upcomingSections(snapshot, now);
      return upcoming.length ? upcoming.map(({ date, tasks }) => section(agendaDate.format(new Date(date + "T12:00:00Z")), tasks))
        : <p className="tasks-empty">No upcoming tasks.</p>;
    }
    return <>{section("Focus", focus, "Prioritize a task to bring it here.")}{section("Everything Else", everythingElse, "All caught up here.")}</>;
  }
  const edited = editor?.kind === "edit" ? editor.task : undefined;
  const focusAction = !edited || !gateOpen(edited, now) ? undefined : focusIds.has(edited.id)
    ? { label: "Deprioritize", run: () => drop(edited) } : { label: "Prioritize", run: () => promote(edited) };
  const dialog = editor && <TaskEditor key={editor.kind === "create" ? editor.requestId : editor.task.id + "/" + editor.task.version}
    task={edited} listId={editor.kind === "create" ? editor.listId : editor.task.listId} lists={lists}
    busy={writing || (conflict && loading)} error={notice?.error ? notice.text : null} conflict={conflict}
    latest={snapshot?.tasks.find(task => task.id === edited?.id)} focusAction={focusAction}
    history={edited && <TaskHistory adapter={adapter} taskId={edited.id} />}
    onClose={close} onSave={save} onLoadLatest={edit} />;
  const feedback = <>
    {toast && <TaskToast key={toast.eventId ?? toast.text} toast={toast} busy={busy} dismiss={dismissToast}
      undo={() => { const id = toast.eventId; if (id) void write(() => adapter.undo(id), "Change undone.", id); }} />}
    <div role="status" className="visually-hidden">{notice && !notice.error ? notice.text + (toast?.eventId ? " Undo available." : "") : ""}</div>
    {notice?.error && !editor && <p role="alert" className="tasks-error">{notice.text}</p>}
  </>;
  if (renderHome) {
    const content = !snapshot ? loading ? <p role="status">Loading tasks…</p>
      : <button className="home-link-action" onClick={() => { setNotice(null); void read(); }}>Refresh</button>
      : focus.length ? rows(focus.slice(0, 3)) : null;
    return <div className="tasks-app home-focus">{renderHome(content)}{feedback}{dialog}</div>;
  }
  return <div className="tasks-app">
    <aside className="tasks-sidebar"><div className="tasks-brand"><TaskIcon name="tasks" size={22} />Tasks</div>
      <nav aria-label="Task views" className="tasks-navigation"><ViewButtons active={view} choose={chooseView} />
        {lists.length > 0 && <>{completedLink}<h3>Lists</h3><ListButtons lists={lists} view={view} choose={chooseView} /></>}
      </nav></aside>
    <div className="tasks-page">
      <header className="tasks-heading">
        <h1>{title}</h1>
        {view === "today" && <time dateTime={day}>{dateLabel(day)}<span className="tasks-heading-weekday"> · {weekday.format(now)}</span></time>}
        <button type="button" className="tasks-icon-button tasks-refresh" aria-label="Refresh" title="Refresh" disabled={busy}
          onClick={() => { setNotice(null); void read(); }}><TaskIcon name="refresh" size={17} /></button>
        <div className="tasks-heading-actions">
          <nav aria-label="Task views" className="tasks-mobile-tabs"><ViewButtons active={currentList || view === "completed" ? "browse" : view} choose={chooseView} /></nav>
          {lists.length > 0 && <button type="button" className="tasks-add" aria-label="Add task" title="Add task" disabled={busy} onClick={create}>
            <TaskIcon name="add" /><span>Add task</span></button>}
        </div>
      </header>
      {feedback}
      {viewContent()}
    </div>
    {panel?.kind === "history" && <TasksDialog title={panel.task.title} onClose={close}>
      <section className="tasks-closed-history" aria-label="Activity"><h3>Activity</h3>
        <TaskHistory adapter={adapter} taskId={panel.task.task_id} /></section>
    </TasksDialog>}
    {dialog}
    {footer?.(busy || !snapshot || !!panel)}
  </div>;
}
