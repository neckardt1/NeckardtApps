import { expect, test } from 'vitest';
import type { RoundItem } from '../../src/apps/habit-practice/recall-api.ts';
import { verified, type Round } from '../../src/apps/habit-practice/durable-session.ts';
import { restoreRound } from '../../src/apps/habit-practice/server-round.ts';

const item: RoundItem = {
  round_id: 'round', event_id: 'answer', card_id: 'action-card', position: 0, item_kind: 'action',
  paired_action: true, revision: 0, opportunity_id: 'occasion', front: 'Did you do it?', back: 'After breakfast',
  answer: null, answered_at: null, due_at: null, finished_at: null
};
const at = '2026-01-10T10:00:00.000Z';
function pendingRound(): Round {
  const round = restoreRound([item], null);
  round.started = true;
  round.opportunityIndex = 1;
  round.saves.push({ kind: 'action', status: 'pending', event: {
    action_id: item.event_id, card_id: item.card_id, opportunity_id: item.opportunity_id!,
    revision: 0, outcome: 'yes', answered_at: at
  } });
  return round;
}

test('a timely offline answer survives provisional expiry until the server has acknowledged or rejected it', () => {
  const local = pendingRound();
  const expired = { ...item, answer: 'superseded' };
  const resumed = restoreRound([expired], local);
  expect(resumed.saves).toEqual(local.saves);
  expect(verified(resumed)).toBe(false);

  // Same receipt returned after a lost acknowledgement, with Postgres timestamp formatting.
  const ack = { ...item, answer: 'yes', answered_at: '2026-01-10T10:00:00+00:00' };
  expect(restoreRound([ack], resumed).saves[0].status).toBe('saved');
  resumed.saves[0].status = 'conflict';
  expect(restoreRound([expired], resumed).saves[0].status).toBe('superseded');
});

test('another device can finish a round and preserve a conflicting local answer for inspection', () => {
  const finished = { ...item, answer: 'no', answered_at: at, finished_at: '2026-01-10T10:01:00Z' };
  const resumed = restoreRound([finished], pendingRound());
  expect(resumed.finished).toBe(true);
  expect(resumed.saves[0]).toMatchObject({ status: 'superseded', event: { outcome: 'yes' } });
  expect(verified(resumed)).toBe(true);
  const fresh = restoreRound([finished], null);
  expect(fresh.finished).toBe(true);
  expect(fresh.finishedAt).toBe(finished.finished_at);
  expect(fresh.summary).toEqual({ actions: 1, reviews: 0, superseded: 0 });
});
