import { createHash } from "node:crypto";
import { challengeCallback, rejectedHost, secretBytes, send, signedPost, validateUrl, type Transport } from "./callback.ts";

const eventName = "recall.canary.completed";
const batch = "mcp-canary";
const capabilities = {tools: {}, events: {}};
const objectSchema = (properties: Record<string, object>) => ({
  type: "object", properties, required: Object.keys(properties), additionalProperties: false,
});
const event = {
  name: eventName, description: "A synthetic test session completed.",
  delivery: ["webhook"], inputSchema: objectSchema({batch_id: {type:"string", enum:[batch]}}),
  payloadSchema: objectSchema({batch_id:{type:"string"}, session_id:{type:"string"}, synthetic:{type:"boolean", const:true}}),
};
const readTool = {
  name: "get_canary", description: "Read the receipt for a synthetic test session by its ID.",
  inputSchema: objectSchema({session_id:{type:"string",maxLength:96}}),
  annotations: {readOnlyHint:true, destructiveHint:false, openWorldHint:false},
};
type Dict = Record<string, unknown>;
type Database = (action: string, payload: Dict) => Promise<unknown>;
type Delivery = {
  subscription_id:string, event_id:string, session_id:string, batch_id:string, saved_at:string,
  callback_url:string, secret:string, old_secret?:string|null, attempt_id:string,
};
const isObject = (v: unknown): v is Dict => v !== null && typeof v === "object" && !Array.isArray(v);
const onlyKeys = (v: Dict, keys: string[]) => Object.keys(v).every(key => keys.includes(key));
const validId = (v: unknown): v is string => typeof v === "string" && /^[a-zA-Z0-9_-]{1,96}$/.test(v);
export const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const json = (value: unknown, status = 200) => Response.json(value, {status, headers: {"cache-control":"no-store"}});
class ProtocolError extends Error {
  code: number;
  data?: Dict;
  constructor(code: number, message: string, data?: Dict) { super(message); this.code = code; this.data = data; }
}
const invalid = () => new ProtocolError(-32602, "Invalid parameters");
const unauthorized = () => json({error:"Unauthorized"}, 401);

async function readBody(req: Request) {
  const reader = req.body?.getReader();
  if (!reader) throw new ProtocolError(-32700, "Missing body");
  const decoder = new TextDecoder("utf-8", {fatal:true});
  let text = "", size = 0;
  try {
    while (true) {
      const {done, value} = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 32768) throw new ProtocolError(-32600, "Request too large");
      text += decoder.decode(value, {stream:true});
    }
    return JSON.parse(text + decoder.decode());
  } finally { await reader.cancel().catch(() => {}); }
}

