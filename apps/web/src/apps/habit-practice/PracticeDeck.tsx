import { useLayoutEffect, useState } from 'react';
import { useSiteSession } from '../../shell/session.tsx';
import { App } from './App.tsx';
import { CardBrowser } from './CardBrowser.tsx';
import { readStoredRound } from './durable-session.ts';
import { MissingRoundRpc, type RecallApi } from './recall-api.ts';

type Status = 'checking' | 'start' | 'continue' | 'unavailable';

async function roundStatus(api: RecallApi, owner: string): Promise<Status> {
  const scope = `${api.origin}.${owner}`;
  for (const version of ['v2', 'v3']) {
    const round = readStoredRound(localStorage, `recall.round.${version}.${scope}`);
    if (round && !round.finished && (round.started || round.cards.length || round.opportunities.length || round.saves.length)) return 'continue';
  }
  if (Object.keys(localStorage).some(key => key.startsWith(`recall.live.v1.${scope}.`))) return 'continue';
  try {
    const rows = await api.rounds?.latest();
    return rows?.[0]?.finished_at === null ? 'continue' : 'start';
  } catch (error) {
    if (error instanceof MissingRoundRpc) return 'start';
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
  const [status, setStatus] = useState<Status>('checking');
  const [refresh, setRefresh] = useState(0);
  useLayoutEffect(() => {
    if (screen !== 'home') return;
    let current = true;
    setStatus('checking');
    void roundStatus(api, owner).then(result => {
      if (current && isCurrent()) setStatus(result);
    }).catch(() => { if (current && isCurrent()) setStatus('unavailable'); });
    const reload = () => setRefresh(value => value + 1);
    window.addEventListener('storage', reload);
    window.addEventListener('focus', reload);
    return () => {
      current = false;
      window.removeEventListener('storage', reload);
      window.removeEventListener('focus', reload);
    };
  }, [api, owner, screen, refresh, isCurrent]);

  const home = () => { setStatus('checking'); setScreen('home'); };
  if (screen === 'review') return <App api={api} onHome={home} />;
  if (screen === 'browse') return <CardBrowser api={api} onHome={home} />;
  return <section className="habit-practice practice-deck" aria-label="Habit Practice">
    <h1>Habit Practice</h1>
    <div className="deck-row">
      <div><h2>Practice round</h2><p role="status">{{
        checking: 'Checking for a saved round…', start: 'Ready to practice.',
        continue: 'Round in progress.', unavailable: 'Could not check your round.'
      }[status]}</p></div>
      {status === 'unavailable'
        ? <button className="secondary" onClick={() => setRefresh(value => value + 1)}>Try again</button>
        : <button className="primary" disabled={status === 'checking'} onClick={() => setScreen('review')}>
          {status === 'continue' ? 'Continue round' : 'Start round'}
        </button>}
    </div>
    <button className="browse-link" onClick={() => setScreen('browse')}>Browse all cards <span aria-hidden="true">→</span></button>
  </section>;
}
