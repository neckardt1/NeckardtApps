import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { Link } from "react-router";
import { AppRoutes } from "../AppRoutes.tsx";
import { AppShell } from "./AppShell.tsx";
import { SessionProvider, useSiteSession, type SessionApi } from "./session.tsx";
import { ProfileEditor } from "./ProfileEditor.tsx";
import type { AccountProfile, ProfileStore } from "./profile.ts";
import "./shell.css";

function ProfilePage({ profileControls }: { profileControls: ReactNode }) {
  const session = useSiteSession();
  useEffect(() => {
    document.title = "Profile";
    return () => { document.title = "Apps"; };
  }, []);

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
  return <section className="profile-page" aria-labelledby="profile-title">
    <h1 id="profile-title">Profile</h1>
    {session.status === "loading" ? <p className="account-note" role="status">Checking your session…</p>
      : session.status === "unavailable" ? <p className="account-note">Account is unavailable right now. You can still open apps.</p>
      : session.status === "signed-in" ? <>
        <p className="account-note">Signed in</p>
        {profileControls}
        <div className="profile-account-actions">
          <Link reloadDocument to="/oauth/consent/?manage">Manage connections</Link>
          <button className="profile-edit" type="button" disabled={session.busy} onClick={() => void session.signOut()}>
            {session.busy ? "Signing out…" : "Sign out"}
          </button>
        </div>
      </> : <form className="account-form" onSubmit={event => void signIn(event)}>
        <p className="account-note">Sign in to your existing account.</p>
        <label>Email<input type="email" name="email" autoComplete="username" required disabled={session.busy} /></label>
        <label>Password<input type="password" name="password" autoComplete="current-password" required disabled={session.busy} /></label>
        <button className="account-action" type="submit" disabled={session.busy}>{session.busy ? "Signing in…" : "Sign in"}</button>
      </form>}
    {session.error && <p className="account-error" role="alert">{session.error}</p>}
  </section>;
}

function SessionShell({ store, practice }: { store?: ProfileStore; practice: ReactNode }) {
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
  return <AppShell profile={profile ?? undefined}>
    <AppRoutes practice={practice} profile={<ProfilePage profileControls={controls} />} />
  </AppShell>;
}

export function SiteRoot({ api, practice }: { api: SessionApi | null; practice: ReactNode }) {
  return <SessionProvider api={api}><SessionShell store={api?.profiles} practice={practice} /></SessionProvider>;
}
