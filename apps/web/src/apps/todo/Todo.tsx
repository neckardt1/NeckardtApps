import { useCallback, useEffect, useState, type FormEvent } from "react";
import { readPublicSupabaseConfig } from "../../shell/browser-auth.mts";
import { getSiteClient } from "../../shell/site-client";
import { useSiteSession } from "../../shell/session";
import "./todo.css";

declare const __SITE_PUBLIC_CONFIG__: unknown;
const config = readPublicSupabaseConfig(__SITE_PUBLIC_CONFIG__);
const client = config && getSiteClient(config);
type Client = NonNullable<typeof client>;

function readProjects(api: Client) {
  return api.from("todo_projects")
    .select("id, owner_id, collaborator_id, name, todo_tasks(id, title, done, created_at)")
    .order("name").order("id")
    .order("created_at", { referencedTable: "todo_tasks" }).order("id", { referencedTable: "todo_tasks" })
    .throwOnError();
}
type Projects = Awaited<ReturnType<typeof readProjects>>["data"];

function Entry({ label, action, initial = "", limit, save }: {
  label: string; action: string; initial?: string; limit: number; save(value: string): Promise<boolean>;
}) {
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const value = String(new FormData(form).get("entry") ?? "").trim();
    if (value && await save(value)) form.reset();
  }
  return <form className="todo-entry" onSubmit={submit}>
    <label>{label}<input name="entry" defaultValue={initial} required maxLength={limit} /></label>
    <button type="submit">{action}</button>
  </form>;
}

function ProjectList({ api, userId }: { api: Client; userId: string }) {
  const { isCurrent } = useSiteSession();
  const [projects, setProjects] = useState<Projects>([]);
  const [enrolled, setEnrolled] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  const [editing, setEditing] = useState<string | null>(null);

  const reload = useCallback(async (active: () => boolean = () => true) => {
    const { data: account } = await api.from("todo_accounts").select("user_id")
      .eq("user_id", userId).maybeSingle().throwOnError();
    const data = account ? (await readProjects(api)).data : [];
    if (active() && isCurrent()) {
      setEnrolled(Boolean(account));
      setProjects(data);
    }
  }, [api, userId, isCurrent]);

  useEffect(() => {
    let active = true;
    void reload(() => active).catch(() => {
      if (active) setError("Couldn’t load your projects. Try Refresh.");
    }).finally(() => { if (active) setBusy(false); });
    return () => { active = false; };
  }, [reload]);

  async function run(write?: () => PromiseLike<unknown>) {
    if (busy || !isCurrent()) return false;
    setBusy(true);
    setError("");
    let saved = false;
    try {
      if (write) await write();
      saved = true;
    } catch {
      setError("Couldn’t save that change. Check the entry and your project access.");
    }
    try {
      if (isCurrent()) await reload();
    } catch {
      setProjects([]);
      setError(saved && write ? "Saved. Refresh to see the latest projects." : "Couldn’t load your projects. Try Refresh.");
    } finally {
      setBusy(false);
    }
    return saved;
  }

  return <fieldset className="todo-workspace" disabled={busy}>
    <div className="todo-toolbar"><button onClick={() => void run()}>Refresh</button></div>
    {error && <p role="alert">{error}</p>}
    {busy && <p role="status">Updating projects…</p>}
    {enrolled === false && <p>To-do access hasn’t been enabled for this account.</p>}
    {enrolled && <>
      <details><summary>Your sharing ID</summary><p>Give this ID to the owner of a project you want to join.</p><code>{userId}</code></details>
      <Entry label="New project" action="Create project" limit={120} save={name => run(() =>
        api.from("todo_projects").insert({ name, owner_id: userId }).throwOnError())} />
      {projects.length === 0 && <p>You have no projects yet.</p>}
      {projects.map(project => <section className="todo-project" key={project.id} aria-label={project.name}>
        <h2>{project.name}</h2>
        <p className="todo-access">{project.collaborator_id ? project.owner_id === userId ? "Shared by you" : "Shared with you" : "Private"}</p>
        <ul>{project.todo_tasks.map(task => <li key={task.id}>
          {editing === task.id ? <>
            <Entry label="Task title" action="Save title" initial={task.title} limit={240} save={async title => {
              const saved = await run(() => api.from("todo_tasks").update({ title }).eq("id", task.id)
                .select("id").single().throwOnError());
              if (saved) setEditing(null);
              return saved;
            }} />
            <button onClick={() => setEditing(null)}>Cancel</button>
          </> : <>
            <label className="todo-task"><input type="checkbox" checked={task.done} onChange={() => void run(() =>
              api.from("todo_tasks").update({ done: !task.done }).eq("id", task.id).select("id").single().throwOnError())} />
              <span>{task.title}</span></label>
            <button aria-label={`Edit ${task.title}`} onClick={() => setEditing(task.id)}>Edit</button>
          </>}
        </li>)}</ul>
        <Entry label="New task" action="Add task" limit={240} save={title => run(() =>
          api.from("todo_tasks").insert({ title, project_id: project.id }).throwOnError())} />
        {project.owner_id === userId && <details>
          <summary>Manage sharing</summary>
          {project.collaborator_id ? <>
            <p>Shared with <code>{project.collaborator_id}</code></p>
            <button onClick={() => void run(() => api.from("todo_projects").update({ collaborator_id: null })
              .eq("id", project.id).select("id").single().throwOnError())}>Stop sharing</button>
          </> : <Entry label="Collaborator’s sharing ID" action="Share project" limit={36} save={id => run(() =>
            api.from("todo_projects").update({ collaborator_id: id }).eq("id", project.id)
              .select("id").single().throwOnError())} />}
        </details>}
      </section>)}
    </>}
  </fieldset>;
}

export default function Todo() {
  const session = useSiteSession();
  useEffect(() => {
    document.title = "To-do";
    return () => { document.title = "Apps"; };
  }, []);
  return <section className="launcher todo"><h1>To-do</h1>
    {session.status === "signed-in" && session.user && client
      ? <ProjectList key={session.user.id} api={client} userId={session.user.id} />
      : <p>{session.status === "loading" ? "Checking your session…"
        : session.status === "unavailable" || !client ? "Account unavailable." : "Sign in under Account to open your projects."}</p>}
  </section>;
}
