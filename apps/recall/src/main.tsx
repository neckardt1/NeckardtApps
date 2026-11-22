import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { SiteRoot } from "../../../shared/SiteRoot.tsx";
import { makeSiteSessionApi, type SessionApi } from "../../../shared/session.tsx";
import { readPublicSupabaseConfig } from "../../../shared/browser-auth.mts";
import { App } from "./App.tsx";
import { makeRecallApi, type RecallApi } from "./recall-api.ts";
import "./styles.css";

declare const __SITE_PUBLIC_CONFIG__: unknown;
const config = readPublicSupabaseConfig(__SITE_PUBLIC_CONFIG__);
let session: SessionApi | null = null;
let api: RecallApi | null = null;
try {
  session = makeSiteSessionApi(config);
  api = config ? makeRecallApi(config) : null;
} catch { /* Unavailable Account or feature must retain public app navigation. */ }
const root = document.getElementById("root");
if (!root) throw new Error("Missing Habit Practice mount point");
createRoot(root).render(
  <StrictMode><SiteRoot api={session} appsHref="../"><App api={api} /></SiteRoot></StrictMode>
);
