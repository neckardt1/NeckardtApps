import { useLayoutEffect, useState } from 'react';
import { useSiteSession } from '../../shell/session.tsx';
import { App } from './App.tsx';
import { CardBrowser } from './CardBrowser.tsx';
import { unfinished, readStoredRound, verified, type Round } from './durable-session.ts';
import { defaultReviewLimit, type RecallApi, type RoundPreview } from './recall-api.ts';
import { restoreRound } from './server-round.ts';

type Status =
  | { kind: 'checking' | 'unavailable' }
  | { kind: 'start'; preview: RoundPreview; completedRoundId?: string }
  | { kind: 'continue'; detail: string };

function count(value: number, singular: string) {
  return `${value} ${singular}${value === 1 ? '' : 's'}`;
}

function resume(round: Round): Status {
  const remaining = round.cards.length - round.cardIndex;
  const actions = round.opportunities.length - round.opportunityIndex;
  const unsaved = round.saves.filter(save => save.status !== 'saved' && save.status !== 'superseded').length;
  let detail = remaining || actions ? `${count(actions, 'check-in')} · ${count(remaining, 'recall card')} left` : 'Finishing this round.';
  if (round.saves.some(save => save.status === 'conflict')) detail += ' · A saved answer needs attention';
  else if (unsaved) detail += ` · ${count(unsaved, 'answer')} to sync on this device`;
  return { kind: 'continue', detail };
}

async function roundStatus(api: RecallApi, owner: string, isCurrent: () => boolean): Promise<Status> {
  const scope = `${api.origin}.${owner}`;
  const legacy = readStoredRound(localStorage, `recall.round.v2.${scope}`);
  if (unfinished(legacy)) return resume(legacy);
  if (Object.keys(localStorage).some(key => key.startsWith(`recall.live.v1.${scope}.`))) {
    return { kind: 'continue', detail: 'This device has answers to sync.' };
  }
  const local = readStoredRound(localStorage, `recall.round.v3.${scope}`);
  if (unfinished(local) && !verified(local)) return resume(local);
  try {
    const rows = await api.rounds?.latest();
    if (rows?.length && rows[0].finished_at === null) {
      if (unfinished(local) && local.id !== rows[0].round_id) return { kind: 'continue', detail: 'Reconcile the saved round on this device.' };
      return resume(restoreRound(rows, local?.id === rows[0].round_id ? local : null));
    }
    const completedRoundId = rows?.[0]?.finished_at ? rows[0].round_id : undefined;
    if (unfinished(local, completedRoundId)) {
      return { kind: 'continue', detail: 'Check the saved result for this round.' };
    }
    if (!api.roundPreview || !isCurrent()) throw Error('Round preview unavailable');
    return { kind: 'start', preview: await api.roundPreview(), completedRoundId };
  } catch (error) {
    if (unfinished(local)) return resume(local);
    throw error;
  }
}

export function PracticeDeck({ api }: { api: RecallApi | null }) {
  const session = useSiteSession();
  return api && session.status === 'signed-in' && session.user
    ? <Deck key={session.user.id} api={api} owner={session.user.id} />
    : <App api={api} />;
}

function Deck({ api, owner }: { api: RecallApi; owner: string }) {
  const { isCurrent } = useSiteSession();
  const [screen, setScreen] = useState<'home' | 'browse' | 'review'>('home');
  const [status, setStatus] = useState<Status>({ kind: 'checking' });
  const [reviewLimit, setReviewLimit] = useState(defaultReviewLimit);
  const [refresh, setRefresh] = useState(0);
  const reload = () => setRefresh(value => value + 1);
  useLayoutEffect(() => {
    if (screen !== 'home') return;
    let current = true;
    void roundStatus(api, owner, isCurrent).then(result => {
      if (current && isCurrent()) setStatus(result);
    }).catch(() => { if (current && isCurrent()) setStatus({ kind: 'unavailable' }); });
    const timer = window.setInterval(() => { if (!document.hidden) reload(); }, 60000);
    window.addEventListener('storage', reload);
    window.addEventListener('focus', reload);
    window.addEventListener('online', reload);
    return () => {
      current = false;
      window.clearInterval(timer);
      window.removeEventListener('storage', reload);
      window.removeEventListener('focus', reload);
      window.removeEventListener('online', reload);
    };
  }, [api, owner, screen, refresh, isCurrent]);

  const home = () => { setStatus({ kind: 'checking' }); setScreen('home'); };
  if (screen === 'review') return <App api={api} onHome={home} reviewLimit={reviewLimit}
    completedRoundId={status.kind === 'start' ? status.completedRoundId : undefined} />;
  if (screen === 'browse') return <CardBrowser api={api} onHome={home} />;

  const next = status.kind === 'start' ? status.preview : null;
  const empty = next && !next.due_reviews && !next.check_ins;
  const reviews = Math.min(next?.due_reviews ?? 0, reviewLimit);
  return <section className="habit-practice practice-deck" aria-label="Habit Practice">
    <h1 className="visually-hidden">Habit Practice</h1>
    <div className="deck-row">
      <div><h2>Practice round</h2>
        <p role="status">
          {status.kind === 'checking' && 'Checking your round…'}
          {status.kind === 'unavailable' && 'Could not check your round.'}
          {status.kind === 'continue' && status.detail}
          {next && (empty ? 'No cards due right now.' :
            <>{count(next.check_ins, 'check-in')} · {reviews < next.due_reviews ? `${reviews} of ${next.due_reviews} due recall cards` : count(reviews, 'recall card')}</>)}
        </p>
        {empty && next.next_review_at && <p className="status">Next recall <time dateTime={next.next_review_at}>{new Date(next.next_review_at).toLocaleString(undefined, {dateStyle: 'medium', timeStyle: 'short'})}</time></p>}
        {next && next.due_reviews > 0 && <label className="round-size"><span id="recall-size">Recall cards per round</span>
          <select aria-labelledby="recall-size" value={reviewLimit} onChange={event => setReviewLimit(Number(event.target.value))}>
            {[1, 5, 10, 20].map(size => <option key={size} value={size}>{size}</option>)}
          </select>
        </label>}
      </div>
      {status.kind === 'unavailable' || empty
        ? <button className="secondary" onClick={reload}>{empty ? 'Check again' : 'Try again'}</button>
        : <button className="primary" disabled={status.kind === 'checking'} onClick={() => setScreen('review')}>
          {status.kind === 'continue' ? 'Continue round' : 'Start round'}
        </button>}
    </div>
    <button className="browse-link" onClick={() => setScreen('browse')}>Browse all cards <span aria-hidden="true">→</span></button>
  </section>;
}
