import { useState, type FormEvent } from "react";
import { makeThumbnail, type AccountProfile } from "./profile.ts";

type Props = {
  profile: AccountProfile;
  saving: boolean;
  onSave(changes: Partial<AccountProfile>): Promise<void>;
};

export function ProfileEditor({ profile, saving, onSave }: Props) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(profile.display_name);
  const [picture, setPicture] = useState(profile.picture);
  const [reading, setReading] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  if (!editing) return <>
    <button className="profile-edit" type="button" disabled={saving} onClick={() => {
      setName(profile.display_name); setPicture(profile.picture);
      setError(""); setMessage(""); setEditing(true);
    }}>Edit profile</button>
    {message && <p role="status">{message}</p>}
  </>;

  async function choosePicture(file?: File) {
    if (!file) return;
    setReading(true); setError("");
    try { setPicture(await makeThumbnail(file)); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Unable to read this picture."); }
    finally { setReading(false); }
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    if (reading || saving) return;
    setError("");
    const changes: Partial<AccountProfile> = {};
    if (name.trim() !== profile.display_name) changes.display_name = name.trim();
    if (picture !== profile.picture) changes.picture = picture;
    try {
      if (Object.keys(changes).length) await onSave(changes);
      setEditing(false); setMessage("Profile saved.");
    } catch { setError("Unable to save your profile. Please try again."); }
  }

  return <form className="account-form profile-form" onSubmit={save}>
    <fieldset disabled={reading || saving}>
      <legend>Edit profile</legend>
      <label>Account name<input autoFocus autoComplete="nickname" maxLength={80} value={name}
        onChange={event => setName(event.target.value)} /></label>
      {picture && <img className="profile-preview" alt="Profile picture preview" src={picture} />}
      <label>Profile picture<input type="file" accept="image/jpeg,image/png,image/webp" onChange={event => {
        void choosePicture(event.target.files?.[0]); event.target.value = "";
      }} /></label>
      {picture && <button className="profile-edit" type="button" onClick={() => setPicture(null)}>Remove picture</button>}
      <button type="submit" className="account-action">{saving ? "Saving…" : "Save profile"}</button>
      <button type="button" className="profile-edit" onClick={() => setEditing(false)}>Cancel</button>
    </fieldset>
    {reading && <p role="status">Preparing picture…</p>}
    {error && <p className="account-error" role="alert">{error}</p>}
  </form>;
}
