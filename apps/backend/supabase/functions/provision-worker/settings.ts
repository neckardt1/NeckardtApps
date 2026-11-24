import defaults from "../_shared/public-config.json" with { type: "json" };

export function readFixtureSettings(url: string | undefined, read: (name: string) => string | undefined) {
  let ref = read("NECKARDT_APPS_FIXTURE_PROJECT_REF");
  let key = read("NECKARDT_APPS_FIXTURE_KEY");
  if (ref === undefined && key === undefined) {
    ref = read("HABIT_FIXTURE_PROJECT_REF");
    key = read("HABIT_FIXTURE_KEY");
  }
  if (!key) throw new Error("Set the host-scoped NECKARDT_APPS_FIXTURE_KEY for provisioning.");

  const target = ref === undefined ? defaults.url : `https://${ref.trim()}.supabase.co`;
  if (!url || !/^https:\/\/[a-z0-9]{20}\.supabase\.co$/.test(url) || url !== target) {
    throw new Error("Fixture target mismatch. For an alternate project, set a matching NECKARDT_APPS_FIXTURE_PROJECT_REF.");
  }
  return { url, key };
}
