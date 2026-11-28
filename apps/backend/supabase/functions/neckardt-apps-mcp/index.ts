import { createClient } from "@supabase/supabase-js";
import { firstPartyOwner } from "../_shared/first-party-owner.ts";
import { createHandler } from "./server.ts";
import { createBroker } from "./oauth.ts";
import { createEvents } from "./apps/habit-practice/events.ts";

const url = Deno.env.get("SUPABASE_URL")!;
const key = JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") ?? "{}").default ??
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
const publicKey = JSON.parse(Deno.env.get("SUPABASE_PUBLISHABLE_KEYS") ?? "{}").default ??
  Deno.env.get("SUPABASE_ANON_KEY");

async function rpc(name: string, args: Record<string, unknown>) {
  if (!key) throw Error("Missing service credential");
  const response = await fetch(url + "/rest/v1/rpc/" + name, {
    method: "POST", redirect: "error", signal: AbortSignal.timeout(5000),
    headers: { apikey:key, ...(key.startsWith("sb_secret_") ? {} : {Authorization:"Bearer " + key}),
      "Content-Type":"application/json" },
    body: JSON.stringify(args),
  });
  if (!response.ok) throw Error("Database unavailable");
  return response.json();
}

const auth = publicKey && createClient(url, publicKey, { auth:{
  persistSession:false, autoRefreshToken:false, detectSessionInUrl:false,
} }).auth;
const resource = new URL("/functions/v1/neckardt-apps-mcp", url).href;
const broker = createBroker(resource, (action, p) => rpc("mcp_oauth_grant", { action, p }),
  jwt => auth ? firstPartyOwner(auth, new URL("/auth/v1", url).href, jwt) : Promise.resolve(null));
const events = createEvents((action, payload, grant) => {
  if (grant) return rpc("mcp_oauth_event", { action, payload, grant_id:grant });
  if (action === "subscribe_automatic") return rpc("habit_notify_subscribe_automatic", { payload });
  return rpc("habit_notify_rpc", { action, payload });
}, Deno.env.get("HABIT_NOTIFY_DISPATCH_SECRET"));

Deno.serve(createHandler(url, broker, Deno.env.get("NECKARDT_APPS_OAUTH_CLIENT_ID"), undefined, events));
