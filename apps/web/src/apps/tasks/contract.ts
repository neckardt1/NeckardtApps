export const taskTimeZone = "America/Los_Angeles";

export interface TaskList {
  id: string;
  kind: "private" | "household";
}

// Civil dates are YYYY-MM-DD. Optional civil times are HH:mm in taskTimeZone.
export interface TaskFields {
  title: string;
  plannedDate: string | null;
  plannedTime: string | null;
  deadlineDate: string | null;
  deadlineTime: string | null;
  showAfterDate: string | null;
  showAfterTime: string | null;
}

export interface Task extends TaskFields {
  id: string;
  listId: string;
  version: number;
  // The database resolves an explicit civil visibility gate to an instant.
  showAfterAt: string | null;
}

export interface TaskSnapshot {
  lists: TaskList[];
  tasks: Task[]; // Active tasks in accessible lists, including future tasks.
  focusDay: string; // Pacific day for which suppression was read.
  // Only the current user's choices, newest first.
  focus: { taskId: string; state: "promoted" | "deprioritized" }[];
}

export interface TaskActivity {
  event_id: string;
  happened_at: string;
  action: string;
  by_you: boolean;
  is_undo: boolean;
  from_date: string | null;
  from_time: string | null;
  to_date: string | null;
  to_time: string | null;
}

export interface CompletedTask {
  task_id: string;
  list_id: string;
  title: string;
  completed_at: string;
}

export interface TasksAdapter {
  read(): Promise<TaskSnapshot>;
  create(listId: string, requestId: string, fields: TaskFields): Promise<string>;
  history(taskId: string, before?: string): Promise<TaskActivity[]>;
  completed(before?: CompletedTask): Promise<CompletedTask[]>;
  undo(eventId: string): Promise<void>;
  edit(task: Task, fields: TaskFields): Promise<string | null>;
  reschedule(task: Task, date: string | null, time: string | null): Promise<string | null>;
  complete(task: Task): Promise<string | null>;
  promote(task: Task): Promise<string | null>;
  deprioritize(task: Task): Promise<string | null>;
}
