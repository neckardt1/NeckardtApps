import { z } from "zod";
import { dataTool, id } from "../../data-tool.ts";

const date = z.iso.date().nullable();
const time = z.string().regex(/^([01][0-9]|2[0-3]):[0-5][0-9]$/).nullable();
const plan = { plannedDate: date, plannedTime: time };
const fields = z.strictObject({ title: z.string().regex(/\S/), ...plan, deadlineDate: date, deadlineTime: time,
  showAfterDate: date, showAfterTime: time });
const revision = { task_id: id, version: z.int().positive() };
const write = { readOnlyHint: false, destructiveHint: true, idempotentHint: false };

export const taskTools = [
  dataTool("list_tasks", "Get active tasks, visible Private and optional Household list IDs, and your personal Focus choices.",
    z.strictObject({}), { readOnlyHint: true }),
  dataTool("create_task", "Create a task in the selected list. Reuse the request ID on retry. Dates and times are Pacific. Supply null for unused dates and times.",
    z.strictObject({ list_id: id, request_id: id, fields }), { readOnlyHint: false, destructiveHint: false, idempotentHint: true }),
  dataTool("update_task", "Edit an active task using its current version. Supply all fields for an edit, or just plannedDate and plannedTime to reschedule. Dates and times are Pacific.",
    z.strictObject({ ...revision, fields: z.union([fields, z.strictObject(plan)]) }), write),
  dataTool("complete_task", "Complete an active task using its current version. Completing a Household task affects its other members.",
    z.strictObject(revision), write),
  dataTool("set_task_focus", "Promote or deprioritize a visible task in your personal Focus.",
    z.strictObject({ task_id: id, state: z.enum(["promoted", "deprioritized"]) }), write),
];
