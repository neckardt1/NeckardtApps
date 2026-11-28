import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { grades, type Grade } from './review-session.ts';
import { RecallApiError, type ActionEvent, type RecallApi } from './recall-api.ts';
import { allAnswered, currentKey, makeDurableSession, type DurableSession, type Round } from './durable-session.ts';
import { useSiteSession } from '../../shell/session.tsx';
import { FormattedText } from './FormattedText.tsx';
import { RatingButtons } from './RatingButtons.tsx';

type Runtime = { fallback: boolean; server: boolean; active: boolean; owner: string; store: DurableSession; request: number; sessionIsCurrent: () => boolean };
export function App({ api, onHome }: { api: RecallApi | null; onHome?: () => void }) {
  const session = useSiteSession();
  const sessionIsCurrent = session.isCurrent;
  const owner = session.status === 'signed-in' ? session.user?.id ?? null : null;
  const [snapshot, setSnapshot] = useState<{ owner: string; round: Round } | null>(null);
  const round = snapshot && snapshot.owner === owner ? snapshot.round : null;
  const [message, setMessage] = useState('');
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
  }, [snapshot]);

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
      let existing = state.store.read();
      if (existing?.finished) {
        await state.store.clearFinished(existing.id);
        if (!isCurrent(state)) return;
        if (api.rounds && !state.server && !state.fallback) {
          resetStorage(value => value + 1);
          return;
        }
        existing = state.store.read();
      }
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
    setSnapshot(null); setMessage(''); setBusy(false); setLoading(false);
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
        if (!value) void load(state);
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
      if (!round || round.finished || busy || document.querySelector('[data-popover-open]')) return;
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
  }, [round, busy]);

  const opportunity = round?.opportunities[round.opportunityIndex];
  const card = round?.cards[round.cardIndex];
  const pending = round?.saves.filter(s => s.status === 'pending').length ?? 0;
  const failed = round?.saves.filter(s => s.status === 'failed').length ?? 0;
  const conflict = round?.saves.filter(s => s.status === 'conflict').length ?? 0;
  const hasWork = !!round && !!(round.cards.length || round.opportunities.length || round.saves.length);
  const saveStatus = pending ? `Saving ${pending}…` : failed ? `${failed} ${failed === 1 ? 'save needs' : 'saves need'} a retry.`
    : conflict ? 'A card changed. This review needs reconciliation before it can finish.' : '';
  const reviewedCount = round?.summary?.reviews ?? round?.cardIndex ?? 0;
  const actionCount = round?.summary?.actions ?? round?.opportunityIndex ?? 0;
  const superseded = round?.summary?.superseded ?? 0;
  const otherDevice = round?.saves.some(save => save.status === 'superseded');
  const showReview = !!round && hasWork && !round.finished;

  const homeButton = onHome && <button className="text-button deck-back" disabled={busy} onClick={onHome}>← Practice home</button>;

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
        {(!showReview || (!opportunity && !card)) && homeButton}
        <div ref={content} tabIndex={-1} className="screen-content">
          {round?.finished ? <div className="saved-screen">
            <h1>Saved.</h1>
            <p>{actionCount} {actionCount === 1 ? 'habit check' : 'habit checks'} · {reviewedCount} {reviewedCount === 1 ? 'card reviewed' : 'cards reviewed'}</p>
            <p className="muted">{superseded ? `${superseded} ${superseded === 1 ? 'item was' : 'items were'} superseded before completion.` : 'Every response has been saved.'}</p>
          </div> : showReview ? <>
            {opportunity ? <div className="review-card">
              <div className="review-heading">{opportunity.cue && <p className="eyebrow">{opportunity.cue}</p>}{homeButton}</div>
              <h1 className="prompt">{opportunity.prompt}</h1>
            </div> : card ? <div className="review-card">
              <div className="review-heading"><p className="eyebrow">Card {round.cardIndex + 1} of {round.cards.length}</p>{homeButton}</div>
              <h1 className="prompt">{card.front}</h1>
              {round.revealed && <div className="answer-panel" aria-label="Answer"><FormattedText text={card.back} /></div>}
            </div> : <div className="today-card">
              <h1>Saving your round…</h1>
              <p>Your responses are kept on this device until saving completes.</p>
            </div>}
          </> : <div className="today-card">
            <h1>Today</h1>
            {loading ? <p role="status">Loading your review…</p> : round ? <p>No cards due right now.</p> : <p>Your review will appear here.</p>}
          </div>}
        </div>
        {(message || saveStatus || otherDevice) && <div className="save-messages" aria-live="polite">
          {message && <p className="status error">{message}</p>}
          {saveStatus && <p className="status">{saveStatus}</p>}
          {(failed > 0 || (message && (pending > 0 || (showReview && allAnswered(round))))) && <button className="text-button" disabled={busy} onClick={() => void mutate(store => store.retry(), false)}>Retry save</button>}
          {otherDevice && <p className="status">Another saved result took precedence over an answer on this device.</p>}
          {conflict > 0 && <p className="status">The unsaved response is preserved. Do not clear browser data.</p>}
          {round?.server && conflict > 0 && <button className="text-button" disabled={busy} onClick={() => void mutate(store => store.syncRound(), false)}>Check saved answers</button>}
        </div>}
        <div className="action-dock">
          {round?.finished ? <button className="primary" disabled={busy} onClick={() => void mutate(async (store, state) => {
            await store.clearFinished(round.id);
            if (!isCurrent(state)) return;
            if (api.rounds && !state.server) {
              setLegacyScope(null);
              resetStorage(value => value + 1);
            } else await load(state);
          })}>Check again</button> : showReview ? opportunity ? <div className="choices">
            <button className="secondary" disabled={busy} onClick={() => answer('yes')}>Yes</button>
            <button className="secondary" disabled={busy} onClick={() => answer('no')}>No</button>
            <button className="secondary" disabled={busy} onClick={() => answer('no_opportunity')}>No opportunity</button>
            <button className="text-button" disabled={busy} onClick={() => answer('skip')}>Skip</button>
          </div> : card ? <RatingButtons
            key={`${owner}.${round.id}.${card.card_id}.${card.revision}`} cardId={card.card_id} revision={card.revision}
            preview={api.preview} revealed={round.revealed} reveal={reveal} disabled={busy} rate={rate} />
            : null
            : <button className="secondary" disabled={busy || loading} onClick={() => {
              if (runtime.current?.fallback) setLegacyScope(null);
              else if (runtime.current) void load(runtime.current);
            }}>Check again</button>}
        </div>
      </>}
    </section>;
}
