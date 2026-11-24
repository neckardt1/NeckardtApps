import type { Database, Json } from "../_shared/database.types.ts";

type Functions = Database["public"]["Functions"];
export type PrepareArgs = Functions["recall_prepare_answer"]["Args"];
export type CommitArgs = Functions["recall_commit_answer"]["Args"];
export type AnswerRow = Functions["recall_prepare_answer"]["Returns"][number];
export type CommitRow = Functions["recall_commit_answer"]["Returns"][number];
export type Grade = "miss" | "hard" | "medium" | "easy";

export interface Answer {
  card_id: string;
  review_id: string;
  revision: number;
  grade: Grade;
  reviewed_at: string;
  opportunity_id?: string;
}

export interface Schedule {
  dueAt: string;
  state: Json;
  log: Json;
  build: string;
  config: Json;
}

export function contextArgs(owner: string, answer: Answer): PrepareArgs {
  return {
    p_owner: owner,
    p_card_id: answer.card_id,
    p_review_id: answer.review_id,
    p_revision: answer.revision,
    p_grade: answer.grade,
    p_reviewed_at: answer.reviewed_at,
    ...(answer.opportunity_id && { p_opportunity_id: answer.opportunity_id })
  };
}

export function commitArgs(context: PrepareArgs, result: Schedule): CommitArgs {
  return {
    ...context,
    p_due_at: result.dueAt,
    p_state: result.state,
    p_log: result.log,
    p_scheduler_build: result.build,
    p_scheduler_config: result.config
  };
}
