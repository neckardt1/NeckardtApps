import { useLayoutEffect, useRef, useState } from 'react';
import type { CatalogCard, RecallApi } from './recall-api.ts';
import { useSiteSession } from '../../shell/session.tsx';
import { FormattedText } from './FormattedText.tsx';

const kinds: Record<string, string> = {
  fact: 'Fact', 'habit-recall': 'Habit recall', 'habit-action': 'Habit action',
  reflection: 'Reflection', unsupported: 'Unsupported'
};
const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });

function timing(card: CatalogCard, cue: CatalogCard | undefined) {
  const due = new Date(card.due_at);
  const time = Number.isFinite(due.getTime()) ? <time dateTime={card.due_at}>{dateFormat.format(due)}</time> : 'Date unavailable';
  const recall = card.kind === 'fact' || card.kind === 'habit-recall';
  if (!card.active) return <>Paused{(recall || cue) && <> · Saved due {time}</>}</>;
  if (card.kind === 'habit-action') {
    if (cue && !cue.active) return <>Cue paused · Check-ins on hold</>;
    if (card.check_in_available) return <>Check-in ready</>;
    if (cue && due.getTime() > Date.now()) return <>Next eligible {time} · Needs an occasion</>;
    return <>Waiting for an occasion</>;
  }
  if (recall) return <>{due.getTime() <= Date.now() ? 'Due now' : 'Next recall'} · {time}{card.check_in_available && ' · Check-in ready'}</>;
  return card.check_in_available ? 'Check-in ready' : 'Outside scheduled recall';
}

