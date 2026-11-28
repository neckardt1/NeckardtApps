import { useMemo } from "react";
import { readPublicSupabaseConfig } from "../../shell/browser-auth.mts";
import { useSiteSession } from "../../shell/session.tsx";
import { tasksAdapter } from "./api.ts";
import { TasksPage } from "./TasksPage.tsx";

declare const __SITE_PUBLIC_CONFIG__: unknown;

export default function Tasks() {
  const session = useSiteSession();
  const actor = session.user?.id;
  const adapter = useMemo(() => {
    const config = readPublicSupabaseConfig(__SITE_PUBLIC_CONFIG__);
    return actor && config ? tasksAdapter(config, actor) : null;
  }, [actor]);
  if (session.status === "signed-in" && adapter) {
    return <TasksPage key={actor} adapter={adapter} isCurrent={session.isCurrent} />;
  }
  return <section className="launcher"><h1>Tasks</h1>{
    session.status === "loading" ? <p role="status">Checking your session…</p>
    : <p>{session.status === "signed-out" ? "Sign in under Account to open Tasks." : "Account sign-in is unavailable."}</p>
  }</section>;
}
