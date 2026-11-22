export type AppsHref = "./" | "../";

export const appStatusLabels = { available: "Open" } as const;

export const apps = [{
  id: "recall",
  name: "Habit Practice",
  path: "recall/",
  status: "available",
  description: "A little practice, every day."
}] as const;

export function appHref(appsHref: AppsHref, app: typeof apps[number]) {
  return appsHref + app.path;
}
