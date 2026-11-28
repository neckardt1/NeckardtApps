import { lazy, Suspense } from "react";
import { Link } from "react-router";
import { useDailyGuide } from "./daily-guide";
import { siteConfig } from "./site-client";
import { useSiteSession } from "./session";
import "./home.css";

const PlannedHome = lazy(() => import("./PlannedHome"));

export function Home() {
  const session = useSiteSession();
  const guide = useDailyGuide();
  if (session.status !== "signed-in" || !session.user || !siteConfig) return <section className="launcher">
    <h1 className="visually-hidden">Home</h1><Link className="home-directory-link" to="/apps/">All apps</Link>
  </section>;
  return <section className="daily-home" aria-labelledby="home-title">
    <h1 className="visually-hidden" id="home-title">Home</h1>
    {guide.planned ? <Suspense fallback={<p role="status">Loading tasks…</p>}>
      <PlannedHome key={session.user.id + guide.day} guide={guide} />
    </Suspense>
      : <div className="home-start">
        <button type="button" onClick={guide.pick}>{guide.started ? "Continue planning" : "Pick tasks"}</button>
        {guide.error && <p role="alert">{guide.error}</p>}
      </div>}
  </section>;
}
