import { isOpenAIHost } from "./callback.ts";
import { createHandler } from "./handler.ts";
import { createOAuth, routeCanary } from "./oauth.ts";

const url = Deno.env.get("SUPABASE_URL")!;
const credential = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
// Add an exact host after verifying a differently hosted first-party callback.
const callbackHost = Deno.env.get("RECALL_CALLBACK_HOST");
const allowedHosts = new Set(callbackHost ? [callbackHost] : ["chatgpt.com", "api.openai.com"]);
if (callbackHost && !isOpenAIHost(callbackHost)) {
  throw Error("Configure an exact OpenAI callback hostname");
}
const db = async (action: string, payload: Record<string, unknown>) => {
  const response = await fetch(url + "/rest/v1/rpc/recall_canary_db", {
    method:"POST",
    headers:{"content-type":"application/json", apikey:credential, authorization:"Bearer " + credential},
    body:JSON.stringify({action, payload}),
    signal:AbortSignal.timeout(10000),
  });
  if (!response.ok) throw Error("Canary storage request failed");
  return await response.json();
};
const oauth = createOAuth(url, Deno.env.get("RECALL_OAUTH_CLIENT_ID"), Deno.env.get("RECALL_OAUTH_USER_ID"));
Deno.serve(routeCanary(createHandler(db, allowedHosts), createHandler(db, allowedHosts, undefined, oauth), oauth));
