import { getSiteClient } from "../../shell/site-client.ts";
import type { PublicSupabaseConfig } from "../../shell/browser-auth.mts";
import type { Task, TaskFields, TaskSnapshot, TasksAdapter } from "./contract.ts";

export class TaskConflictError extends Error {
  constructor() {
    super("This task changed. Review the latest version before saving again.");
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
  throw new Error("Couldn’t confirm the request. Check your connection and try again.");
}

export function tasksAdapter(config: PublicSupabaseConfig, actor: string): TasksAdapter {
  const client = getSiteClient(config);
  const update = async (task: Task, fields: Partial<TaskFields>) => {
    const { error } = await client.rpc("tasks_update", {
      p_actor: actor, p_task: task.id, p_version: task.version, p_fields: { ...fields },
    });
    check(error);
  };
  const focus = async (task: Task, state: "promoted" | "deprioritized") => {
    const { error } = await client.rpc("tasks_focus", { p_actor: actor, p_task: task.id, p_state: state });
    check(error, state === "promoted");
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
    edit: update,
    reschedule: (task, plannedDate, plannedTime) => update(task, { plannedDate, plannedTime }),
    async complete(task) {
      const { error } = await client.rpc("tasks_complete", { p_actor: actor, p_task: task.id, p_version: task.version });
      check(error);
    },
    promote: task => focus(task, "promoted"),
    deprioritize: task => focus(task, "deprioritized"),
  };
}
