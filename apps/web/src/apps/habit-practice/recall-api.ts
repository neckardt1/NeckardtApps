import { getSiteClient } from "../../shell/site-client";
import { type PublicSupabaseConfig } from "../../shell/browser-auth.mts";
import { grades, type DueCard, type ReviewEvent } from "./review-session.ts";

export const actionOutcomes = ["yes", "no", "no_opportunity", "skip"] as const;
export type ActionOutcome = typeof actionOutcomes[number];
export interface Opportunity {
  opportunity_id: string;
  card_id: string;
  revision: number;
  prompt: string;
  cue: string | null;
}
export interface ActionEvent {
  action_id: string;
  opportunity_id: string;
  card_id: string;
  revision: number;
  outcome: ActionOutcome;
  answered_at: string;
}
export interface RecallApi {
  readonly origin: string;
  due(): Promise<DueCard[]>;
  grade(event: ReviewEvent): Promise<void>;
  opportunities?(): Promise<Opportunity[]>;
  action?(event: ActionEvent, paired?: boolean): Promise<void>;
  rounds?: RoundApi;
  armDebrief?(roundId: string): Promise<void>;
}
export interface RoundItem {
  round_id: string;
  finished_at: string | null;
  position: number;
  item_kind: "review" | "action";
  event_id: string;
  card_id: string;
  revision: number;
  front: string;
  back: string | null;
  opportunity_id: string | null;
  due_at: string | null;
  answer: string | null;
  answered_at: string | null;
  paired_action: boolean;
}
export interface RoundApi {
  latest(): Promise<RoundItem[]>;
  open(id: string): Promise<RoundItem[]>;
  finish(id: string): Promise<RoundItem[]>;
}

export class RecallApiError extends Error {
  constructor(message: string, readonly status: number | undefined) {
    super(message);
  }
}

// Only the initial capability probe may use the pre-round review API.
export class MissingRoundRpc extends RecallApiError {
  constructor() { super("Habit Practice needs its database update to load this round.", undefined); }
}

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const revision = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 0 && value < 2147483647;
function isCard(value: unknown): value is DueCard {
  return record(value) && typeof value.card_id === "string"
    && typeof value.front === "string" && typeof value.back === "string" && revision(value.revision);
}
function isOpportunity(value: unknown): value is Opportunity {
  return record(value) && typeof value.opportunity_id === "string"
    && typeof value.card_id === "string" && revision(value.revision)
    && typeof value.prompt === "string" && value.prompt.trim().length > 0
    && (value.cue === null || typeof value.cue === "string");
}
const missingFunction = (code: string) => code === "PGRST202" || code === "42883";
function rpcStatus(code: string): number | undefined {
  if (code === "42501") return 403;
  if (code === "PT409") return 409;
  if (code === "PT404") return 404;
  if (code === "22023" || code === "22P02" || code === "23505") return 422;
  return undefined;
}

const timestamp = (value: unknown) => typeof value === "string" && Number.isFinite(Date.parse(value));
const sameInstant = (a: string, b: string) => Date.parse(a) === Date.parse(b);

function isRoundItem(value: unknown): value is RoundItem {
  if (!record(value) || typeof value.round_id !== "string" || typeof value.event_id !== "string"
    || typeof value.card_id !== "string" || !revision(value.revision) || !revision(value.position)
    || typeof value.front !== "string" || typeof value.paired_action !== "boolean"
    || !(value.finished_at === null || timestamp(value.finished_at))
    || !(value.due_at === null || timestamp(value.due_at))
    || !(value.answered_at === null || timestamp(value.answered_at))) return false;
  const action = value.item_kind === "action";
  if (action ? (typeof value.opportunity_id !== "string" || !(value.back === null || typeof value.back === "string"))
    : (value.item_kind !== "review" || value.opportunity_id !== null || typeof value.back !== "string")) return false;
  if (value.answer === null) return value.answered_at === null && value.finished_at === null;
  if (value.answer === "superseded") return true;
  const answers: readonly string[] = action ? actionOutcomes : grades;
  return typeof value.answer === "string" && answers.includes(value.answer) && timestamp(value.answered_at);
}

// The RPC returns a row per immutable item, with current receipt and completion state.
type WireRoundItem = Omit<RoundItem, "item_kind"> & { item_kind: string };
function readManifest(result: { data: WireRoundItem[] | null; error: { code: string; message?: string } | null },
  rpc: "recall_latest_round" | "recall_open_round" | "recall_finish_round"): RoundItem[] {
  if (result.error) {
    const { code, message } = result.error;
    // 42883 can also originate from a broken dependency *inside* a deployed RPC.
    const missingThisFunction = code === "42883"
      && new RegExp(`\\bfunction\\s+(?:public\\.)?${rpc}\\s*\\(`, "i").test((message ?? "").replaceAll('"', ''));
    if (code === "PGRST202" || missingThisFunction) throw new MissingRoundRpc();
    throw new RecallApiError("Unable to load the saved round. Try again.", rpcStatus(code));
  }
  const rows: unknown = result.data;
  if (!Array.isArray(rows) || !rows.every(isRoundItem)) throw new Error("Invalid round item");
  rows.sort((a, b) => a.position - b.position);
  if (rows.some((row, index) => row.position !== index || row.round_id !== rows[0].round_id
    || row.finished_at !== rows[0].finished_at)
    || new Set(rows.map(row => row.event_id)).size !== rows.length) throw new Error("Invalid round manifest");
  return rows;
}

