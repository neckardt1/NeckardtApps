import { appHref, apps, type AppsHref } from "../shared/apps.ts";

export function Launcher({ appsHref = "./" }: { appsHref?: AppsHref }) {
  return <section className="launcher" aria-labelledby="launcher-title">
    <h1 id="launcher-title">Your apps</h1>
    <p className="launcher-intro">Small tools for everyday use.</p>
    <ul className="app-list">
      {apps.map(app => <li key={app.id}>
        <a className="app-card" href={appHref(appsHref, app)}>
          <span className="app-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
            <rect x="6" y="4" width="13" height="16" rx="2.4" /><path d="M3 7v12a4 4 0 0 0 4 4h9M9.5 9h6M9.5 13h4" />
          </svg></span>
          <span className="app-copy"><span className="app-name">{app.name}</span><span className="app-description">{app.description}</span></span>
          <span className="app-status">Open</span>
        </a>
      </li>)}
    </ul>
  </section>;
}
