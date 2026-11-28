import { useMemo } from "react";
import { Navigate } from "react-router";
import { GuideFooter, useDailyGuide } from "../../shell/daily-guide";
import { siteConfig } from "../../shell/site-client";
import { useSiteSession } from "../../shell/session.tsx";
import { tasksAdapter } from "./api.ts";
import { TasksPage, type TaskLayout } from "./TasksPage.tsx";

export function TaskSurface(layout: TaskLayout) {
  const session = useSiteSession();
  const actor = session.user?.id;
  const adapter = useMemo(() => {
    return actor && siteConfig ? tasksAdapter(siteConfig, actor) : null;
  }, [actor]);
  if (session.status === "signed-in" && adapter) {
    return <TasksPage key={actor} adapter={adapter} isCurrent={session.isCurrent} {...layout} />;
  }
  return <section className="launcher"><h1>Tasks</h1>{
    session.status === "loading" ? <p role="status">Checking your session…</p>
    : <p>{session.status === "signed-out" ? "Sign in under Account to open Tasks." : "Account sign-in is unavailable."}</p>
  }</section>;
}

export default function Tasks() {
  const guide = useDailyGuide();
  const { status } = useSiteSession();
  if (status !== "signed-in" || guide.requestedDay === null) return <TaskSurface />;
  if (guide.requestedDay !== guide.day || !guide.started) return <Navigate to="/" replace />;
  if (guide.planned) return <Navigate to={guide.practicePath} replace />;
  return <TaskSurface footer={busy => <GuideFooter step={1} disabled={busy} onClick={guide.done} error={guide.error} />} />;
}
