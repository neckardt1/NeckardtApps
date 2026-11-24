import { readFileSync } from "node:fs";
import { readPublicSupabaseConfig } from "./src/shell/browser-auth.mts";

export function loadPublicBuildConfig(env: NodeJS.ProcessEnv = process.env) {
  const defaults: unknown = JSON.parse(readFileSync(new URL("./public-config.json", import.meta.url), "utf8"));
  const overrides = [
    { url: env.NECKARDT_APPS_SUPABASE_URL?.trim(), publishableKey: env.NECKARDT_APPS_SUPABASE_PUBLISHABLE_KEY?.trim() },
    { url: env.RECALL_SUPABASE_URL?.trim(), publishableKey: env.RECALL_SUPABASE_PUBLISHABLE_KEY?.trim() }
  ].find(pair => pair.url || pair.publishableKey);
  const config = readPublicSupabaseConfig(overrides ?? defaults);
  if (!config) throw new Error("Set both the public HTTPS Supabase URL and sb_publishable_ key. Do not use a server key.");
  return config;
}
