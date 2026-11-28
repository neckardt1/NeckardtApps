import { useCallback, useEffect } from "react";
import { Navigate, useNavigate } from "react-router";
import { siteConfig } from "../../shell/site-client";
import { GuideFooter, useDailyGuide } from "../../shell/daily-guide";
import { useSiteSession } from "../../shell/session";
import { App } from "./App";
import { PracticeDeck } from "./PracticeDeck.tsx";
import { usePracticeToday } from "./practice-today";
import { makeRecallApi, type RecallApi } from "./recall-api.ts";
import "./styles.css";

let api: RecallApi | null = null;
try { api = siteConfig ? makeRecallApi(siteConfig) : null; } catch { /* Keep navigation available. */ }

function GuidedPractice({ day }: { day: string }) {
  const status = usePracticeToday(siteConfig, day);
  const navigate = useNavigate();
  const exit = useCallback(() => { void navigate("/", { replace: true }); }, [navigate]);
  if (status === "clear") return <Navigate to="/" replace />;
  if (status === "checking") return <section className="habit-practice"><p role="status">Checking practice…</p>
    <GuideFooter step={2} onClick={exit} /></section>;
  return <App api={api} onGuideExit={exit} />;
}

export default function HabitPractice() {
  const guide = useDailyGuide();
  const { status, user } = useSiteSession();
  useEffect(() => {
    document.title = "Habit Practice";
    return () => { document.title = "Apps"; };
  }, []);
  if (status === "signed-in" && user && guide.requestedDay !== null) {
    if (guide.requestedDay !== guide.day || !guide.planned) return <Navigate to="/" replace />;
    return <GuidedPractice key={user.id + guide.day} day={guide.day} />;
  }
  return <PracticeDeck api={api} />;
}
