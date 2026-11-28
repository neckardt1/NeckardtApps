import { getSiteClient } from "../../shell/site-client.ts";
import type { PublicSupabaseConfig } from "../../shell/browser-auth.mts";
import type { Task, TaskFields, TaskSnapshot, TasksAdapter } from "./contract.ts";

export class TaskConflictError extends Error {
  constructor(message = "This task changed. Review the latest version before saving again.") {
    super(message);
    this.name = "TaskConflictError";
  }
}

// Postgres type generation describes the atomic snapshot RPC as JSONB.
function isSnapshot(value: unknown): value is TaskSnapshot {
  return !!value && typeof value === "object"
    && "lists" in value && Array.isArray(value.lists)
    && "tasks" in value && Array.isArray(value.tasks)
    && "focus" in value && Array.isArray(value.focus)
    && "focusDay" in value && typeof value.focusDay === "string";
}

function check(error: { code: string } | null, promoting = false) {
  if (!error) return;
  if (error.code === "PT409") throw new TaskConflictError();
  if (error.code === "PT422" && promoting) throw new Error("The Show after time has not arrived.");
  if (error.code === "42501" || error.code === "PT403" || error.code === "PT404") {
    throw new Error("This task or list is unavailable to this account.");
  }
  if (error.code.startsWith("22") || ["PT422", "23502", "23514"].includes(error.code)) {
    const invalid = new Error("Check the title, dates and times, then try again.");
    invalid.name = "TaskValidationError";
    throw invalid;
  }
  const uncertain = new Error("Couldn’t confirm the request. Check your connection and try again.");
  uncertain.name = "TaskRequestError";
  throw uncertain;
}

export function tasksAdapter(config: PublicSupabaseConfig, actor: string): TasksAdapter {
  const client = getSiteClient(config);
  const change = async (task: Task, action: string, fields?: Partial<TaskFields>) => {
    const { data, error } = await client.rpc("tasks_change", {
      p_actor: actor, p_task: task.id, p_version: task.version, p_action: action,
      ...(fields && { p_fields: { ...fields } }),
    });
    check(error, action === "promoted");
    return data;
  };
  return {
    async read() {
      const { data, error } = await client.rpc("tasks_read", { p_actor: actor });
      check(error);
      if (!isSnapshot(data)) throw new Error("Couldn’t load Tasks.");
      return data;
    },
    async create(listId, requestId, fields) {
      const { data, error } = await client.rpc("tasks_create", {
        p_actor: actor, p_list: listId, p_request: requestId, p_fields: { ...fields },
      });
      check(error);
      if (!data) throw new Error("Couldn’t confirm the new task. Try again.");
      return data;
    },
    async completed(before) {
      const { data, error } = await client.rpc("tasks_completed", { p_actor: actor,
        ...(before && { p_before_at: before.completed_at, p_before_id: before.task_id }) });
      check(error);
      return data ?? [];
    },
    async history(taskId, before) {
      const { data, error } = await client.rpc("tasks_history", { p_actor: actor, p_task: taskId,
        ...(before && { p_before: before }) });
      check(error);
      return data ?? [];
    },
    async undo(eventId) {
      const { error } = await client.rpc("tasks_undo", { p_actor: actor, p_event: eventId });
      if (error?.code === "PT409") throw new TaskConflictError("Can’t undo. This task changed again.");
      if (error?.code === "PT410") throw new Error("The undo window has closed.");
      check(error);
    },
    edit: (task, fields) => change(task, "edited", fields),
    reschedule: (task, plannedDate, plannedTime) => change(task, "edited", { plannedDate, plannedTime }),
    complete: task => change(task, "completed"),
    promote: task => change(task, "promoted"),
    deprioritize: task => change(task, "deprioritized"),
  };
}
