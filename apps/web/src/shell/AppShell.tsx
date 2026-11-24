import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Link, useLocation } from "react-router";
import { apps } from "./apps.ts";

type Popover = "apps" | "account";
type Props = {
  account: ReactNode;
  accountIdentity: string | null;
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
export function AppShell({ account: accountContent, accountIdentity, children }: Props) {
  const [open, setOpen] = useState<Popover | null>(null);
  const appsButton = useRef<HTMLButtonElement>(null);
  const accountButton = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const previousIdentity = useRef(accountIdentity);
  const { pathname } = useLocation();
  const previousPath = useRef(pathname);
  const main = useRef<HTMLElement>(null);
  const id = useId();

  useLayoutEffect(() => {
    if (previousPath.current !== pathname) {
      previousPath.current = pathname;
      setOpen(null);
      main.current?.focus();
    }
  }, [pathname]);

  useLayoutEffect(() => {
    if (open) (panel.current?.querySelector<HTMLElement>("a,button:not(:disabled),input:not(:disabled)") ?? panel.current)?.focus();
  }, [open]);

  useEffect(() => {
    if (previousIdentity.current !== accountIdentity) {
      previousIdentity.current = accountIdentity;
      if (open === "account") {
        setOpen(null);
        accountButton.current?.focus();
      }
    }
  }, [accountIdentity, open]);

  useEffect(() => {
    if (!open) return;
    function outside(event: Event) {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (!panel.current?.contains(target) && !appsButton.current?.contains(target) && !accountButton.current?.contains(target)) {
        setOpen(null);
      }
    }
    function keyboard(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      setOpen(null);
      (open === "apps" ? appsButton : accountButton).current?.focus();
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

  return <div className="site-page">
    <a className="skip-link" href="#main-content">Skip to content</a>
    <header className="topbar">
      <div className="topbar-inner">
        <button ref={appsButton} type="button" className="chrome-button" aria-expanded={open === "apps"}
          aria-controls={open === "apps" ? `${id}-apps` : undefined} aria-haspopup="dialog"
          onClick={() => setOpen(open === "apps" ? null : "apps")}><AppsIcon /><span>Apps</span><Chevron /></button>
        <button ref={accountButton} type="button" className="chrome-button" aria-expanded={open === "account"}
          aria-controls={open === "account" ? `${id}-account` : undefined} aria-haspopup="dialog"
          onClick={() => setOpen(open === "account" ? null : "account")}><AccountIcon /><span>Account</span><Chevron /></button>
        {open && <div ref={panel} id={`${id}-${open}`} className={`chrome-popover ${open}`} role="dialog"
          aria-label={open === "apps" ? "Apps" : "Account"} tabIndex={-1} data-popover-open="true">
          {open === "apps" ? <nav aria-label="Apps" onClick={() => setOpen(null)}>
            <Link className="popover-link" to="/">All apps</Link>
            {apps.map(app => <Link className="popover-link app-menu-link" key={app.id} to={app.path}>
              <span>{app.name}</span><span className="menu-status">Open</span>
            </Link>)}
          </nav> : accountContent}
        </div>}
      </div>
    </header>
    <main ref={main} className="site-main" id="main-content" tabIndex={-1}>{children}</main>
  </div>;
}
