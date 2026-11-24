import { useEffect } from "react";
import { readPublicSupabaseConfig } from "../../shell/browser-auth.mts";
import { App } from "./App.tsx";
import { makeRecallApi, type RecallApi } from "./recall-api.ts";
import "./styles.css";

declare const __SITE_PUBLIC_CONFIG__: unknown;
const config = readPublicSupabaseConfig(__SITE_PUBLIC_CONFIG__);
let api: RecallApi | null = null;
try { api = config ? makeRecallApi(config) : null; } catch { /* Keep navigation available. */ }

export default function HabitPractice() {
  useEffect(() => {
    document.title = "Habit Practice";
    return () => { document.title = "Apps"; };
  }, []);
  return <App api={api} />;
}
