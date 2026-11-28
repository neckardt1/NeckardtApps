import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Link, NavLink, useLocation } from "react-router";
import type { AccountProfile } from "./profile.ts";
import { apps } from "./apps.ts";
import { AppHomeBusy } from "./app-navigation";
import { AppTileGrid } from "./AppTileGrid.tsx";

type Props = {
  profile?: AccountProfile;
  children: ReactNode;
};

function AppsIcon() {
  return <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7">
    <rect x="4" y="4" width="5" height="5" rx=".6" /><rect x="15" y="4" width="5" height="5" rx=".6" />
    <rect x="4" y="15" width="5" height="5" rx=".6" /><rect x="15" y="15" width="5" height="5" rx=".6" />
  </svg>;
}
function AccountIcon() {
  return <span className="account-icon"><svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
    <circle cx="12" cy="8" r="3" /><path d="M5.5 20v-2.2c0-3.9 13-3.9 13 0V20" />
  </svg></span>;
}
function Chevron() {
  return <svg className="chevron" aria-hidden="true" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.6"><path d="m3 4.5 3 3 3-3" /></svg>;
}

/** Shared page chrome; session and feature behavior remain outside this component. */
export function AppShell({ profile, children }: Props) {
  const [open, setOpen] = useState(false);
  const appsButton = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const location = useLocation();
  const appId = location.pathname.split("/")[1]?.toLowerCase();
  const currentApp = apps.find(app => app.id === appId);
  const [appBusy, setAppBusy] = useState(false);
  const previousEntry = useRef(location.key);
  const main = useRef<HTMLElement>(null);
  const id = useId();

  useLayoutEffect(() => {
    if (previousEntry.current !== location.key) {
      previousEntry.current = location.key;
      setOpen(false);
      main.current?.focus();
    }
  }, [location.key]);

  useLayoutEffect(() => {
    if (open) (panel.current?.querySelector<HTMLElement>("a,button:not(:disabled),input:not(:disabled)") ?? panel.current)?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function outside(event: Event) {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (!panel.current?.contains(target) && !appsButton.current?.contains(target)) {
        setOpen(false);
      }
    }
    function keyboard(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
      appsButton.current?.focus();
    }
    document.addEventListener("pointerdown", outside);
    document.addEventListener("focusin", outside);
    document.addEventListener("keydown", keyboard, true);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("focusin", outside);
      document.removeEventListener("keydown", keyboard, true);
    };
  }, [open]);

  function closeApps() {
    setOpen(false);
    appsButton.current?.focus();
  }

  return <div className="site-page">
    <a className="skip-link" href="#main-content">Skip to content</a>
    <header className="topbar">
      <div className="topbar-inner">
        <Link className="chrome-button home-link" to="/" onClick={() => setOpen(false)}>Home</Link>
        {currentApp && <Link to={currentApp.path} className="chrome-button app-home-link"
          aria-label={`${currentApp.name} home`} aria-disabled={appBusy || undefined}
          replace={!location.state?.appView && location.pathname === currentApp.path && !location.search && !location.hash}
          onClick={event => { if (appBusy) event.preventDefault(); else setOpen(false); }}>
          {currentApp.name}
        </Link>}
        <button ref={appsButton} type="button" className="chrome-button apps-toggle" aria-label="Apps" title="Apps" aria-expanded={open}
          aria-controls={open ? `${id}-apps` : undefined} aria-haspopup="dialog"
          onClick={() => setOpen(!open)}><AppsIcon /><span>Apps</span><Chevron /></button>
        <NavLink to="/profile" className="chrome-button account-link" aria-label={profile?.display_name ? `Account: ${profile.display_name}` : "Account"}
          onClick={() => setOpen(false)}>
          {profile?.picture ? <img className="account-avatar" src={profile.picture} alt="" /> : <AccountIcon />}
          <span className="account-name">{profile?.display_name || "Account"}</span>
        </NavLink>
        {open && <div ref={panel} id={`${id}-apps`} className="chrome-popover apps" role="dialog"
          aria-label="Apps" tabIndex={-1} data-popover-open="true">
          <nav aria-label="Apps">
            <AppTileGrid onSelect={closeApps} />
            <Link className="all-apps-link" to="/apps/" onClick={closeApps}>All apps
              <svg aria-hidden="true" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
                <path d="M3 8h9m-4-4 4 4-4 4" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </Link>
          </nav>
        </div>}
      </div>
    </header>
    <main ref={main} className="site-main" id="main-content" tabIndex={-1}><AppHomeBusy.Provider value={setAppBusy}>{children}</AppHomeBusy.Provider></main>
  </div>;
}
