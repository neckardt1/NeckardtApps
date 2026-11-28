import { createHash, timingSafeEqual } from "node:crypto";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { checkedUrl, secretBytes, sendCallback, signedPost, verifyCallback } from "../../callback.mjs";

type Fields = Record<string, unknown>;
type Rpc = (action: string, payload: Fields, grantId?: string) => Promise<unknown>;
type Sender = (url: URL, post: ReturnType<typeof signedPost>) => Promise<{status:number; body:string}>;
const eventName = "habit.practice.round.completed";
const grades = ["miss", "hard", "medium", "easy"];
const actions = ["yes", "no", "no_opportunity", "skip"];
const outcomes = [...grades, ...actions];
const integer = { type: "integer", minimum: 0 };
const nullableTime = { type: ["string", "null"], format: "date-time" };
const itemFields = {
  position: integer,
  item_kind: { enum: ["review", "action"] },
  card_id: { type: "string", format: "uuid" },
  card_name: { type: "string", description: "Card display name captured for this round." },
  front: { type: "string", description: "The recall prompt or habit check question." },
  back: { type: ["string", "null"], description: "The expected recall answer or optional habit cue." },
  answer: { enum: [...outcomes, "superseded"], description: "Saved self-rating or habit response. Superseded means the round recorded no response for this item." },
  grade: { enum: [...grades, null], description: "Scheduling receipt grade. The app displays miss as Again and medium as Good." },
  answered_at: nullableTime,
  due_at: { ...nullableTime, description: "Prior due date captured at the start of the round, when available." },
  next_due_at: { ...nullableTime, description: "Due date assigned by this response. Null for an item that did not reschedule the card." },
};
const dataSchema = {
  type: "object", additionalProperties: false,
  required: ["finished_at","review_count","action_count","superseded_count","outcomes"],
  properties: {
    round_id: { type: "string", format: "uuid" },
    items: { type: "array", description: "Items in presentation order when the owner shared detailed results.", items: { type: "object", properties: itemFields,
      required: Object.keys(itemFields), additionalProperties: false } },
    finished_at: { type: "string", format: "date-time" }, review_count: integer,
    action_count: integer, superseded_count: integer, outcomes: { type: "object",
      additionalProperties: false, properties: Object.fromEntries(outcomes.map(name => [name,integer])) } },
};
const event = {
  name: eventName, description: "A Habit Practice round has finished.",
  delivery: ["webhook"], inputSchema: { type:"object", properties:{
    automatic: { type:"boolean", description:"Send counts for new rounds while this subscription is active." },
    share_items: { type:"boolean", description:"With automatic enabled, also send card names, prompts, answers, grades and due dates to this subscribed chat until you unsubscribe." }
  }, additionalProperties:false },
  payloadSchema: dataSchema,
};
const capabilities = { tools: {}, events: {} };
const dict = (v: unknown): v is Fields => v !== null && typeof v === "object" && !Array.isArray(v);
const invalid = () => new McpError(ErrorCode.InvalidParams, "Invalid event parameters");
const digest = (value:string) => createHash("sha256").update(value).digest();
const uuid = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const count = (v:unknown) => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const optionalTime = (v: unknown) => v === null || typeof v === "string" && Number.isFinite(Date.parse(v));

function roundDetails(row: Fields) {
  if (!("items" in row) && !("round_id" in row)) return {};
  if (typeof row.round_id !== "string" || !uuid.test(row.round_id) || !Array.isArray(row.items))
    throw Error("Invalid round details");
  const items = row.items.map((item: unknown, position: number) => {
    if (!dict(item) || item.position !== position ||
        (item.item_kind !== "review" && item.item_kind !== "action") ||
        typeof item.card_id !== "string" || !uuid.test(item.card_id) ||
        typeof item.card_name !== "string" || typeof item.front !== "string" ||
        !(typeof item.back === "string" || item.back === null) || typeof item.answer !== "string" ||
        !(item.answer === "superseded" || (item.item_kind === "review" ? grades : actions).includes(item.answer)) ||
        !(item.grade === null || typeof item.grade === "string" && grades.includes(item.grade)) ||
        !optionalTime(item.answered_at) || !optionalTime(item.due_at) || !optionalTime(item.next_due_at))
      throw Error("Invalid round item");
    return Object.fromEntries(Object.keys(itemFields).map(key => [key, item[key]]));
  });
  return { round_id: row.round_id, items };
}

export { capabilities };

export function createEvents(db:Rpc, dispatchSecret:string | undefined, send:Sender = sendCallback as Sender) {
  async function handle(method:string, params:unknown, owner:string | null, grantId?:string) {
    if (method === "events/list") return { events:[event] };
    if (method !== "events/subscribe" && method !== "events/unsubscribe")
      throw new McpError(ErrorCode.MethodNotFound, "Method not found");
    if (!owner) throw new McpError(-32001, "Connect Neckardt Apps to subscribe");
    if (!dict(params) || params.name !== eventName || !dict(params.arguments) ||
        Object.keys(params.arguments).some(key => key !== "automatic" && key !== "share_items") ||
        (params.arguments.share_items !== undefined && typeof params.arguments.share_items !== "boolean") ||
        (params.arguments.share_items === true && params.arguments.automatic !== true) ||
        (params.arguments.automatic !== undefined && typeof params.arguments.automatic !== "boolean") || params.cursor != null || !dict(params.delivery) ||
        params.delivery.mode !== "webhook") throw invalid();
    let url:URL;
    try { url = checkedUrl(params.delivery.url); } catch { throw invalid(); }
    const automatic = params.arguments.automatic === true;
    const details = params.arguments.share_items === true;
    const identity = [owner,eventName,url.href];
    if (grantId) identity.push(grantId);
    if (automatic) identity.push("automatic");
    if (details) identity.push("share_items");
    const id = "sub_" + digest(JSON.stringify(identity)).toString("hex").slice(0,40);
    if (method === "events/unsubscribe") {
      await db("unsubscribe", { owner_id:owner,id }, grantId);
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
    const registration = await db(automatic ? "subscribe_automatic" : "subscribe", { owner_id:owner,id,url:url.href,secret,expires_at:expires,
      ...(details ? { share_items:true } : {}) }, grantId);
    const refreshBefore = grantId && dict(registration) && typeof registration.expires_at === "string"
      ? new Date(registration.expires_at).toISOString() : expires;
    return { id,refreshBefore,cursor:null,truncated:false };
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
      const data = { ...roundDetails(row), finished_at:row.finished_at,review_count:row.review_count,
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
