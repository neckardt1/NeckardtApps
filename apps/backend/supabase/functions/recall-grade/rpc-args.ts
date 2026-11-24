import type { Database, Json } from "../_shared/database.types.ts";

type Functions = Database["public"]["Functions"];
type ContextArgs = Functions["recall_grade_context"]["Args"];

interface Review {
  card_id: string;
  review_id: string;
  revision: number;
  grade: string;
  reviewed_at: string;
}

interface Schedule {
  dueAt: string;
  state: Json;
  log: Json;
  build: string;
  config: Json;
}

export function contextArgs(owner: string, review: Review): ContextArgs {
  return {
    p_owner: owner,
    p_card_id: review.card_id,
    p_review_id: review.review_id,
    p_revision: review.revision,
    p_grade: review.grade,
    p_reviewed_at: review.reviewed_at
  };
}

export function commitArgs(context: ContextArgs, result: Schedule): Functions["recall_commit_review"]["Args"] {
  return {
    ...context,
    p_due_at: result.dueAt,
    p_state: result.state,
    p_log: result.log,
    p_scheduler_build: result.build,
    p_scheduler_config: result.config
  };
}
