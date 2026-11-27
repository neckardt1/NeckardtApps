import { lazy, Suspense, type ReactNode } from "react";
import { Link, Route, Routes } from "react-router";
import { Launcher } from "./shell/Launcher.tsx";

const Todo = lazy(() => import("./apps/todo/Todo.tsx"));

export function AppRoutes({ practice }: { practice: ReactNode }) {
  return <Routes>
    <Route path="/index.html?" element={<Launcher />} />
    <Route path="/recall/index.html?" element={practice} />
    <Route path="/todo/index.html?" element={<Suspense fallback={<p role="status">Loading to-do…</p>}><Todo /></Suspense>} />
    <Route path="*" element={<section className="launcher"><h1>Page not found</h1><Link to="/">All apps</Link></section>} />
  </Routes>;
}
