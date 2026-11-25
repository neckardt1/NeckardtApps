import { createHash, timingSafeEqual } from "node:crypto";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { checkedUrl, secretBytes, sendCallback, signedPost, verifyCallback } from "../../callback.mjs";

type Fields = Record<string, unknown>;
type Rpc = (action: string, payload: Fields) => Promise<unknown>;
type Sender = (url: URL, post: ReturnType<typeof signedPost>) => Promise<{status:number; body:string}>;
const eventName = "habit.practice.round.completed";
const outcomes = ["miss","hard","medium","easy","yes","no","no_opportunity","skip"];
const integer = { type: "integer", minimum: 0 };
const dataSchema = {
  type: "object", additionalProperties: false,
  required: ["finished_at","review_count","action_count","superseded_count","outcomes"],
  properties: { finished_at: { type: "string", format: "date-time" }, review_count: integer,
    action_count: integer, superseded_count: integer, outcomes: { type: "object",
      additionalProperties: false, properties: Object.fromEntries(outcomes.map(name => [name,integer])) } },
};
const event = {
  name: eventName, description: "One Habit Practice round explicitly shared by its owner has finished.",
  delivery: ["webhook"], inputSchema: { type:"object", properties:{}, additionalProperties:false },
  payloadSchema: dataSchema,
};
const capabilities = { tools: {}, events: {} };
const dict = (v: unknown): v is Fields => v !== null && typeof v === "object" && !Array.isArray(v);
const invalid = () => new McpError(ErrorCode.InvalidParams, "Invalid event parameters");
const digest = (value:string) => createHash("sha256").update(value).digest();
const uuid = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const count = (v:unknown) => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
export { capabilities };

export function createEvents(db:Rpc, dispatchSecret:string | undefined, send:Sender = sendCallback as Sender) {
  async function handle(method:string, params:unknown, owner:string | null) {
    if (method === "server/discover")
      return { resultType:"complete", supportedVersions:["2026-07-28"], capabilities };
    if (method === "events/list") return { events:[event] };
    if (method !== "events/subscribe" && method !== "events/unsubscribe")
      throw new McpError(ErrorCode.MethodNotFound, "Method not found");
    if (!owner) throw new McpError(-32001, "Connect Neckardt Apps to subscribe");
    if (!dict(params) || params.name !== eventName || !dict(params.arguments) ||
        Object.keys(params.arguments).length || params.cursor != null || !dict(params.delivery) ||
        params.delivery.mode !== "webhook") throw invalid();
    let url:URL;
    try { url = checkedUrl(params.delivery.url); } catch { throw invalid(); }
    const id = "sub_" + digest(JSON.stringify([owner,eventName,url.href])).toString("hex").slice(0,40);
    if (method === "events/unsubscribe") {
      await db("unsubscribe", { owner_id:owner,id });
      return {};
    }
    const ttl = params.ttlMs ?? 3600000;
    if (typeof ttl !== "number" || !Number.isSafeInteger(ttl) || ttl <= 0) throw invalid();
    const secret = params.delivery.secret;
    if (typeof secret !== "string") throw invalid();
    try { secretBytes(secret); } catch { throw invalid(); }
    let valid = false;
    try { valid = await verifyCallback(url,id,secret,send); } catch { /* fail closed */ }
    if (!valid) throw new McpError(-32015, "CallbackEndpointError", { reason:"challenge_failed" });
    const expires = new Date(Date.now() + Math.min(ttl,86400000)).toISOString();
    await db("subscribe", { owner_id:owner,id,url:url.href,secret,expires_at:expires });
    return { id,refreshBefore:expires,cursor:null,truncated:false };
  }

  async function deliver(req:Request) {
    if (req.method !== "POST") return new Response(null,{status:405,headers:{Allow:"POST"}});
    const bearer = req.headers.get("Authorization");
    if (req.headers.has("Origin") || !dispatchSecret || dispatchSecret.length < 32 || !bearer ||
        !timingSafeEqual(digest(bearer),digest("Bearer " + dispatchSecret)))
      return new Response(null,{status:401});
    const body = await req.json().catch(() => null);
    if (!dict(body) || Object.keys(body).length !== 1 ||
        typeof body.delivery_id !== "string" || !uuid.test(body.delivery_id))
      return new Response(null,{status:400});
    const row = await db("claim", { delivery_id:body.delivery_id });
    if (row === null) return new Response(null,{status:204});
    let status:number | null = null;
    try {
      if (!dict(row) || row.delivery_id !== body.delivery_id || typeof row.subscription_id !== "string" ||
          typeof row.finished_at !== "string" || !Number.isFinite(Date.parse(row.finished_at)) ||
          !count(row.review_count) || !count(row.action_count) || !count(row.superseded_count) ||
          !dict(row.outcomes)) throw Error("Invalid completion");
      const data = { finished_at:row.finished_at,review_count:row.review_count,
        action_count:row.action_count,superseded_count:row.superseded_count,
        outcomes:Object.fromEntries(Object.entries(row.outcomes).filter(([k,v]) => outcomes.includes(k) && count(v))) };
      const message = { eventId:body.delivery_id,name:eventName,timestamp:row.finished_at,data,cursor:null };
      const result = await send(checkedUrl(row.url),signedPost(message,body.delivery_id,row.subscription_id,row.secret));
      status = result.status;
    } catch { /* Timeouts and other uncertain outcomes consume the single claim. */ }
    await db("ack", {delivery_id:body.delivery_id,http_status:status});
    return new Response(null,{status:status !== null && status >= 200 && status < 300 ? 204 : 502});
  }
  return { handle, deliver };
}
