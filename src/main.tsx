import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { SiteRoot } from "../shared/SiteRoot.tsx";
import { makeSiteSessionApi, type SessionApi } from "../shared/session.tsx";
import type { PublicSupabaseConfig } from "../shared/browser-auth.mts";
import { Launcher } from "./Launcher.tsx";

declare const __SITE_PUBLIC_CONFIG__: PublicSupabaseConfig | null;

// Account availability must never prevent the public app launcher rendering.
let api: SessionApi | null = null;
try { api = makeSiteSessionApi(__SITE_PUBLIC_CONFIG__); } catch { /* Public launcher stays available. */ }
createRoot(document.getElementById("root")!).render(
  <StrictMode><SiteRoot api={api} appsHref="./"><Launcher appsHref="./" /></SiteRoot></StrictMode>
);
