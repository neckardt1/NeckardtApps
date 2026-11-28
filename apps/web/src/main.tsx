import { lazy, StrictMode, Suspense } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router";
import { SiteRoot } from "./shell/SiteRoot.tsx";
import { makeSiteSessionApi, type SessionApi } from "./shell/session.tsx";
import type { PublicSupabaseConfig } from "./shell/browser-auth.mts";

declare const __SITE_PUBLIC_CONFIG__: PublicSupabaseConfig | null;

// The entry module is one directory below the site root (src/ in dev, assets/ on Pages).
const base = new URL(/* @vite-ignore */ "..", import.meta.url).pathname;
if (location.pathname === base && location.hash.startsWith("#pages:/")) {
  const target = new URL(location.origin + location.hash.slice("#pages:".length));
  if (target.pathname.startsWith(base) && !target.pathname.startsWith(base + "oauth/")) {
    history.replaceState(history.state, "", target);
  }
}
const HabitPractice = lazy(() => import("./apps/habit-practice/HabitPractice.tsx"));

// Account availability must never prevent the public app launcher rendering.
let api: SessionApi | null = null;
try { api = makeSiteSessionApi(__SITE_PUBLIC_CONFIG__); } catch { /* Public launcher stays available. */ }
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter basename={base}>
      <SiteRoot api={api} practice={
        <Suspense fallback={<p role="status">Loading Habit Practice…</p>}>
          <HabitPractice />
        </Suspense>
      } />
    </BrowserRouter>
  </StrictMode>
);