export type OAuthPolicy = {
  scheme: {type: string, scopes: string[]}[];
  authorize: (req: Request, id: string | number, method: string) => Promise<Response | undefined>;
};
export function createHandler(db: Database, hosts: ReadonlySet<string>, transport: Transport = send, oauth?: OAuthPolicy) {
  async function subscription(p: Dict, remove: boolean) {
    if (p.name !== eventName || !isObject(p.arguments) || p.arguments.batch_id !== batch ||
        !onlyKeys(p.arguments, ["batch_id"]) || !isObject(p.delivery) ||
        p.delivery.mode !== "webhook" || p.cursor != null ||
        !onlyKeys(p.delivery, remove ? ["mode","url"] : ["mode","url","secret"])) throw invalid();
    let url: URL;
    try { url = validateUrl(p.delivery.url, hosts); }
    catch { throw new ProtocolError(-32015, "CallbackEndpointError", {reason:"disallowed_endpoint", ...rejectedHost(p.delivery.url)}); }
    const id = "sub_" + hash(JSON.stringify(["synthetic-owner",url.href,eventName,batch])).slice(0,40);
    if (remove) return await db("unsubscribe", {id});
    const ttl = p.ttlMs ?? 3600000;
    if (typeof ttl !== "number" || !Number.isSafeInteger(ttl) || ttl <= 0) throw invalid();
    const secret = p.delivery.secret;
    if (typeof secret !== "string") throw invalid();
    try { secretBytes(secret); } catch { throw invalid(); }
    let verified = false;
    try { verified = await challengeCallback(url, id, secret, transport); } catch { /* fail closed */ }
    if (!verified) throw new ProtocolError(-32015, "CallbackEndpointError", {reason:"challenge_failed"});
    return await db("subscribe", {id, batch_id:batch, callback_url:url.href, secret, ttl_ms:Math.min(ttl, 86400000)});
  }

  async function deliver(input: unknown, tokenHash: string) {
    if (!isObject(input) || !validId(input.event_id) || !onlyKeys(input, ["event_id"]))
      return json({error:"Invalid event"},400);
    const claims = await db("claim", {event_id:input.event_id,delivery_token_hash:tokenHash});
    if (claims === null) return unauthorized();
    if (!Array.isArray(claims)) throw Error("Unexpected claim response");
    for (const row of claims as Delivery[]) {
      let status = 0;
      let retryAfter: string | undefined;
      try {
        const url = validateUrl(row.callback_url, hosts);
        const data = {batch_id:row.batch_id,session_id:row.session_id,synthetic:true};
        const body = {eventId:row.event_id,name:eventName,timestamp:row.saved_at,data,cursor:null};
        const secrets = row.old_secret ? [row.secret,row.old_secret] : [row.secret];
        const response = await transport(url, signedPost(body,row.event_id,row.subscription_id,secrets));
        status = response.status;
        retryAfter = response.retryAfter;
      } catch { /* A failed or timed-out callback has unknown outcome and may be retried. */ }
      await db("ack",{event_id:row.event_id,subscription_id:row.subscription_id,
        attempt_id:row.attempt_id,http_status:status,retry_after:retryAfter});
    }
    return json({processed:claims.length});
  }

  return async function handle(req: Request): Promise<Response> {
    if (req.method !== "POST") return new Response(null, {status:405,headers:{Allow:"POST"}});
    const route = new URL(req.url).pathname.replace(/\/$/, "").split("/").at(-1);
    if (route !== "mcp" && route !== "deliver" && route !== "recall-events") return json({error:"Unknown route"},404);
    // This endpoint is used server-to-server and does not accept browser-origin calls.
    if (req.headers.has("origin")) return json({error:"Browser-origin requests disabled"},403);
    const match = req.headers.get("authorization")?.match(/^Bearer ([^\s]{16,512})$/i);
    const tokenHash = match ? hash(match[1]) : "";
    if (route === "deliver" && !tokenHash) return unauthorized();
    let input;
    try { input = await readBody(req); } catch (e) {
      return json({jsonrpc:"2.0",id:null,error:{code:e instanceof ProtocolError ? e.code : -32700,message:"Invalid request body"}}, 400);
    }
    if (route === "deliver") {
      try { return await deliver(input, tokenHash); }
      catch { return json({error:"Delivery unavailable"},503); }
    }
    if (!isObject(input) || input.jsonrpc !== "2.0" || typeof input.method !== "string" ||
        (input.params !== undefined && !isObject(input.params)) ||
        (input.id !== undefined && typeof input.id !== "string" && typeof input.id !== "number"))
      return json({jsonrpc:"2.0",id:null,error:{code:-32600,message:"Invalid Request"}},400);
    const {id, method} = input;
    if (id === undefined) return new Response(null,{status:202});
    const p = (input.params ?? {}) as Dict;
    try {
      let result: unknown;
      switch (method) {
        case "initialize": result = {protocolVersion:"2025-03-26", capabilities,
          serverInfo:{name:"recall-mcp-canary",version:"0.1.0"}}; break;
        case "server/discover": result = {resultType:"complete",supportedVersions:["2026-07-28"],capabilities}; break;
        case "ping": result = {}; break;
        case "events/list": result = {events:[event]}; break;
        case "tools/list": result = {tools:[oauth
          ? {...readTool, securitySchemes:oauth.scheme, _meta:{securitySchemes:oauth.scheme}}
          : readTool]}; break;
        case "events/subscribe":
        case "events/unsubscribe":
        case "tools/call": {
          if (oauth) {
            const denied = await oauth.authorize(req, id as string | number, method);
            if (denied) return denied;
          } else if (!tokenHash || await db("auth",{token_hash:tokenHash}) !== true) return unauthorized();
          if (method === "tools/call") {
            if (p.name !== readTool.name || !isObject(p.arguments) || !onlyKeys(p.arguments, ["session_id"]) ||
                !validId(p.arguments.session_id)) throw invalid();
            const record = await db("get", {session_id:p.arguments.session_id});
            result = {content:[{type:"text",text:JSON.stringify(record)}]};
          } else {
            result = await subscription(p, method === "events/unsubscribe");
          }
          break;
        }
        default: throw new ProtocolError(-32601, "Method not found");
      }
      return json({jsonrpc:"2.0",id,result});
    } catch (e) {
      const error = e instanceof ProtocolError ? e : new ProtocolError(-32603, "Internal error");
      return json({jsonrpc:"2.0",id,error:{code:error.code,message:error.message,data:error.data}});
    }
  };
}
