export const grades = ["miss", "hard", "medium", "easy"] as const;
export type Grade = typeof grades[number];
export interface DueCard {
  card_id: string;
  front: string;
  back: string;
  revision: number;
}
export interface ReviewEvent {
  review_id: string;
  card_id: string;
  revision: number;
  grade: Grade;
  reviewed_at: string;
}
export interface ReviewView {
  index: number;
  total: number;
  current: string | null;
  revealed: boolean;
  answer: string | null;
  done: boolean;
}

export function makeReviewSession(cards: readonly DueCard[], enqueue: (event: ReviewEvent) => void, {
  makeId = () => crypto.randomUUID(), now = () => new Date().toISOString()
} = {}) {
  // Prefetch up to five for an immediate reveal/advance, but render one at a time.
  const batch = cards.slice(0, 5);
  let index = 0, revealed = false;
  return {
    view(): ReviewView {
      return {
        index, total: batch.length, current: batch[index]?.front ?? null,
        revealed, answer: revealed ? (batch[index]?.back ?? null) : null, done: index >= batch.length
      };
    },
    reveal() {
      if (index >= batch.length || revealed) return false;
      revealed = true;
      return true;
    },
    rate(value: Grade) {
      const card = batch[index];
      if (!card || !revealed || !grades.includes(value)) return null;
      const event: ReviewEvent = {
        review_id: makeId(), card_id: card.card_id, revision: card.revision, grade: value, reviewed_at: now()
      };
      enqueue(event); // Durable local write only. Never wait for the network here.
      index++;
      revealed = false;
      return event;
    }
  };
}
export type ReviewSession = ReturnType<typeof makeReviewSession>;

type OutboxStatus = "pending" | "failed" | "conflict";
type OutboxItem = { event: ReviewEvent; status: OutboxStatus };
type StoragePort = Pick<Storage, "length" | "key" | "getItem" | "setItem" | "removeItem">;
type OutboxOptions = {
  storage: StoragePort;
  prefix: string;
  send: (item: ReviewEvent) => Promise<void>;
  onChange?: () => void;
  active?: () => boolean;
};
export function makeOutbox({ storage, prefix, send, onChange = () => {}, active = () => true }: OutboxOptions) {
  const key = (id: string) => prefix + id;
  let draining = false;
  function entries() {
    const out: OutboxItem[] = [];
    for (let i = 0; i < storage.length; i++) {
      const name = storage.key(i);
      if (name?.startsWith(prefix)) {
        const parsed = JSON.parse(storage.getItem(name) || "null") as OutboxItem | null;
        if (parsed?.event?.review_id) out.push(parsed);
      }
    }
    return out.sort((a, b) => a.event.reviewed_at.localeCompare(b.event.reviewed_at));
  }
  function put(item: OutboxItem) { storage.setItem(key(item.event.review_id), JSON.stringify(item)); }
  return {
    entries,
    enqueue(event: ReviewEvent) { put({ event, status: "pending" }); },
    async flush() {
      if (draining) return;
      draining = true;
      try {
        while (active()) {
          const item = entries().find(e => e.status === "pending");
          if (!item) return;
          try {
            await send(item.event);
            storage.removeItem(key(item.event.review_id));
          } catch (error) {
            const status = error instanceof Error && "status" in error ? Number(error.status) : 0;
            put({ ...item, status: [400, 403, 404, 409, 422].includes(status) ? "conflict" : "failed" });
          }
          if (active()) onChange();
        }
      } finally { draining = false; }
    },
    retry() {
      for (const item of entries()) if (item.status === "failed") put({ ...item, status: "pending" });
      onChange();
      return this.flush();
    },
    dismissConflicts() {
      for (const item of entries()) if (item.status === "conflict") storage.removeItem(key(item.event.review_id));
      onChange();
    }
  };
}
export type Outbox = ReturnType<typeof makeOutbox>;
