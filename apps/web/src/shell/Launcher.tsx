import { AppTileGrid } from "./AppTileGrid.tsx";

export function Launcher() {
  return <nav className="launcher app-directory" aria-labelledby="launcher-title">
    <h1 className="visually-hidden" id="launcher-title">All apps</h1>
    <AppTileGrid />
  </nav>;
}
