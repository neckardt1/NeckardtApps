import { useEffect, useId, useState } from "react";

export type UndoToast = { text: string; eventId?: string };

export function TaskToast({ toast, busy, dismiss, undo }: {
  toast: UndoToast; busy: boolean; dismiss: () => void; undo: () => void;
}) {
  const description = useId();
  const [shownAt] = useState(Date.now);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  useEffect(() => {
    if (busy) return;
    // Leave a margin inside the server's two-minute receipt lifetime for a focused control.
    const remaining = Math.max(0, shownAt + 110_000 - Date.now());
    const timeout = window.setTimeout(dismiss, focused || hovered ? remaining : Math.min(10_000, remaining));
    return () => window.clearTimeout(timeout);
  }, [shownAt, busy, focused, hovered, dismiss]);
  return <div className="tasks-toast"
    onPointerEnter={event => setHovered(event.pointerType === "mouse")} onPointerLeave={() => setHovered(false)}
    onFocus={() => setFocused(true)} onBlur={event => setFocused(event.currentTarget.contains(event.relatedTarget))}
    onKeyDown={event => { if (event.key === "Escape") dismiss(); }}>
    <span id={description}>{toast.text}</span>{toast.eventId && <button type="button" onClick={undo} aria-describedby={description} disabled={busy}>Undo</button>}
  </div>;
}
