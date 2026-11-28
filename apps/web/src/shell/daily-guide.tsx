import { useEffect, useReducer, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { pacificDate } from "../apps/tasks/model";
import { useSiteSession } from "./session";
import { siteConfig } from "./site-client";

export function useDailyGuide() {
  const { user, isCurrent } = useSiteSession();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [, refresh] = useReducer(n => n + 1, 0);
  const day = pacificDate(new Date());
  const scope = user && siteConfig ? `home.daily.${siteConfig.url}.${user.id}.` : null;
  const [failed, setFailed] = useState<string | null>(null);

  useEffect(() => {
    if (!scope) return;
    let timer: ReturnType<typeof setTimeout>;
    function tick() {
      refresh();
      timer = setTimeout(tick, 60_000 - Date.now() % 60_000 + 5);
    }
    tick();
    const stored = (event: StorageEvent) => {
      if (!event.key || event.key.startsWith(scope)) refresh();
    };
    window.addEventListener("storage", stored);
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("storage", stored);
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [scope]);

  function has(marker: string) {
    try { return !!scope && localStorage.getItem(scope + marker) === day; }
    catch { return false; }
  }
  function mark(marker: string) {
    if (!scope || !isCurrent() || day !== pacificDate(new Date())) { refresh(); return false; }
    try {
      localStorage.setItem(scope + marker, day);
      setFailed(null);
      refresh();
      return true;
    } catch { setFailed(scope); return false; }
  }
  const practicePath = `/recall/?plan=${day}`;
  return {
    day, practicePath, started: has("started"), planned: has("planned"), dismissed: has("dismissed"),
    requestedDay: params.get("plan"),
    error: failed && failed === scope ? "Couldn’t save today’s progress on this device. Try again." : null,
    pick() { if (mark("started")) void navigate(`/tasks/?plan=${day}`); },
    done() { mark("planned"); },
    dismiss() { mark("dismissed"); },
  };
}

export function GuideFooter({ step, onClick, disabled, error }: {
  step: 1 | 2; onClick: () => void; disabled?: boolean; error?: string | null;
}) {
  return <footer className="guide-footer" aria-label="Daily plan">
    {error && <p role="alert">{error}</p>}
    <div><span>Step {step} of 2</span>
      <button type="button" onClick={onClick} disabled={disabled}>{step === 1 ? "Done" : "Skip practice"}</button>
    </div>
  </footer>;
}
