import { Link } from "react-router";
import { AppTileIcon } from "./AppTileIcon.tsx";
import { apps } from "./apps.ts";

export function Launcher() {
  return <section className="launcher" aria-labelledby="launcher-title">
    <h1 id="launcher-title">All apps</h1>
    <p className="launcher-intro">Small tools for everyday use.</p>
    <ul className="app-list">
      {apps.map(app => <li key={app.id}>
        <Link className="app-card" to={app.path}>
          <AppTileIcon id={app.id} />
          <span className="app-copy"><span className="app-name">{app.name}</span><span className="app-description">{app.description}</span></span>
          <span className="app-status">Open</span>
        </Link>
      </li>)}
    </ul>
  </section>;
}
