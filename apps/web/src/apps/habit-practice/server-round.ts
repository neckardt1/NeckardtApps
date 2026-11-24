import type { Round, Save } from './durable-session.ts';
import type { RoundItem } from './recall-api.ts';

// Keep optimistic local answers until their server receipts arrive. Another device
// may already have answered an item, even in a different order.
export function restoreRound(items: RoundItem[], cached: Round | null): Round {
  const header = items[0];
  if (!header || (cached?.server && cached.id !== header.round_id)) {
    throw new Error('Could not match the saved round on this device.');
  }
  const local = cached?.id === header.round_id ? cached : null;
  if (local?.finished && !header.finished_at) return local;
  const byId = new Map(items.map(row => [row.event_id, row]));
  const saves = (local?.saves ?? []).map((save): Save => {
    const action = save.kind === 'action';
    const row = byId.get(action ? save.event.action_id : save.event.review_id);
    if (!row) throw new Error('The saved round no longer contains a queued answer.');
    if (row.answer === null) return save;
    // An opportunity can expire while a timely answer is offline. Only a
    // committed result or a definitive rejection can settle that queued write.
    if (row.answer === 'superseded' && !row.finished_at
      && (save.status === 'pending' || save.status === 'failed')) return save;
    const value = action ? save.event.outcome : save.event.grade;
    const time = action ? save.event.answered_at : save.event.reviewed_at;
    const matched = row.answer === value && row.answered_at !== null
      && Date.parse(row.answered_at) === Date.parse(time);
    return { ...save, status: matched ? 'saved' : 'superseded' };
  });
  const submitted = new Set(saves.map(s => s.kind === 'action' ? s.event.action_id : s.event.review_id));
  const answered = (row: RoundItem) => row.answer !== null || submitted.has(row.event_id);
  function group(kind: RoundItem['item_kind']) {
    const rows = items.filter(row => row.item_kind === kind);
    const done = rows.filter(answered);
    return { rows: [...done, ...rows.filter(row => !answered(row))], index: done.length };
  }
  const recall = group('review');
  const action = group('action');
  const current = recall.rows[recall.index];
  const superseded = items.filter(item => item.answer === 'superseded').length;
  return {
    version: 2, server: true, id: header.round_id,
    cards: recall.rows.map(item => ({
      card_id: item.card_id, revision: item.revision, front: item.front,
      back: item.back!, event_id: item.event_id
    })),
    opportunities: action.rows.map(item => ({
      card_id: item.card_id, revision: item.revision, opportunity_id: item.opportunity_id!,
      prompt: item.front, cue: item.back, event_id: item.event_id, paired: item.paired_action
    })),
    cardIndex: recall.index, opportunityIndex: action.index,
    started: !!local?.started || items.some(item => item.answer !== null),
    finished: header.finished_at !== null, finishedAt: header.finished_at ?? undefined, saves,
    revealed: !!local?.revealed && !!current && local.cards[local.cardIndex]?.event_id === current.event_id,
    summary: {
      reviews: recall.rows.filter(item => item.answer !== null && item.answer !== 'superseded').length,
      actions: action.rows.filter(item => item.answer !== null && item.answer !== 'superseded').length,
      superseded
    }
  };
}
