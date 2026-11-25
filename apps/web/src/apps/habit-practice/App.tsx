import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useLocation } from 'react-router';
import { grades, type Grade } from './review-session.ts';
import { RecallApiError, type ActionEvent, type RecallApi } from './recall-api.ts';
import { allAnswered, currentKey, makeDurableSession, verified, type DurableSession, type Round } from './durable-session.ts';
import { useSiteSession } from '../../shell/session.tsx';
import { FormattedText } from './FormattedText.tsx';

const gradeLabels = ['Again', 'Hard', 'Good', 'Easy'];
type Runtime = { fallback: boolean; server: boolean; active: boolean; owner: string; store: DurableSession; request: number; sessionIsCurrent: () => boolean };
export function App({ api }: { api: RecallApi | null }) {
  const session = useSiteSession();
  const fromDot = new URLSearchParams(useLocation().search).get('dot') === '1';
  const sessionIsCurrent = session.isCurrent;
  const owner = session.status === 'signed-in' ? session.user?.id ?? null : null;
  const [snapshot, setSnapshot] = useState<{ owner: string; round: Round } | null>(null);
  const round = snapshot && snapshot.owner === owner ? snapshot.round : null;
  const [screen, setScreen] = useState<'today' | 'review'>('today');
  const [message, setMessage] = useState('');
  const [debrief, setDebrief] = useState<{ owner: string; roundId: string } | null>(null);
  const armed = !!round && debrief?.owner === owner && debrief?.roundId === round.id;
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const [legacyScope, setLegacyScope] = useState<string | null>(null);
  const [storageGeneration, resetStorage] = useState(0);
  const runtime = useRef<Runtime | null>(null);
  const content = useRef<HTMLDivElement>(null);
  const focusNext = useRef(false);

  useLayoutEffect(() => {
    if (focusNext.current) {
      content.current?.focus({ preventScroll: true });
      focusNext.current = false;
      window.scrollTo?.({ top: 0 });
    }
  }, [snapshot, screen]);

  function isCurrent(state: Runtime) { return state.active && runtime.current === state && state.sessionIsCurrent(); }
  function report(error: unknown, fallback: string) {
    setMessage(error instanceof RecallApiError ? error.message : fallback);
  }
  function flush(state: Runtime) {
    void state.store.flush().catch(() => {
      if (isCurrent(state)) setMessage('Your review is kept on this device. Saving is paused; try again.');
    });
  }
  async function load(state: Runtime) {
    if (!api || !isCurrent(state)) return;
    const generation = ++state.request;
    setLoading(true);
    setMessage('');
    try {
      const existing = state.store.read();
      if (state.server) {
        if (existing) setSnapshot({ owner: state.owner, round: existing });
        if (await state.store.syncRound() === 'use-legacy') {
          if (isCurrent(state)) setLegacyScope(`${api.origin}.${state.owner}`);
          return;
        }
      } else if (existing && (existing.started || existing.cards.length || existing.opportunities.length || existing.saves.length)) {
        if (!isCurrent(state)) return;
        setSnapshot({ owner: state.owner, round: existing });
      } else {
        const [cards, opportunities] = api.rounds && !state.fallback ? [[], []] : await Promise.all([api.due(), api.opportunities?.() ?? Promise.resolve([])]);
        if (!isCurrent(state) || generation !== state.request) return;
        await state.store.initialize(cards, opportunities, `recall.live.v1.${api.origin}.${state.owner}.`);
      }
      if (isCurrent(state)) flush(state);
    } catch (error) {
      if (isCurrent(state) && generation === state.request) report(error, 'Could not safely load this review. Your saved browser data has been kept.');
    } finally { if (isCurrent(state) && generation === state.request) setLoading(false); }
  }
  // Retire the old owner's queue at commit, before passive effects or input.
  useLayoutEffect(() => {
    focusNext.current = false;
    setDebrief(null); setSnapshot(null); setScreen('today'); setMessage(''); setBusy(false); setLoading(false);
    if (!api || !owner) return;
    const legacyKey = `recall.round.v2.${api.origin}.${owner}`;
    const legacyPrefix = `recall.live.v1.${api.origin}.${owner}.`;
    const fallback = legacyScope === `${api.origin}.${owner}`;
    let server = !!api.rounds && !fallback;
    if (server) {
      try {
        const old = JSON.parse(window.localStorage.getItem(legacyKey) || 'null');
        // A pre-upgrade browser round must send its original event IDs first.
        const empty = old?.version === 2 && old.started === false && old.finished === false
          && [old.cards, old.opportunities, old.saves].every(value => Array.isArray(value) && value.length === 0);
        const hasOutbox = Object.keys(window.localStorage).some(name => name.startsWith(legacyPrefix));
        if ((old !== null && !empty) || hasOutbox) server = false;
      } catch { setMessage('Stored review needs recovery. Keep this browser data.'); return; }
    }
    const key = server ? `recall.round.v3.${api.origin}.${owner}` : legacyKey;
    const state: Runtime = { fallback, server, owner, active: true, request: 0, store: null!, sessionIsCurrent };
    try {
      state.store = makeDurableSession({ storage: window.localStorage, key, api,
        active: () => isCurrent(state),
        onChange: value => { if (isCurrent(state)) setSnapshot(value ? { owner, round: value } : null); }
      });
      runtime.current = state;
      void load(state);
    } catch { setMessage('Browser storage is unavailable. Reviews cannot safely advance.'); }
    const onStorage = (event: StorageEvent) => {
      if (!isCurrent(state) || (event.key !== key && event.key !== null)) return;
      try {
        const value = state.store.read();
        setSnapshot(value ? { owner, round: value } : null);
        if (!value) { setScreen('today'); void load(state); }
      } catch { setMessage('Stored review needs recovery. Keep this browser data.'); }
    };
    const onOnline = () => {
      if (!isCurrent(state)) return;
      void state.store.retry().catch(() => { if (isCurrent(state)) setMessage('Saving is paused. Try again.'); });
    };
    window.addEventListener('storage', onStorage);
    window.addEventListener('online', onOnline);
    return () => {
      state.active = false;
      if (runtime.current === state) runtime.current = null;
      window.removeEventListener('storage', onStorage);
      window.removeEventListener('online', onOnline);
    };
  }, [api, owner, sessionIsCurrent, storageGeneration, legacyScope]);

  async function mutate(operation: (store: DurableSession, state: Runtime) => Promise<unknown>, focus = true) {
    const state = runtime.current;
    if (!state || !isCurrent(state) || busy) return;
    setBusy(true); setMessage('');
    try {
      focusNext.current = focus;
      await operation(state.store, state);
      if (isCurrent(state)) flush(state);
    } catch { if (isCurrent(state)) setMessage('Could not safely save this step. It has not been discarded. Try again.'); }
    finally { if (isCurrent(state)) setBusy(false); }
  }
  async function armDebrief() {
    const state = runtime.current;
    if (!state || !isCurrent(state) || !round?.server || round.finished || busy || !api?.armDebrief) return;
    setBusy(true); setMessage('');
    try {
      await api.armDebrief(round.id);
      if (isCurrent(state)) setDebrief({ owner: state.owner, roundId: round.id });
    } catch {
      if (isCurrent(state)) setMessage('Could not confirm the Dot debrief. Retry or continue your review.');
    } finally {
      if (isCurrent(state)) setBusy(false);
    }
  }
  function start() {
    if (!round) return;
    void mutate(async (store, state) => {
      const changed = await store.start(round.id);
      if (changed && isCurrent(state)) setScreen('review');
    });
  }
  function reveal() {
    const id = round && currentKey(round);
    if (round && id) void mutate(store => store.reveal(round.id, id));
  }
  function rate(grade: Grade) {
    const id = round && currentKey(round);
    if (round && id) void mutate(store => store.rate(round.id, id, grade));
  }
  function answer(outcome: ActionEvent['outcome']) {
    const id = round && currentKey(round);
    if (round && id) void mutate(store => store.answer(round.id, id, outcome));
  }
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (screen !== 'review' || !round || round.finished || busy || document.querySelector('[data-popover-open]')) return;
      if (round.opportunityIndex < round.opportunities.length || allAnswered(round)) return;
      const target = event.target;
      if (event.repeat || event.altKey || event.ctrlKey || event.metaKey || event.isComposing
        || (target instanceof Element && target.closest('input,textarea,select,[contenteditable]'))) return;
      if ((event.key === ' ' || event.key === 'Enter') && !round.revealed) {
        if (target instanceof Element && target.closest('button,a')) return;
        event.preventDefault(); reveal();
      } else if (round.revealed && /^[1-4]$/.test(event.key)) {
        event.preventDefault(); rate(grades[Number(event.key) - 1]);
      }
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [round, screen, busy]);

  const opportunity = round?.opportunities[round.opportunityIndex];
  const card = round?.cards[round.cardIndex];
  const pending = round?.saves.filter(s => s.status === 'pending').length ?? 0;
  const failed = round?.saves.filter(s => s.status === 'failed').length ?? 0;
  const conflict = round?.saves.filter(s => s.status === 'conflict').length ?? 0;
  const remainingCards = round ? round.cards.length - round.cardIndex : 0;
  const remainingHabits = round ? round.opportunities.length - round.opportunityIndex : 0;
  const hasWork = !!round && !!(round.cards.length || round.opportunities.length || round.saves.length);
  const saveStatus = pending ? `Saving ${pending}…` : failed ? `${failed} ${failed === 1 ? 'save needs' : 'saves need'} a retry.`
    : conflict ? 'A card changed. This review needs reconciliation before it can finish.' : '';
  const reviewedCount = round?.summary?.reviews ?? round?.cardIndex ?? 0;
  const actionCount = round?.summary?.actions ?? round?.opportunityIndex ?? 0;
  const superseded = round?.summary?.superseded ?? 0;
  const otherDevice = round?.saves.some(save => save.status === 'superseded');
  const showReview = !!round && screen === 'review' && !round.finished;

  return <section className="habit-practice" aria-label="Review session">
      {!api && <div className="today-card"><h1>Unavailable</h1><p>This app is not configured.</p></div>}
      {api && session.status === 'loading' && <p className="status" role="status">Checking your session…</p>}
      {api && session.status === 'unavailable' && <div className="today-card">
        <h1>Account unavailable.</h1><p>Open Account for details, then try again.</p>
      </div>}
      {api && session.status === 'signed-out' && <div className="today-card">
        <h1>Welcome back.</h1><p>Open Account to sign in and review your cards.</p>
      </div>}
      {api && owner && <>
        <div ref={content} tabIndex={-1} className="screen-content">
          {round?.finished ? <div className="saved-screen">
            <h1>Saved.</h1>
            <p>{actionCount} {actionCount === 1 ? 'habit check' : 'habit checks'} · {reviewedCount} {reviewedCount === 1 ? 'card reviewed' : 'cards reviewed'}</p>
            <p className="muted">{superseded ? `${superseded} ${superseded === 1 ? 'item was' : 'items were'} superseded before completion.` : 'Every response has been saved.'}</p>
            <a className="debrief-link" href="https://chatgpt.com/" target="_blank" rel="noopener noreferrer">Debrief with Dot</a>
            <p className="status">{armed ? 'You requested a debrief in your Dot chat.' : 'Optional. Open your chat and ask for a debrief.'}</p>
          </div> : showReview ? <>
            {opportunity ? <div className="review-card">
              {opportunity.cue && <p className="eyebrow">{opportunity.cue}</p>}
              <h1 className="prompt">{opportunity.prompt}</h1>
            </div> : card ? <div className="review-card">
              <p className="eyebrow">Card {round.cardIndex + 1} of {round.cards.length}</p>
              <h1 className="prompt">{card.front}</h1>
              {round.revealed && <div className="answer-panel" aria-label="Answer"><FormattedText text={card.back} /></div>}
            </div> : <div className="today-card">
              <h1>Ready to finish.</h1>
              <p>{verified(round) ? 'Your responses are saved.' : 'Your responses are kept on this device while they save.'}</p>
              <p className="muted">Finish when you’re ready.</p>
            </div>}
          </> : <div className="today-card">
            <h1>Today</h1>
            {loading ? <p role="status">Loading your review…</p> : round ? <>
              <p>{hasWork ? [remainingHabits ? `${remainingHabits} ${remainingHabits === 1 ? 'habit check' : 'habit checks'}` : '', `${remainingCards} ${remainingCards === 1 ? 'card' : 'cards'}`].filter(Boolean).join(' and ') + (round.started ? ' left in this round.' : ' in this round.') : 'No cards due right now.'}</p>
              {round.started && <p className="muted">Pick up where you left off.</p>}
            </> : <p>Your review will appear here.</p>}
          </div>}
        </div>
        {fromDot && !loading && round?.server && !round.finished && hasWork && api.armDebrief &&
          (screen === 'today' || allAnswered(round)) && <div className="save-messages">
            {armed ? <p className="status" role="status">Debrief requested for this round.</p> : <>
              <p className="status">Share this round’s card prompts, answers, grades, review times and due dates with your connected Dot when you finish.</p>
              <button className="text-button" disabled={busy} onClick={() => void armDebrief()}>Request Dot debrief</button>
            </>}
          </div>}
        {(message || saveStatus || otherDevice) && <div className="save-messages" aria-live="polite">
          {message && <p className="status error">{message}</p>}
          {saveStatus && <p className="status">{saveStatus}</p>}
          {(failed > 0 || (message && pending > 0)) && <button className="text-button" disabled={busy} onClick={() => void mutate(store => store.retry(), false)}>Retry save</button>}
          {otherDevice && <p className="status">Another saved result took precedence over an answer on this device.</p>}
          {conflict > 0 && <p className="status">The unsaved response is preserved. Do not clear browser data.</p>}
          {round?.server && conflict > 0 && <button className="text-button" disabled={busy} onClick={() => void mutate(store => store.syncRound(), false)}>Check saved answers</button>}
        </div>}
        <div className="action-dock">
          {round?.finished ? <button className="primary" disabled={busy} onClick={() => void mutate(async (store, state) => {
            await store.clearFinished(round.id);
            if (!isCurrent(state)) return;
            setScreen('today');
            if (api.rounds && !state.server) {
              setLegacyScope(null);
              resetStorage(value => value + 1);
            } else await load(state);
          })}>Done</button> : showReview ? opportunity ? <div className="choices">
            <button className="secondary" disabled={busy} onClick={() => answer('yes')}>Yes</button>
            <button className="secondary" disabled={busy} onClick={() => answer('no')}>No</button>
            <button className="secondary" disabled={busy} onClick={() => answer('no_opportunity')}>No opportunity</button>
            <button className="text-button" disabled={busy} onClick={() => answer('skip')}>Skip</button>
          </div> : card ? round.revealed ? <div className="ratings" aria-label="Rate your recall">
            {grades.map((grade, i) => <button className="secondary" key={grade} disabled={busy} onClick={() => rate(grade)} aria-keyshortcuts={String(i + 1)}>{gradeLabels[i]}</button>)}
          </div> : <button className="primary" disabled={busy} onClick={reveal} aria-keyshortcuts="Space Enter">Reveal answer</button>
            : <button className="primary" disabled={busy || !verified(round)} onClick={() => void mutate(store => store.finish(round.id))}>Finish</button>
            : hasWork ? <button className="primary" disabled={busy || loading} onClick={start}>{round?.started ? 'Resume review' : 'Start review'}</button>
            : <button className="secondary" disabled={busy || loading} onClick={() => {
              if (runtime.current?.fallback) setLegacyScope(null);
              else if (runtime.current) void load(runtime.current);
            }}>Check again</button>}
        </div>
      </>}
    </section>;
}
