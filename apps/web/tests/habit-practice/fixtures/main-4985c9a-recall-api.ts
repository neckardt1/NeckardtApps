import { createClient } from "@supabase/supabase-js";
import { makeSiteClientGetter, type PublicSupabaseConfig } from "../../../src/shell/browser-auth.mts";
import type { DueCard, ReviewEvent } from "../../../src/apps/habit-practice/review-session.ts";

export interface RecallApi {
  readonly origin: string;
  observeOwner(callback: (id: string | null) => void): () => void;
  signIn(email: string, password: string): Promise<string | null>;
  signOut(): Promise<void>;
  due(): Promise<DueCard[]>;
  grade(event: ReviewEvent): Promise<void>;
}
export class RecallApiError extends Error {
  constructor(message: string, readonly status: number | undefined) {
    super(message);
  }
}

function isCard(value: unknown): value is DueCard {
  if (value === null || typeof value !== "object") return false;
  return "card_id" in value && typeof value.card_id === "string"
    && "front" in value && typeof value.front === "string"
    && "back" in value && typeof value.back === "string"
    && "revision" in value && Number.isInteger(value.revision);
}

const getSiteClient = makeSiteClientGetter(createClient);

export function makeRecallApi(config: PublicSupabaseConfig): RecallApi {
  const client = getSiteClient(config);
  return {
    origin: config.url,
    observeOwner(callback) {
      const { data } = client.auth.onAuthStateChange((_event, session) => callback(session?.user.id ?? null));
      return () => data.subscription.unsubscribe();
    },
    async signIn(email, password) {
      const { data, error } = await client.auth.signInWithPassword({ email, password });
      if (error) throw new RecallApiError("Sign-in failed", error.status);
      return data.session?.user.id ?? null;
    },
    async signOut() {
      const { error } = await client.auth.signOut({ scope: "local" });
      if (error) throw new RecallApiError("Sign-out failed", error.status);
    },
    async due() {
      const { data, error } = await client.rpc("demo_flashcards_due", { p_limit: 5 });
      if (error) throw new RecallApiError("Unable to load due cards", error.code === "42501" ? 403 : undefined);
      const cards: unknown = data;
      if (!Array.isArray(cards) || !cards.every(isCard)) throw new RecallApiError("Invalid due-card response", undefined);
      return cards;
    },
    async grade(event) {
      const { error } = await client.functions.invoke("recall-grade", { body: event });
      if (error) {
        const context: unknown = "context" in error ? error.context : undefined;
        const status = context instanceof Response ? context.status : undefined;
        throw new RecallApiError("Rating could not be saved", status);
      }
    }
  };
}