export function CardBrowser({ api, onHome }: { api: RecallApi; onHome(): void }) {
  const { isCurrent } = useSiteSession();
  const [cards, setCards] = useState<CatalogCard[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [retry, setRetry] = useState(0);
  const [query, setQuery] = useState('');
  const [kind, setKind] = useState('');
  const [activity, setActivity] = useState('');
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState(new Set<string>());
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const request = useRef<AbortController | null>(null);
  useLayoutEffect(() => {
    setBusy(false);
    setMessage('');
    setSelected(new Set());
    setSelecting(false);
  }, [api, isCurrent]);
  useLayoutEffect(() => {
    const controller = new AbortController();
    request.current = controller;
    async function load() {
      setCards(null);
      setFailed(false);
      try {
        if (!api.browse) throw Error();
        const result = await api.browse(controller.signal, isCurrent);
        if (!controller.signal.aborted && isCurrent()) setCards(result);
      } catch { if (!controller.signal.aborted && isCurrent()) setFailed(true); }
    }
    void load();
    return () => controller.abort();
  }, [api, retry, isCurrent]);

  const byId = new Map(cards?.map(card => [card.card_id, card]));
  const byCue = new Map(cards?.filter(card => card.cue_card_id).map(card => [card.cue_card_id, card]));
  const text = query.trim().toLowerCase();
  const matches = cards?.filter(card => (!kind || card.kind === kind)
    && (!activity || card.active === (activity === 'active'))
    && [card.front, card.back, kinds[card.kind]].some(field => field?.toLowerCase().includes(text)));
  const selection = (cards ?? []).filter(card => selected.has(card.card_id));
  const toPause = selection.filter(card => card.active);
  const toResume = selection.filter(card => !card.active);

  function choose(ids: string[], include = true) {
    setSelected(previous => {
      const next = new Set(previous);
      for (const id of ids) { if (include) next.add(id); else next.delete(id); }
      return next;
    });
    setMessage('');
  }

  async function change(targets: CatalogCard[], active: boolean) {
    const controller = request.current;
    if (!controller || controller.signal.aborted || !isCurrent() || busy || !targets.length) return;
    setBusy(true);
    setMessage('');
    try {
      if (!api.setCardsActive) throw Error();
      await api.setCardsActive(targets.map(card => card.card_id), active);
      if (!controller.signal.aborted && isCurrent()) {
        setSelected(new Set());
        setSelecting(false);
        setMessage(`${active ? 'Resumed' : 'Paused'} ${targets.length} ${targets.length === 1 ? 'card' : 'cards'}.`);
      }
    } catch {
      if (!controller.signal.aborted && isCurrent()) setMessage('Could not confirm the change. Check the refreshed card status before retrying.');
    } finally {
      if (!controller.signal.aborted && isCurrent()) {
        setBusy(false);
        setRetry(n => n + 1);
      }
    }
  }

  return <section className="habit-practice catalog mobile-reader" aria-label="Card browser">
    <button className="text-button deck-back reader-back" disabled={busy} onClick={onHome}>← Practice home</button>
    <h1>Browse cards</h1>
    <div className="catalog-controls">
      <label>Search cards<input type="search" value={query} onChange={e => setQuery(e.target.value)} /></label>
      <label><span id="catalog-kind">Card type</span><select aria-labelledby="catalog-kind" value={kind} onChange={e => setKind(e.target.value)}>
        <option value="">All types</option>
        {Object.entries(kinds).map(([id, label]) => <option key={id} value={id}>{label}</option>)}
      </select></label>
      <label><span id="catalog-status">Status</span><select aria-labelledby="catalog-status" value={activity} onChange={e => setActivity(e.target.value)}>
        <option value="">All statuses</option><option value="active">Active</option><option value="paused">Paused</option>
      </select></label>
    </div>
    <div className="catalog-count">
      {failed ? <div role="alert">Could not load your cards. <button className="text-button" onClick={() => setRetry(n => n + 1)}>Try again</button></div>
        : <p role="status" className="status">{!matches ? 'Loading cards…' : !cards?.length ? 'Your deck is empty.'
          : !matches.length ? 'No matching cards.' : `${matches.length} ${matches.length === 1 ? 'card' : 'cards'}`}</p>}
      {!!cards?.length && <button className="text-button" disabled={busy} onClick={() => {
        setSelecting(!selecting); setSelected(new Set()); setMessage('');
      }}>{selecting ? 'Cancel selection' : 'Select cards'}</button>}
    </div>
    {selecting && <div className="catalog-selection" role="group" aria-label="Selected cards">
      <div className="selection-actions">
        <strong>{selection.length} selected</strong>
        {!!matches?.length && <button className="text-button" disabled={busy} onClick={() => choose(matches.map(card => card.card_id))}>{matches.length === 1 ? 'Select 1 result' : `Select all ${matches.length} results`}</button>}
        {!!toPause.length && <button className="secondary" disabled={busy} onClick={() => void change(toPause, false)}>Pause {toPause.length}</button>}
        {!!toResume.length && <button className="secondary" disabled={busy} onClick={() => void change(toResume, true)}>Resume {toResume.length}</button>}
      </div>
      {selection.some(card => byCue.has(card.card_id)) && <p className="status">A paused cue holds its paired action’s check-ins. Resuming the cue allows eligible check-ins again.</p>}
      {selection.some(card => card.cue_card_id) && <p className="status">Changing an action leaves its cue’s status alone. Both cards must be active for a paired check-in.</p>}
    </div>}
    <p className="status" role="status">{busy ? 'Saving card status…' : message}</p>
    {matches?.map(card => {
      const cue = card.cue_card_id ? byId.get(card.cue_card_id) : undefined;
      const action = byCue.get(card.card_id);
      const partner = cue ?? action;
      return <div key={card.card_id} className="catalog-row">
        {selecting && <label className="card-check"><input type="checkbox" aria-label={'Select ' + card.front}
          disabled={busy} checked={selected.has(card.card_id)} onChange={e => choose([card.card_id], e.target.checked)} /></label>}
        <details className="catalog-card">
          <summary><span>{card.front}</span>
            <small>{kinds[card.kind] ?? card.kind} · {timing(card, cue)}</small>
          </summary>
          <div className="answer-panel"><FormattedText text={card.back} /></div>
          {partner && <p className="status">Paired {cue ? 'cue' : 'action'} · {partner.front} ({partner.active ? 'active' : 'paused'}). {cue
            ? 'This action needs an active cue and an eligible occasion.'
            : 'Pausing this cue holds the action’s check-ins.'}</p>}
          <div className="card-actions">
            {!selecting && <button className="text-button" disabled={busy} onClick={() => void change([card], !card.active)}>{card.active ? 'Pause card' : 'Resume card'}</button>}
            {partner && <button className="text-button" disabled={busy} onClick={() => {
              setSelecting(true); choose([card.card_id, partner.card_id]);
            }}>Select both cards</button>}
          </div>
        </details>
      </div>;
    })}
  </section>;
}