export function makeRecallApi(config: PublicSupabaseConfig): RecallApi {
  const client = getSiteClient(config);
  async function saveGrade(event: ReviewEvent | ActionEvent) {
    const { data, error } = await client.functions.invoke("recall-grade", { body: event });
    if (error) {
      const context: unknown = "context" in error ? error.context : undefined;
      const status = context instanceof Response ? context.status : undefined;
      throw new RecallApiError("Rating could not be saved", status);
    }
    const id = "action_id" in event ? event.action_id : event.review_id;
    const at = "answered_at" in event ? event.answered_at : event.reviewed_at;
    const receipt: unknown = data;
    if (!record(receipt) || receipt.review_id !== id || receipt.card_id !== event.card_id
      || receipt.revision !== event.revision + 1 || typeof receipt.due_at !== "string"
      || !timestamp(receipt.due_at) || Date.parse(receipt.due_at) <= Date.parse(at)) {
      throw new RecallApiError("Rating save could not be verified. Retry the same rating.", undefined);
    }
  }

  return {
    origin: config.url,
    async armDebrief(roundId) {
      const { data, error } = await client.rpc("habit_notify_arm", { round_id: roundId, share_items: true });
      if (error || data !== true) throw new Error("Round debrief could not be confirmed");
    },
    rounds: {
      async latest() { return readManifest(await client.rpc("recall_latest_round"), "recall_latest_round"); },
      async open(id) { return readManifest(await client.rpc("recall_open_round", { p_round_id: id }), "recall_open_round"); },
      async finish(id) {
        const rows = readManifest(await client.rpc("recall_finish_round", { p_round_id: id }), "recall_finish_round");
        if (!rows[0]?.finished_at || rows[0].round_id !== id) throw new Error("Unconfirmed round completion");
        return rows;
      }
    },
    async due() {
      // The legacy RPC cannot distinguish imported action cards from recall.
      // Fail closed until the separately applied migration provides this API.
      const { data, error } = await client.rpc("recall_due", { p_limit: 100 });
      if (error) throw new RecallApiError(missingFunction(error.code)
        ? "Habit Practice needs its database update before reviews can begin."
        : "Unable to load due cards", rpcStatus(error.code));
      const cards: DueCard[] | null = data;
      if (!Array.isArray(cards) || !cards.every(isCard)
        || new Set(cards.map(card => card.card_id)).size !== cards.length) {
        throw new RecallApiError("Invalid due-card response", undefined);
      }
      return cards;
    },
    async opportunities() {
      const { data, error } = await client.rpc("recall_opportunities", { p_limit: 100 });
      if (error && missingFunction(error.code)) return [];
      if (error) throw new RecallApiError("Unable to load habit opportunities", rpcStatus(error.code));
      const opportunities: Opportunity[] | null = data;
      if (!Array.isArray(opportunities) || !opportunities.every(isOpportunity)
        || new Set(opportunities.map(item => item.opportunity_id)).size !== opportunities.length) {
        throw new RecallApiError("Invalid opportunity response", undefined);
      }
      return opportunities;
    },
    async action(event, paired = false) {
      if (paired && (event.outcome === "yes" || event.outcome === "no")) return saveGrade(event);
      const args = {
        p_action_id: event.action_id, p_opportunity_id: event.opportunity_id,
        p_card_id: event.card_id, p_revision: event.revision,
        p_outcome: event.outcome, p_answered_at: event.answered_at
      };
      const { data, error } = paired
        ? await client.rpc("recall_check_in", args).single()
        : await client.rpc("recall_record_action", args);
      if (error) throw new RecallApiError("Habit response could not be saved", rpcStatus(error.code));
      const receipt: unknown = data;
      if (!record(receipt) || receipt.action_id !== event.action_id
        || receipt.opportunity_id !== event.opportunity_id || receipt.card_id !== event.card_id
        || receipt.revision !== event.revision || receipt.outcome !== event.outcome
        || typeof receipt.answered_at !== "string"
        || !sameInstant(receipt.answered_at, event.answered_at)) {
        throw new RecallApiError("Habit response save could not be verified. Retry the same response.", undefined);
      }
    },
    grade: saveGrade
  };
}
