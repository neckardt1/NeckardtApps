import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { Link } from "react-router";
import { AppShell } from "./AppShell.tsx";
import { SessionProvider, useSiteSession, type SessionApi } from "./session.tsx";
import { ProfileEditor } from "./ProfileEditor.tsx";
import type { AccountProfile, ProfileStore } from "./profile.ts";
import "./shell.css";

function AccountPanel({ profileControls }: { profileControls: ReactNode }) {
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
        {profileControls}
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

function SessionShell({ store, children }: { store?: ProfileStore; children: ReactNode }) {
  const { user, isCurrent } = useSiteSession();
  const userId = user?.id;
  const [result, setResult] = useState<{ identity: typeof isCurrent; profile: AccountProfile | null }>();
  const [attempt, setAttempt] = useState(0);
  const [savingFor, setSavingFor] = useState<typeof isCurrent | null>(null);
  useEffect(() => {
    if (!userId || !store) return;
    let active = true;
    const publish = (profile: AccountProfile | null) => {
      if (active && isCurrent()) setResult({ identity: isCurrent, profile });
    };
    void store.load(userId).then(publish, () => publish(null));
    return () => { active = false; };
  }, [userId, isCurrent, store, attempt]);

  const profile = result?.identity === isCurrent ? result.profile : undefined;
  async function save(changes: Partial<AccountProfile>) {
    if (!userId || !store || !isCurrent()) throw Error("Account changed.");
    setSavingFor(() => isCurrent);
    try {
      const updated = await store.save(userId, changes);
      if (isCurrent()) setResult({ identity: isCurrent, profile: updated });
    } finally {
      setSavingFor(current => current === isCurrent ? null : current);
    }
  }

  const controls = !store ? null : profile ? <ProfileEditor key={userId} profile={profile}
    saving={savingFor === isCurrent} onSave={save} />
    : profile === undefined ? <p role="status">Loading profile…</p>
    : <div><p className="account-error" role="alert">Unable to load your profile.</p>
      <button className="profile-edit" type="button" onClick={() => {
        setResult(undefined); setAttempt(count => count + 1);
      }}>Retry</button></div>;
  return <AppShell accountIdentity={userId ?? null} profile={profile ?? undefined}
    account={<AccountPanel profileControls={controls} />}>{children}</AppShell>;
}

export function SiteRoot({ api, children }: { api: SessionApi | null; children: ReactNode }) {
  return <SessionProvider api={api}><SessionShell store={api?.profiles}>{children}</SessionShell></SessionProvider>;
}
