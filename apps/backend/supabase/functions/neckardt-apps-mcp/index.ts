import { createHandler } from "./server.ts";
import { createEvents } from "./apps/habit-practice/events.ts";

const url = Deno.env.get("SUPABASE_URL")!;
const key = JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") ?? "{}").default ??
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
async function rpc(action: string, payload: Record<string, unknown>) {
  if (!key) throw Error("Missing service credential");
  const automatic = action === "subscribe_automatic";
  const name = automatic ? "habit_notify_subscribe_automatic" : "habit_notify_rpc";
  const response = await fetch(url + "/rest/v1/rpc/" + name, {
    method: "POST", redirect: "error", signal: AbortSignal.timeout(5000),
    headers: { apikey:key, ...(key.startsWith("sb_secret_") ? {} : {Authorization:"Bearer " + key}),
      "Content-Type":"application/json" },
    body: JSON.stringify(automatic ? {payload} : {action,payload}),
  });
  if (!response.ok) throw Error("Notification database unavailable");
  return response.json();
}

Deno.serve(createHandler(url, undefined,
  createEvents(rpc, Deno.env.get("HABIT_NOTIFY_DISPATCH_SECRET"))));
