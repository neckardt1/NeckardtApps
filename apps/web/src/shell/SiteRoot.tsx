import { type FormEvent, type ReactNode } from "react";
import { Link } from "react-router";
import { AppShell } from "./AppShell.tsx";
import { SessionProvider, useSiteSession, type SessionApi } from "./session.tsx";
import "./shell.css";

function AccountPanel() {
  const session = useSiteSession();
  async function signIn(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (session.busy) return;
    const form = event.currentTarget;
    const data = new FormData(form);
    try { await session.signIn(String(data.get("email") ?? ""), String(data.get("password") ?? "")); }
    finally {
      const password = form.elements.namedItem("password");
      if (password instanceof HTMLInputElement) password.value = "";
    }
  }
  return <div className="account-panel">
    {session.status === "loading" ? <p className="account-note" role="status">Checking your session…</p>
      : session.status === "unavailable" ? <p className="account-note">Account is unavailable right now. You can still open apps.</p>
      : session.status === "signed-in" ? <>
        <p className="account-note">Signed in</p>
        <Link reloadDocument to="/oauth/consent/?manage">Manage connections</Link>
        <button className="account-action" type="button" disabled={session.busy} onClick={() => void session.signOut()}>
          {session.busy ? "Signing out…" : "Sign out"}
        </button>
      </> : <form className="account-form" onSubmit={event => void signIn(event)}>
        <p className="account-note">Sign in to your existing account.</p>
        <label>Email<input type="email" name="email" autoComplete="username" required disabled={session.busy} /></label>
        <label>Password<input type="password" name="password" autoComplete="current-password" required disabled={session.busy} /></label>
        <button className="account-action" type="submit" disabled={session.busy}>{session.busy ? "Signing in…" : "Sign in"}</button>
      </form>}
    {session.error && <p className="account-error" role="alert">{session.error}</p>}
  </div>;
}

function SessionShell({ children }: { children: ReactNode }) {
  const session = useSiteSession();
  return <AppShell accountIdentity={session.user?.id ?? null} account={<AccountPanel />}>{children}</AppShell>;
}

export function SiteRoot({ api, children }: { api: SessionApi | null; children: ReactNode }) {
  return <SessionProvider api={api}><SessionShell>{children}</SessionShell></SessionProvider>;
}
