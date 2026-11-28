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

export interface TasksAdapter {
  read(): Promise<TaskSnapshot>;
  create(listId: string, requestId: string, fields: TaskFields): Promise<string>;
  edit(task: Task, fields: TaskFields): Promise<void>;
  reschedule(task: Task, date: string | null, time: string | null): Promise<void>;
  complete(task: Task): Promise<void>;
  promote(task: Task): Promise<void>;
  deprioritize(task: Task): Promise<void>;
}
