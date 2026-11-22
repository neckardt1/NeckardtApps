export type AppsHref = "./" | "../";

export const appStatusLabels = { offline: "Offline" } as const;

export const apps = [{
  id: "recall",
  name: "Habit Practice",
  path: "recall/",
  status: "offline",
  description: "Rebuild underway."
}] as const;

export function appHref(appsHref: AppsHref, app: typeof apps[number]) {
  return appsHref + app.path;
}
