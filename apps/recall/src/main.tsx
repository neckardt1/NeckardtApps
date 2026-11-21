import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { makeRecallApi } from "./recall-api.ts";
import { readPublicSupabaseConfig } from "../../../shared/browser-auth.mts";
import "./styles.css";

declare const __RECALL_PUBLIC_CONFIG__: unknown;
const config = readPublicSupabaseConfig(__RECALL_PUBLIC_CONFIG__);
const root = document.getElementById("root");
if (!root) throw new Error("Missing Recall mount point");
createRoot(root).render(<App api={config ? makeRecallApi(config) : null} />);
