import { Link } from "react-router";
import { usePracticeToday } from "../apps/habit-practice/practice-today";
import { TaskSurface } from "../apps/tasks/Tasks";
import { useTaskSwipe } from "../apps/tasks/useTaskSwipe";
import { TaskIcon } from "../apps/tasks/icons";
import type { useDailyGuide } from "./daily-guide";
import { siteConfig } from "./site-client";

type Guide = ReturnType<typeof useDailyGuide>;

function PracticeReminder({ guide, unknown }: { guide: Guide; unknown: boolean }) {
  const swipe = useTaskSwipe(side => { if (side === "left") guide.dismiss(); });
  return <div ref={swipe} className="tasks-swipe practice-reminder">
    <span aria-hidden="true" className="tasks-hint tasks-hint-schedule">Dismiss</span>
    <div className="tasks-row">
      <Link to={guide.practicePath}>
        <TaskIcon name="bell" size={18} />{unknown ? "Check Habit Practice" : "Habit Practice"}
      </Link>
      <button type="button" aria-label="Dismiss Habit Practice for today" onClick={guide.dismiss}><TaskIcon name="close" size={16} /></button>
    </div>
  </div>;
}

export default function PlannedHome({ guide }: { guide: Guide }) {
  const practice = usePracticeToday(guide.dismissed ? null : siteConfig, guide.day);
  const reminder = !guide.dismissed && practice !== "clear";
  return <>
    <TaskSurface renderHome={rows => rows || reminder ? <>
      <header className="home-focus-heading"><h2>Top tasks</h2><Link to="/tasks/">All tasks</Link></header>
      {rows}
      {reminder && (practice === "checking" ? <p className="home-practice-status" role="status">Checking practice…</p>
        : <PracticeReminder guide={guide} unknown={practice === "unknown"} />)}
    </> : <div className="home-finished"><p>{guide.dismissed ? "Nothing in Focus." : "All done for today."}</p>
      <Link to="/tasks/">Pick more tasks</Link></div>} />
    {guide.error && <p role="alert">{guide.error}</p>}
  </>;
}
