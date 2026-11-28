import { grades, type DueCard, type Grade, type ReviewEvent } from './review-session.ts';
import { restoreRound } from './server-round.ts';
import { defaultReviewLimit, MissingRoundRpc, type ActionEvent, type Opportunity, type RecallApi, type RoundItem } from './recall-api.ts';

export type Save = { kind: 'review'; event: ReviewEvent; status: 'pending' | 'failed' | 'conflict' | 'saved' | 'superseded' }
  | { kind: 'action'; event: ActionEvent; status: 'pending' | 'failed' | 'conflict' | 'saved' | 'superseded' };
export type Round = {
  version: 2; id: string; server?: boolean;
  cards: (DueCard & { event_id?: string })[];
  opportunities: (Opportunity & { event_id?: string; paired?: boolean })[];
  summary?: { reviews: number; actions: number; superseded: number };
  cardIndex: number; opportunityIndex: number; revealed: boolean;
  started: boolean; finished: boolean; saves: Save[];
};
type StoragePort = Pick<Storage, 'getItem' | 'setItem' | 'removeItem' | 'length' | 'key'>;
export type Lock = <T>(name: string, run: () => Promise<T>) => Promise<T>;
export const browserLock: Lock = (name, run) => {
  if (!navigator.locks) return Promise.reject(new Error('This browser cannot safely coordinate review saves.'));
  return navigator.locks.request(name, run);
};
export function allAnswered(round: Round) {
  return round.cardIndex === round.cards.length && round.opportunityIndex === round.opportunities.length;
}
export function verified(round: Round) { return round.saves.every(save => save.status === 'saved' || save.status === 'superseded'); }
export function currentKey(round: Round) {
  return round.opportunities[round.opportunityIndex]?.opportunity_id ?? round.cards[round.cardIndex]?.card_id ?? null;
}
function valid(value: unknown): value is Round {
  if (!value || typeof value !== 'object') return false;
  const r = value as Round;
  return r.version === 2 && typeof r.id === 'string' && Array.isArray(r.cards) && Array.isArray(r.opportunities)
    && Array.isArray(r.saves) && Number.isInteger(r.cardIndex) && r.cardIndex >= 0 && r.cardIndex <= r.cards.length
    && Number.isInteger(r.opportunityIndex) && r.opportunityIndex >= 0 && r.opportunityIndex <= r.opportunities.length
    && typeof r.revealed === 'boolean' && typeof r.started === 'boolean' && typeof r.finished === 'boolean'
    && r.cards.every(c => typeof c.card_id === 'string' && typeof c.front === 'string' && typeof c.back === 'string' && Number.isInteger(c.revision))
    && r.opportunities.every(o => typeof o.opportunity_id === 'string' && typeof o.card_id === 'string' && typeof o.prompt === 'string' && Number.isInteger(o.revision))
    && r.saves.every(s => s && ['review', 'action'].includes(s.kind) && ['pending', 'failed', 'conflict', 'saved', 'superseded'].includes(s.status) && s.event && typeof s.event.card_id === 'string')
    && (!r.server || (r.cards.every(c => typeof c.event_id === 'string')
      && r.opportunities.every(o => typeof o.event_id === 'string' && typeof o.paired === 'boolean')))
    && (!r.finished || (allAnswered(r) && verified(r)));
}
const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value));
const saveId = (save: Save) => save.kind === 'review' ? save.event.review_id : save.event.action_id;

export function readStoredRound(storage: StoragePort, key: string): Round | null {
  const raw = storage.getItem(key);
  if (!raw) return null;
  const parsed: unknown = JSON.parse(raw);
  if (!valid(parsed)) throw new Error('Stored review cannot be safely restored. Keep this browser data for recovery.');
  return parsed;
}

export function unfinished(round: Round | null, finishedServerRound?: string): round is Round {
  if (!round || round.finished) return false;
  // Another device can finish this manifest while this browser still has it open.
  if (round.server && round.id === finishedServerRound && verified(round)) return false;
  return !!(round.started || round.cards.length || round.opportunities.length || round.saves.length);
}

