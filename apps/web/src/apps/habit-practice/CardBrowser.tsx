import { useLayoutEffect, useState } from 'react';
import type { CatalogCard, RecallApi } from './recall-api.ts';
import { useSiteSession } from '../../shell/session.tsx';
import { FormattedText } from './FormattedText.tsx';

const kinds: Record<string, string> = {
  fact: 'Fact', 'habit-recall': 'Habit recall', 'habit-action': 'Habit action',
  reflection: 'Reflection', unsupported: 'Unsupported'
};

export function CardBrowser({ api, onHome }: { api: RecallApi; onHome(): void }) {
  const { isCurrent } = useSiteSession();
  const [cards, setCards] = useState<CatalogCard[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [retry, setRetry] = useState(0);
  const [query, setQuery] = useState('');
  const [kind, setKind] = useState('');
  useLayoutEffect(() => {
    const request = new AbortController();
    async function load() {
      setCards(null);
      setFailed(false);
      try {
        if (!api.browse) throw Error();
        const result = await api.browse(request.signal, isCurrent);
        if (!request.signal.aborted && isCurrent()) setCards(result);
      } catch { if (!request.signal.aborted && isCurrent()) setFailed(true); }
    }
    void load();
    return () => request.abort();
  }, [api, retry, isCurrent]);

  const text = query.trim().toLowerCase();
  const matches = cards?.filter(card => (!kind || card.kind === kind)
    && [card.front, card.back, kinds[card.kind]].some(field => field?.toLowerCase().includes(text)));
  return <section className="habit-practice catalog mobile-reader" aria-label="Card browser">
    <button className="text-button deck-back reader-back" onClick={onHome}>← Practice home</button>
    <h1>Browse cards</h1>
    <div className="catalog-controls">
      <label>Search cards<input type="search" value={query} onChange={e => setQuery(e.target.value)} /></label>
      <label>Card type<select value={kind} onChange={e => setKind(e.target.value)}>
        <option value="">All types</option>
        {Object.entries(kinds).map(([id, label]) => <option key={id} value={id}>{label}</option>)}
      </select></label>
    </div>
    {failed ? <div role="alert">Could not load your cards. <button className="text-button" onClick={() => setRetry(n => n + 1)}>Try again</button></div>
      : <p role="status" className="status">{!matches ? 'Loading cards…' : !cards?.length ? 'Your deck is empty.'
        : !matches.length ? 'No matching cards.' : `${matches.length} ${matches.length === 1 ? 'card' : 'cards'}`}</p>}
    {matches?.map(card => <details key={card.card_id} className="catalog-card">
      <summary><span>{card.front}</span><small>{kinds[card.kind] ?? card.kind}</small></summary>
      <div className="answer-panel"><FormattedText text={card.back} /></div>
      <p className="status">{card.active ? 'Due ' + new Date(card.due_at).toLocaleDateString() : 'Inactive'}</p>
    </details>)}
  </section>;
}
