import type { Card } from "ts-fsrs";
import type { Json } from "../_shared/database.types.ts";
import { commitArgs, contextArgs } from "./rpc-args.ts";
import type { Answer, AnswerRow, CommitArgs, CommitRow, Grade, PrepareArgs, Schedule } from "./rpc-args.ts";

const headers = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Cache-Control": "no-store",
  "Content-Type": "application/json"
};
const uuid = (s: unknown): s is string => typeof s === "string"
  && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
const record = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);
const timestamp = (v: unknown): v is string => typeof v === "string" && Number.isFinite(Date.parse(v));
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers });
const gradeLabels = { miss: "Again", hard: "Hard", medium: "Good", easy: "Easy" } as const;
const isGrade = (g: unknown): g is Grade => typeof g === "string" && Object.hasOwn(gradeLabels, g);

function isCardRevision(body: unknown): body is Record<string, unknown> & { card_id: string; revision: number } {
  return record(body) && uuid(body.card_id) && typeof body.revision === "number"
    && Number.isInteger(body.revision) && body.revision >= 0 && body.revision < 2147483647;
}

// Normalize action answers at the HTTP boundary. The caller cannot set both
// an action outcome and an independent FSRS grade for the same occasion.
function parseAnswer(body: unknown): Answer | null {
  if (!isCardRevision(body)) return null;
  const common = { card_id: body.card_id, revision: body.revision };
  const keys = Object.keys(body).sort().join("|");
  const iso = (v: unknown): v is string => timestamp(v)
    && new Date(v).toISOString() === v;
  if (keys === "card_id|grade|review_id|reviewed_at|revision"
    && uuid(body.review_id) && isGrade(body.grade) && iso(body.reviewed_at)) {
    return { ...common, review_id: body.review_id, grade: body.grade, reviewed_at: body.reviewed_at };
  }
  if (keys === "action_id|answered_at|card_id|opportunity_id|outcome|revision"
    && uuid(body.action_id) && uuid(body.opportunity_id) && iso(body.answered_at)
    && (body.outcome === "yes" || body.outcome === "no")) {
    return { ...common, review_id: body.action_id, opportunity_id: body.opportunity_id,
      grade: body.outcome === "yes" ? "medium" : "miss", reviewed_at: body.answered_at };
  }
  return null;
}

const nonnegative = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;
const count = (v: unknown): v is number => nonnegative(v) && Number.isSafeInteger(v);
function hydrateCard(state: Json, due: string): Card {
  if (!record(state) || !timestamp(state.due) || Date.parse(state.due) !== Date.parse(due)
    || !count(state.state) || state.state > 3
    || !nonnegative(state.stability) || !nonnegative(state.difficulty)
    || !count(state.elapsed_days) || !count(state.scheduled_days)
    || !count(state.learning_steps) || !count(state.reps) || !count(state.lapses)
    || (state.last_review != null && !timestamp(state.last_review))
    || (state.state !== 0 && (!timestamp(state.last_review) || state.reps === 0))) {
    throw new Error("Invalid stored scheduler state");
  }
  return {
    due: new Date(state.due), state: state.state,
    stability: state.stability, difficulty: state.difficulty, elapsed_days: state.elapsed_days,
    scheduled_days: state.scheduled_days, learning_steps: state.learning_steps,
    reps: state.reps, lapses: state.lapses,
    last_review: typeof state.last_review === "string" ? new Date(state.last_review) : undefined
  };
}

export function schedulerFor(lib: typeof import("ts-fsrs")) {
  const config = lib.generatorParameters({
    request_retention: 0.9, enable_fuzz: false, enable_short_term: true,
    learning_steps: ["1m", "10m"], relearning_steps: ["10m"], maximum_interval: 36500
  });
  const scheduler = lib.fsrs(config);
  // FSRS uses Dates in memory; the database stores their ISO representation.
  const serialize = (value: unknown): Json => JSON.parse(JSON.stringify(value));
  return (snapshot: AnswerRow, grade: Grade, when: string): Schedule => {
    let card: Card;
    if (snapshot.kind === "new_card" && snapshot.revision === 0 && snapshot.scheduler_state === null) {
      card = lib.createEmptyCard(new Date(snapshot.due_at));
    } else if (snapshot.kind === "studied_card") {
      card = hydrateCard(snapshot.scheduler_state, snapshot.due_at);
    } else {
      throw new Error("Inconsistent scheduler snapshot");
    }
    const result = scheduler.next(card, new Date(when), lib.Rating[gradeLabels[grade]]);
    return { dueAt: result.card.due.toISOString(), state: serialize(result.card),
      log: serialize(result.log), build: "ts-fsrs@5.4.2/FSRS-6", config: serialize(config) };
  };
}