export function hasUnfinishedRound(origin: string, owner: string, finishedServerRound?: string) {
  const scope = `${origin}.${owner}`;
  for (const version of ['v2', 'v3']) {
    const round = readStoredRound(localStorage, `recall.round.${version}.${scope}`);
    if (unfinished(round, finishedServerRound)) return true;
  }
  return Object.keys(localStorage).some(key => key.startsWith(`recall.live.v1.${scope}.`));
}

// One atomic record contains progress, queued writes, and verified acknowledgements.
// Separate Web Locks serialize local mutations and network draining across tabs.
export function makeDurableSession({ storage, key, api, reviewLimit = defaultReviewLimit, lock = browserLock, onChange = () => {}, active = () => true }: {
  storage: StoragePort; key: string; api: RecallApi; reviewLimit?: number; lock?: Lock;
  onChange?: (round: Round | null) => void; active?: () => boolean;
}) {
  const read = () => readStoredRound(storage, key);
  async function update(change: (round: Round | null) => Round | null) {
    return lock(key, async () => {
      if (!active()) return null;
      const before = read();
      const after = change(before && clone(before));
      if (after) storage.setItem(key, JSON.stringify(after));
      if (active()) onChange(after);
      return after;
    });
  }
  function matches(r: Round | null, id: string, expected: string | null): r is Round {
    return !!r && r.id === id && currentKey(r) === expected && !r.finished;
  }
  return {
    read,
    async syncRound() {
      const remote = api.rounds;
      if (!remote) throw new Error('Round service unavailable.');
      return lock(key + '.network', async () => {
        if (!active()) return;
        const before = read();
        const dismissed = storage.getItem(key + '.dismissed');
        let rows: RoundItem[];
        try {
          // Open reuses the owner's active round atomically, including on a new device.
          rows = await remote.open(before?.server ? before.id : crypto.randomUUID(), reviewLimit);
        } catch (error) {
          if (!active()) return;
          if (!(error instanceof MissingRoundRpc) || before?.server) throw error;
          // On a partial rollout, recover an existing manifest before considering legacy mode.
          try {
            rows = await remote.latest();
          } catch (lookupError) {
            if (!(lookupError instanceof MissingRoundRpc)) throw lookupError;
            rows = [];
          }
          if (!active()) return;
          if (!rows.length && !dismissed && !read()?.server) return 'use-legacy' as const;
          if (!rows.length || rows[0].finished_at) throw error;
        }
        if (!active()) return;
        await update(r => {
          if (r?.id !== before?.id) return r;
          if (rows.length) return restoreRound(rows, r);
          if (r?.server) throw new Error('Could not restore this round.');
          return { version: 2, id: crypto.randomUUID(), cards: [], opportunities: [], cardIndex: 0,
            opportunityIndex: 0, started: false, finished: false, revealed: false, saves: [] };
        });
      });
    },
    async initialize(cards: DueCard[], opportunities: Opportunity[], legacyPrefix?: string) {
      const legacy: Save[] = [];
      const oldKeys: string[] = [];
      if (legacyPrefix) for (let i = 0; i < storage.length; i++) {
        const name = storage.key(i);
        if (!name?.startsWith(legacyPrefix)) continue;
        const item = JSON.parse(storage.getItem(name) || 'null');
        if (!item?.event?.review_id || !grades.includes(item.event.grade)) throw new Error('An earlier unsaved review needs recovery.');
        legacy.push({ kind: 'review', event: item.event, status: item.status === 'conflict' ? 'conflict' : 'pending' });
        oldKeys.push(name);
      }
      const result = await update(r => {
        if (r && (r.started || r.cards.length || r.opportunities.length || r.saves.length)) return r;
        const blocked = new Set(legacy.map(s => s.event.card_id));
        return { version: 2, id: crypto.randomUUID(), cards: cards.filter(c => !blocked.has(c.card_id)).slice(0, reviewLimit),
          opportunities, cardIndex: 0, opportunityIndex: 0, revealed: false, started: false, finished: false, saves: legacy };
      });
      // Old keys are removed only after their events are safely in the atomic record.
      if (result && legacy.every(s => result.saves.some(t => saveId(t) === saveId(s)))) {
        for (const name of oldKeys) try { storage.removeItem(name); } catch { /* Idempotent recovery remains possible. */ }
      }
      return result;
    },
    reveal(id: string, expected: string, revealed = true) {
      return update(r => {
        if (matches(r, id, expected) && r.opportunityIndex === r.opportunities.length && r.cards[r.cardIndex]) {
          r.started = true;
          r.revealed = revealed;
        }
        return r;
      });
    },
    rate(id: string, expected: string, grade: Grade) {
      return update(r => {
        if (!matches(r, id, expected) || !r.revealed || !grades.includes(grade)) return r;
        const card = r.cards[r.cardIndex];
        r.saves.push({ kind: 'review', status: 'pending', event: { review_id: card.event_id ?? crypto.randomUUID(), card_id: card.card_id,
          revision: card.revision, grade, reviewed_at: new Date().toISOString() } });
        r.cardIndex++; r.revealed = false;
        return r;
      });
    },
    answer(id: string, expected: string, outcome: ActionEvent['outcome']) {
      return update(r => {
        if (!matches(r, id, expected) || !['yes', 'no', 'no_opportunity', 'skip'].includes(outcome)) return r;
        const opportunity = r.opportunities[r.opportunityIndex];
        if (!opportunity || !api.action) throw new Error('Habit check-ins are not available yet.');
        r.started = true;
        r.saves.push({ kind: 'action', status: 'pending', event: { action_id: opportunity.event_id ?? crypto.randomUUID(), opportunity_id: opportunity.opportunity_id,
          card_id: opportunity.card_id, revision: opportunity.revision, outcome, answered_at: new Date().toISOString() } });
        r.opportunityIndex++;
        return r;
      });
    },
    async clearFinished(id: string, completedRoundId?: string) {
      return lock(key, async () => {
        if (!active()) return;
        const r = read();
        if (r?.id !== id || !verified(r)) return;
        if (!r.finished && !(r.server && r.id === completedRoundId)) return;
        if (r.server) storage.setItem(key + '.dismissed', r.id);
        storage.removeItem(key);
        onChange(null);
      });
    },
    async retry() {
      await update(r => { r?.saves.forEach(s => { if (s.status === 'failed') s.status = 'pending'; }); return r; });
      return this.flush();
    },
    async flush() {
      return lock(key + '.network', async () => {
        while (active()) {
          const round = read();
          const save = round?.saves.find(s => s.status === 'pending');
          if (!round || round.finished) return;
          if (!save) {
            if (!allAnswered(round) || !verified(round) ||
                !(round.cards.length || round.opportunities.length || round.saves.length)) return;
            const rows = round.server ? await api.rounds!.finish(round.id) : null;
            await update(r => {
              if (!r || r.id !== round.id) return r;
              return rows ? restoreRound(rows, r) : { ...r, finished: true };
            });
            return;
          }
          let status: Save['status'] = 'saved';
          try {
            if (save.kind === 'review') await api.grade(save.event);
            else {
              if (!api.action) throw new Error('Habit check-ins are unavailable.');
              const opportunity = round.opportunities.find(item => item.opportunity_id === save.event.opportunity_id);
              if (opportunity?.paired) await api.action(save.event, true);
              else await api.action(save.event);
            }
          } catch (error) {
            const code = error instanceof Error && 'status' in error ? Number(error.status) : 0;
            status = [400, 403, 404, 409, 422].includes(code) ? 'conflict' : 'failed';
          }
          if (!active()) return;
          await update(r => {
            if (r?.id === round.id) {
              const current = r.saves.find(s => saveId(s) === saveId(save));
              if (current && current.status !== 'saved' && current.status !== 'superseded') current.status = status;
            }
            return r;
          });
        }
      });
    }
  };
}
export type DurableSession = ReturnType<typeof makeDurableSession>;
