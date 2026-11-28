import { useState, type FormEvent } from "react";
import { makeThumbnail, type AccountProfile } from "./profile.ts";

type Props = {
  profile: AccountProfile;
  saving: boolean;
  onSave(changes: Partial<AccountProfile>): Promise<void>;
};

export function ProfileEditor({ profile, saving, onSave }: Props) {
  const [name, setName] = useState(profile.display_name);
  const [picture, setPicture] = useState(profile.picture);
  const [reading, setReading] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  const dirty = name.trim() !== profile.display_name || picture !== profile.picture;

  function resetDraft() {
    setName(profile.display_name);
    setPicture(profile.picture);
    setMessage("");
    setError("");
  }

  async function choosePicture(file?: File) {
    if (!file) return;
    setReading(true); setError(""); setMessage("");
    try { setPicture(await makeThumbnail(file)); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Unable to read this picture."); }
    finally { setReading(false); }
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!dirty || reading || saving) return;
    setError("");
    const changes: Partial<AccountProfile> = {};
    if (name.trim() !== profile.display_name) changes.display_name = name.trim();
    if (picture !== profile.picture) changes.picture = picture;
    try {
      await onSave(changes);
      setName(name.trim()); setMessage("Profile saved.");
    } catch { setError("Unable to save your profile. Please try again."); }
  }

  return <form className="account-form profile-form" onSubmit={save}>
    <fieldset disabled={reading || saving}>
      <legend className="visually-hidden">Profile details</legend>
      <label>Account name<input autoComplete="nickname" maxLength={80} value={name}
        onChange={event => { setName(event.target.value); setMessage(""); }} /></label>
      {picture && <img className="profile-preview" alt="Profile picture preview" src={picture} />}
      <label>Profile picture<input type="file" accept="image/jpeg,image/png,image/webp" onChange={event => {
        void choosePicture(event.target.files?.[0]); event.target.value = "";
      }} /></label>
      {picture && <button className="profile-edit" type="button" onClick={() => { setPicture(null); setMessage(""); setError(""); }}>Remove picture</button>}
      <div className="profile-form-actions">
        <button type="submit" disabled={!dirty} className="account-action">{saving ? "Saving…" : "Save profile"}</button>
        {dirty && <button type="button" className="profile-edit" onClick={resetDraft}>Cancel</button>}
      </div>
    </fieldset>
    {message && <p role="status">{message}</p>}
    {reading && <p role="status">Preparing picture…</p>}
    {error && <p className="account-error" role="alert">{error}</p>}
  </form>;
}
