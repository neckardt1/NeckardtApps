export function readFixtureSettings(read: (name: string) => string | undefined) {
  const projectRef = read("NECKARDT_APPS_FIXTURE_PROJECT_REF");
  const key = read("NECKARDT_APPS_FIXTURE_KEY");
  if (projectRef !== undefined || key !== undefined) return { projectRef, key };

  // Older worker environments can migrate the binding and its credential together.
  return { projectRef: read("HABIT_FIXTURE_PROJECT_REF"), key: read("HABIT_FIXTURE_KEY") };
}