export { firstPartyOwner } from "../_shared/first-party-owner.ts";

type Dependencies = {
  getOwner: (jwt: string) => Promise<string | null>;
  prepare: (args: PrepareArgs) => Promise<AnswerRow>;
  commit: (args: CommitArgs) => Promise<CommitRow>;
  schedule: ReturnType<typeof schedulerFor>;
};

function receipt(row: CommitRow | AnswerRow, answer: Answer) {
  if ((row.kind !== "saved" && row.kind !== "replay") || row.card_id !== answer.card_id
    || row.review_id !== answer.review_id || row.revision !== answer.revision + 1
    || !timestamp(row.due_at) || Date.parse(row.due_at) <= Date.parse(answer.reviewed_at)) {
    throw new Error("Invalid grading receipt");
  }
  return { review_id: row.review_id, card_id: row.card_id, revision: row.revision, due_at: row.due_at };
}

export function gradeHandler({ getOwner, prepare, commit, schedule }: Dependencies) {
  return async (request: Request): Promise<Response> => {
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers });
    if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
    const auth = /^Bearer\s+(\S+)$/i.exec(request.headers.get("authorization") ?? "");
    if (!auth) return json({ error: "Sign in to review cards" }, 401);
    let stage = "authenticate";
    try {
      const owner = await getOwner(auth[1]);
      if (!owner) return json({ error: "Sign in to review cards" }, 401);
      const raw = await request.text();
      if (raw.length > 2048) return json({ error: "Review is too large" }, 413);
      let body: unknown;
      try { body = JSON.parse(raw); } catch { return json({ error: "Invalid review JSON" }, 400); }
      if (isCardRevision(body) && body.preview === true && Object.keys(body).length === 3) {
        stage = "preview";
        const when = new Date().toISOString();
        // Prepare reads the owner's revision and FSRS state. Its grade parameter is
        // required for replay checks. Only a subsequent grading request can commit.
        const snapshot = await prepare(contextArgs(owner, {
          card_id: body.card_id, revision: body.revision, grade: "medium",
          review_id: crypto.randomUUID(), reviewed_at: when
        }));
        if (snapshot.card_id !== body.card_id || snapshot.revision !== body.revision) {
          throw new Error("Unexpected preview snapshot");
        }
        const intervals = Object.fromEntries(Object.keys(gradeLabels).map(label => {
          const due = schedule(snapshot, label as Grade, when).dueAt;
          return [label, (Date.parse(due) - Date.parse(when)) / 60000];
        }));
        return json({ card_id: body.card_id, revision: body.revision, minutes: intervals });
      }
      const answer = parseAnswer(body);
      if (!answer) return json({ error: "Invalid review" }, 400);
      const args = contextArgs(owner, answer);
      stage = "prepare";
      const snapshot = await prepare(args);
      if (snapshot.kind === "replay") return json(receipt(snapshot, answer));
      if (snapshot.review_id !== answer.review_id || snapshot.card_id !== answer.card_id
        || snapshot.revision !== answer.revision || !timestamp(snapshot.due_at)) {
        throw new Error("Unexpected grading snapshot");
      }
      stage = "schedule";
      const next = schedule(snapshot, answer.grade, answer.reviewed_at);
      stage = "commit";
      return json(receipt(await commit(commitArgs(args, next)), answer));
    } catch (error) {
      const code = record(error) ? error.code : undefined;
      if (code === "42501") return json({ error: "This deck is available only to enrolled users." }, 403);
      if (code === "PT409") return json({ error: "This card changed. Load the latest due cards." }, 409);
      if (code === "PT404") return json({ error: "Card or opportunity no longer exists." }, 404);
      if (code === "22023" || code === "23505") return json({ error: "This review cannot be applied." }, 422);
      // Retriable errors are diagnosable without logging tokens, card contents or owner IDs.
      console.error("recall-grade failed", { stage });
      return json({ error: "Could not save the rating. Retry the same review." }, 503);
    }
  };
}
