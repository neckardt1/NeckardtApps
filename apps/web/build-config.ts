import { readFileSync } from "node:fs";
import { readPublicSupabaseConfig } from "./src/shell/browser-auth.mts";

export function loadPublicBuildConfig(env: NodeJS.ProcessEnv = process.env) {
  const defaults: unknown = JSON.parse(readFileSync(new URL("./public-config.json", import.meta.url), "utf8"));
  const url = env.RECALL_SUPABASE_URL?.trim() ?? "";
  const publishableKey = env.RECALL_SUPABASE_PUBLISHABLE_KEY?.trim() ?? "";
  const config = readPublicSupabaseConfig(url || publishableKey ? { url, publishableKey } : defaults);
  if (!config) throw new Error("Set both the public HTTPS Supabase URL and sb_publishable_ key. Do not use a server key.");
  return config;
}
