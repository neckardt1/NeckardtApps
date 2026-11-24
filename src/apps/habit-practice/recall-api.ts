import { getSiteClient } from "../../shell/site-client";
import { type PublicSupabaseConfig } from "../../shell/browser-auth.mts";
import type { DueCard, ReviewEvent } from "./review-session.ts";

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
  action?(event: ActionEvent): Promise<void>;
}
export class RecallApiError extends Error {
  constructor(message: string, readonly status: number | undefined) {
    super(message);
  }
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

export function makeRecallApi(config: PublicSupabaseConfig): RecallApi {
  const client = getSiteClient(config);
  return {
    origin: config.url,
    async due() {
      // The legacy RPC cannot distinguish imported action cards from recall.
      // Fail closed until the separately applied migration provides this API.
      const { data, error } = await client.rpc("recall_due", { p_limit: 100 });
      if (error) throw new RecallApiError(missingFunction(error.code)
        ? "Habit Practice needs its database update before reviews can begin."
        : "Unable to load due cards", rpcStatus(error.code));
      const cards: unknown = data;
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
      const opportunities: unknown = data;
      if (!Array.isArray(opportunities) || !opportunities.every(isOpportunity)
        || new Set(opportunities.map(item => item.opportunity_id)).size !== opportunities.length) {
        throw new RecallApiError("Invalid opportunity response", undefined);
      }
      return opportunities;
    },
    async action(event) {
      const { data, error } = await client.rpc("recall_record_action", {
        p_action_id: event.action_id, p_opportunity_id: event.opportunity_id,
        p_card_id: event.card_id, p_revision: event.revision,
        p_outcome: event.outcome, p_answered_at: event.answered_at
      });
      if (error) throw new RecallApiError("Habit response could not be saved", rpcStatus(error.code));
      const receipt: unknown = data;
      if (!record(receipt) || receipt.action_id !== event.action_id
        || receipt.opportunity_id !== event.opportunity_id || receipt.card_id !== event.card_id
        || receipt.revision !== event.revision || receipt.outcome !== event.outcome
        || typeof receipt.answered_at !== "string"
        || Date.parse(receipt.answered_at) !== Date.parse(event.answered_at)) {
        throw new RecallApiError("Habit response save could not be verified. Retry the same response.", undefined);
      }
    },
    async grade(event) {
      const { data, error } = await client.functions.invoke("recall-grade", { body: event });
      if (error) {
        const context: unknown = "context" in error ? error.context : undefined;
        const status = context instanceof Response ? context.status : undefined;
        throw new RecallApiError("Rating could not be saved", status);
      }
      const receipt: unknown = data;
      if (!record(receipt) || receipt.review_id !== event.review_id || receipt.card_id !== event.card_id
        || receipt.revision !== event.revision + 1 || typeof receipt.due_at !== "string"
        || !Number.isFinite(Date.parse(receipt.due_at)) || Date.parse(receipt.due_at) <= Date.parse(event.reviewed_at)) {
        throw new RecallApiError("Rating save could not be verified. Retry the same rating.", undefined);
      }
    }
  };
}
