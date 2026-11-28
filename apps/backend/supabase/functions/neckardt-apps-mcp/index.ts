import { createHandler } from "./server.ts";
import { createEvents } from "./apps/habit-practice/events.ts";
import { DataToolError, type DataRpc } from "./data-tool.ts";

const url = Deno.env.get("SUPABASE_URL")!;
const key = JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") ?? "{}").default ??
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
async function post(name: string, body: Record<string, unknown>) {
  if (!key) throw Error("Missing service credential");
  return fetch(url + "/rest/v1/rpc/" + name, {
    method: "POST", redirect: "error", signal: AbortSignal.timeout(5000),
    headers: { apikey:key, ...(key.startsWith("sb_secret_") ? {} : {Authorization:"Bearer " + key}),
      "Content-Type":"application/json" },
    body: JSON.stringify(body),
  });
}

async function rpc(action: string, payload: Record<string, unknown>) {
  const automatic = action === "subscribe_automatic";
  const response = await post(automatic ? "habit_notify_subscribe_automatic" : "habit_notify_rpc",
    automatic ? {payload} : {action,payload});
  if (!response.ok) throw Error("Notification database unavailable");
  return response.json();
}

const dataRpc: DataRpc = async (client, actor, operation, args, session, receipts) => {
  const response = await post("neckardt_mcp_data", { p_client: client, p_actor: actor, operation, args, p_session: session, p_receipts: receipts });
  if (response.status === 403) throw new DataToolError("Tool or item unavailable for this connection.");
  if (response.status === 409) throw new DataToolError("Conflicting ID or version. Read back the item before retrying.");
  if (response.status === 422 || response.status === 400) throw new DataToolError("Invalid card or task fields.");
  if (!response.ok) throw Error("Data service unavailable");
  return response.json();
};

Deno.serve(createHandler(url, undefined,
  createEvents(rpc, Deno.env.get("HABIT_NOTIFY_DISPATCH_SECRET")), dataRpc));
