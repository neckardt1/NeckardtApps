import type { ReactNode } from "react";
import { Link, Route, Routes } from "react-router";
import { Launcher } from "./shell/Launcher.tsx";

export function AppRoutes({ practice }: { practice: ReactNode }) {
  return <Routes>
    <Route path="/index.html?" element={<Launcher />} />
    <Route path="/recall/index.html?" element={practice} />
    <Route path="*" element={<section className="launcher"><h1>Page not found</h1><Link to="/">All apps</Link></section>} />
  </Routes>;
}
