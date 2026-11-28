export const tasksRoute = "/tasks/index.html?";

export const apps = [{
  id: "recall",
  name: "Habit Practice",
  path: "/recall/",
  description: "A little practice, every day."
}, {
  id: "sites",
  name: "Private sites",
  path: "/sites",
  description: "Open your sites and sites shared with you."
}, {
  id: "tasks",
  name: "Tasks",
  path: "/tasks/",
  description: "Your private tasks, Household list, and Today Focus."
}] as const;
