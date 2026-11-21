import { useEffect, useLayoutEffect, useRef, useState, type FormEvent } from "react";
import { grades, makeOutbox, makeReviewSession, type Grade, type Outbox, type ReviewSession, type ReviewView } from "./review-session.ts";
import { RecallApiError, type RecallApi } from "./recall-api.ts";

const gradeLabels = ["Again", "Hard", "Good", "Easy"] as const;
const emptyQueue = { pending: 0, retry: 0, conflict: 0, unavailable: false };
type Runtime = {
  owner: string;
  active: boolean;
  request: number;
  box: Outbox;
  review: ReviewSession | null;
  lastGrade: number;
};

export function App({ api }: { api: RecallApi | null }) {
  const [owner, setOwner] = useState<string | null | undefined>(undefined);
  const [snapshot, setSnapshot] = useState<{ owner: string; view: ReviewView } | null>(null);
  const view = snapshot?.owner === owner ? snapshot?.view ?? null : null;
  const [queue, setQueue] = useState(emptyQueue);
  const [deckMessage, setDeckMessage] = useState("");
  const [signInMessage, setSignInMessage] = useState("");
  const [signingIn, setSigningIn] = useState(false);
  const runtime = useRef<Runtime | null>(null);
  const front = useRef<HTMLHeadingElement>(null);
  const answer = useRef<HTMLParagraphElement>(null);
  const pendingFocus = useRef<"front" | "answer" | null>(null);

  useEffect(() => api?.observeOwner(setOwner), [api]);
  useLayoutEffect(() => {
    const target = pendingFocus.current;
    if (target) (target === "front" ? front : answer).current?.focus({ preventScroll: true });
    pendingFocus.current = null;
  }, [view]);

  function queueState(box: Outbox) {
    try {
      const entries = box.entries();
      const count = (status: typeof entries[number]["status"]) => entries.filter((entry) => entry.status === status).length;
      setQueue({ pending: count("pending"), retry: count("failed"), conflict: count("conflict"), unavailable: false });
    } catch { setQueue({ ...emptyQueue, unavailable: true }); }
  }

  function flush(state: Runtime) {
    void state.box.flush().catch(() => {
      if (state.active) setQueue({ ...emptyQueue, unavailable: true });
    });
  }

  async function loadDue(client: RecallApi, state: Runtime) {
    const generation = ++state.request;
    setDeckMessage("Loading due cards…");
    let loaded;
    try { loaded = await client.due(); }
    catch (error) {
      if (!state.active || generation !== state.request) return;
      state.review = null;
      setSnapshot(null);
      setDeckMessage(error instanceof RecallApiError && error.status === 403
        ? "This account is not the configured deck owner." : "Could not load cards. Try again.");
      return;
    }
    if (!state.active || generation !== state.request) return;
    try {
      const blocked = new Set(state.box.entries().map((item) => item.event.card_id));
      state.review = makeReviewSession(loaded.filter((card) => !blocked.has(card.card_id)), (event) => state.box.enqueue(event));
      setSnapshot({ owner: state.owner, view: state.review.view() });
      setDeckMessage("");
      queueState(state.box);
      flush(state);
    } catch {
      state.review = null;
      setSnapshot(null);
      setDeckMessage("Browser storage is unavailable. Ratings cannot be safely queued.");
    }
  }

  useEffect(() => {
    setSnapshot(null);
    setQueue(emptyQueue);
    setDeckMessage("");
    if (!api || !owner) return;
    try {
      const state: Runtime = {
        owner, active: true, request: 0, review: null, lastGrade: -Infinity,
        box: makeOutbox({
          storage: window.localStorage,
          prefix: `recall.live.v1.${api.origin}.${owner}.`,
          send: (event) => api.grade(event),
          active: () => state.active,
          onChange: () => queueState(state.box)
        })
      };
      runtime.current = state;
      queueState(state.box);
      void loadDue(api, state);
      return () => {
        state.active = false;
        if (runtime.current === state) runtime.current = null;
      };
    } catch {
      setDeckMessage("Browser storage is unavailable. Ratings cannot be safely queued.");
    }
  }, [api, owner]);

  function reveal() {
    const state = runtime.current;
    if (!state?.review?.reveal()) return;
    pendingFocus.current = "answer";
    setSnapshot({ owner: state.owner, view: state.review.view() });
  }
  function rate(value: Grade) {
    const state = runtime.current;
    if (!state?.review || performance.now() - state.lastGrade < 230) return;
    try {
      if (!state.review.rate(value)) return;
      state.lastGrade = performance.now();
      pendingFocus.current = "front";
      setSnapshot({ owner: state.owner, view: state.review.view() });
      queueState(state.box);
      flush(state);
    } catch { setDeckMessage("Could not queue this rating. The card has not advanced."); }
  }

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      const state = runtime.current?.review?.view();
      const target = event.target;
      if (!state?.current || event.repeat || event.altKey || event.ctrlKey || event.metaKey || event.isComposing
          || (target instanceof Element && target.closest("input,textarea,select,[contenteditable]"))) return;
      if (event.key === " " || event.key === "Enter") {
        if (target instanceof Element && target.closest("button,a")) return;
        event.preventDefault();
        if (state.revealed) rate("medium");
        else reveal();
      } else if (state.revealed && /^[1-4]$/.test(event.key)) {
        event.preventDefault();
        rate(grades[Number(event.key) - 1]);
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  async function signIn(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!api || signingIn) return;
    const form = event.currentTarget;
    const data = new FormData(form);
    setSigningIn(true);
    setSignInMessage("Signing in…");
    try {
      const id = await api.signIn(String(data.get("email") ?? ""), String(data.get("password") ?? ""));
      if (!id) throw new Error("Missing session");
      form.reset();
      setSignInMessage("");
      setOwner(id);
    } catch { setSignInMessage("Sign-in failed. Check the owner account credentials."); }
    finally { setSigningIn(false); }
  }
  async function signOut() {
    try {
      await api?.signOut();
      if (runtime.current) runtime.current.active = false;
      setOwner(null);
    } catch { setDeckMessage("Could not sign out. Try again."); }
  }
  function reload() {
    if (api && runtime.current) void loadDue(api, runtime.current);
  }
  function retry() {
    const state = runtime.current;
    if (!state) return;
    try {
      void state.box.retry().catch(() => {
        if (state.active) setQueue({ ...emptyQueue, unavailable: true });
      });
    }
    catch { setQueue({ ...emptyQueue, unavailable: true }); }
  }
  function dismissConflicts() {
    const state = runtime.current;
    if (!state) return;
    try { state.box.dismissConflicts(); reload(); }
    catch { setQueue({ ...emptyQueue, unavailable: true }); }
  }

  const status = queue.unavailable ? "Browser storage is unavailable. Ratings cannot be safely queued here." : [
    queue.pending && `Saving ${queue.pending}…`,
    queue.retry && `${queue.retry} need a retry`,
    queue.conflict && `${queue.conflict} cannot be saved; reload due cards`
  ].filter(Boolean).join(" · ") || "No unsaved ratings";
  const current = view?.current;

  return <main className="shell">
    <header>
      <div className="brand">
        <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65">
          <rect x="6" y="4" width="13" height="16" rx="2.4" />
          <path d="M3 7v12a4 4 0 0 0 4 4h9M9.5 9h6M9.5 13h4" />
        </svg>
        <span>Recall</span>
      </div>
      <span className="badge">Connected sample</span>
    </header>

    {!api && <p className="status" role="status">The connected sample is not configured.</p>}
    {api && owner === undefined && <p className="status" role="status">Checking your session…</p>}
    {api && owner === null && <form className="login" onSubmit={signIn}>
      <h1>Sign in to Recall</h1>
      <p>Use the owner account for this sample deck.</p>
      <label>Email <input type="email" name="email" required autoComplete="username" /></label>
      <label>Password <input type="password" name="password" required autoComplete="current-password" /></label>
      <button type="submit" className="secondary" disabled={signingIn}>Sign in</button>
      <p role="status">{signInMessage}</p>
    </form>}

    {api && owner && <section aria-label="Review session">
      <div className="row"><p className="status" role="status">{deckMessage}</p><button type="button" className="secondary" onClick={() => void signOut()}>Sign out</button></div>
      <div className="progressline">
        <span>{view && (view.done ? `${view.total} of ${view.total} reviewed` : `Card ${view.index + 1} of ${view.total}`)}</span>
        <span>Sample deck</span>
      </div>
      <div className="progress" aria-hidden="true" style={{ gridTemplateColumns: view?.total ? `repeat(${view.total},1fr)` : undefined }}>
        {view && Array.from({ length: view.total }, (_, i) => <span key={i} className={i < view.index ? "done" : i === view.index ? "current" : undefined} />)}
      </div>
      <section className="review-card" aria-labelledby="front">
        <p className="eyebrow">{current ? "Question" : "Sample deck"}</p>
        <h1 id="front" ref={front} tabIndex={-1}>{!view ? "Ready to load cards" : current ?? (view.total ? "That’s all for this round." : "No cards due now.")}</h1>
        {view?.revealed && <div id="back" className="answer-side">
          <p className="eyebrow">Answer</p>
          <p ref={answer} tabIndex={-1}>{view.answer}</p>
        </div>}
      </section>
      {current && <div className="review-action">
        {!view?.revealed ? <button type="button" className="primary" onClick={reveal} aria-keyshortcuts="Space Enter">Show answer</button>
          : <section aria-label="Rate your recall" className="ratings">
            {grades.map((value, i) => <button key={value} type="button" onClick={() => rate(value)}
              aria-keyshortcuts={value === "medium" ? "3 Space Enter" : String(i + 1)}>{gradeLabels[i]}</button>)}
          </section>}
      </div>}
      {!current && <section className="complete"><button type="button" className="secondary" onClick={reload} disabled={Boolean(queue.pending || queue.retry || queue.conflict)}>Load due cards</button></section>}
      <footer className="footer">
        <div className="saver">
          <p className={queue.conflict || queue.retry || queue.unavailable ? "status error" : "status"} role="status">{status}</p>
          {queue.retry > 0 && <button type="button" className="secondary" onClick={retry}>Retry save</button>}
        </div>
        {queue.conflict > 0 && <button type="button" className="secondary" onClick={dismissConflicts}>Dismiss and load due cards</button>}
      </footer>
    </section>}
  </main>;
}
