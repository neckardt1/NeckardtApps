import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { createHandler, hash } from "./handler.ts";
import { validateUrl } from "./callback.ts";

const mcpToken = "local-synthetic-mcp-token";
const dispatchToken = "local-synthetic-dispatch-token";
const callbackKey = Buffer.alloc(32, 7);
const secret = "whsec_" + callbackKey.toString("base64");
const subscription = {name:"recall.canary.completed",arguments:{batch_id:"mcp-canary"},
  delivery:{mode:"webhook",url:"https://chatgpt.com/test",secret}};
function request(route, data, key) {
  return new Request("https://edge.example/functions/v1/recall-events/" + route, {
    method:"POST", headers:key ? {authorization:"Bearer " + key} : {}, body:JSON.stringify(data),
  });
}
function fixture(oauth) {
  let stored, acknowledged = false, callbacks = 0;
  const calls = [];
  const db = async (action, p) => {
    calls.push(action);
    switch (action) {
      case "auth": return p.token_hash === hash(mcpToken);
      case "subscribe": stored = p; return {id:p.id,cursor:null,truncated:false};
      case "unsubscribe": stored = null; return {};
      case "claim":
        if (p.delivery_token_hash !== hash(dispatchToken)) return null;
        if (acknowledged || !stored) return [];
        return [{...stored, subscription_id:stored.id, event_id:"evt_uuid", session_id:"session",
          batch_id:"mcp-canary",saved_at:"2026-01-01T00:00:00Z",attempt_id:"attempt"}];
      case "ack": assert.equal(p.http_status, 204); acknowledged = true; return {};
      default: throw Error("Unexpected RPC " + action);
    }
  };
  const transport = async (url, {bytes,headers}) => {
    assert.equal(url.hostname,"chatgpt.com");
    const id = headers["webhook-id"], ts = headers["webhook-timestamp"];
    const signature = createHmac("sha256",callbackKey).update(id+"."+ts+"."+bytes).digest("base64");
    assert.equal(headers["webhook-signature"],"v1,"+signature);
    const payload = JSON.parse(bytes);
    if (payload.type === "verification") return {status:200,body:JSON.stringify({challenge:payload.challenge})};
    assert.equal(payload.eventId,id);
    assert.deepEqual(payload.data,{batch_id:"mcp-canary",session_id:"session",synthetic:true});
    callbacks++;
    return {status:204,body:""};
  };
  const handle = createHandler(db,new Set(["chatgpt.com"]),transport,oauth);
  const rpc = (method, params, key) => handle(request("mcp",{jsonrpc:"2.0",id:1,method,params},key));
  return {rpc,handle,calls,get callbacks(){return callbacks;}};
}

test("discovery is read-only; distinct credentials protect subscription and delivery",async()=>{
  const f = fixture();
  const list = await (await f.rpc("events/list",{})).json();
  assert.equal(list.result.events[0].name, "recall.canary.completed");
  assert.deepEqual(f.calls,[]);
  assert.equal((await f.rpc("events/subscribe",subscription)).status,401);
  const sub = await (await f.rpc("events/subscribe",subscription,mcpToken)).json();
  assert.match(sub.result.id,/^sub_[0-9a-f]{40}$/);
  assert.equal((await f.handle(request("deliver",{event_id:"evt_uuid"},mcpToken))).status,401);
  const dispatch = () => f.handle(request("deliver",{event_id:"evt_uuid"},dispatchToken));
  assert.deepEqual(await (await dispatch()).json(),{processed:1});
  assert.deepEqual(await (await dispatch()).json(),{processed:0});
  assert.equal(f.callbacks,1);
  const {secret:_,...delivery} = subscription.delivery;
  assert.deepEqual((await (await f.rpc("events/unsubscribe",{...subscription,delivery},mcpToken)).json()).result,{});
});

test("a signed subscriber cannot direct callback traffic to an unapproved origin",async()=>{
  const f = fixture();
  for(const url of ["https://chatgpt.com.unrelated.test/cb","https://127.0.0.1/cb","https://chatgpt.com:8443/cb"]) {
    const result = await (await f.rpc("events/subscribe",{...subscription,delivery:{...subscription.delivery,url}},mcpToken)).json();
    assert.equal(result.error.code,-32015);
  }
  assert.deepEqual(f.calls,["auth","auth","auth"]);
});

test("disallowed first-party host diagnosis includes only the host",async()=>{
  const f = fixture();
  const url = "https://alternate.openai.com/private-path?secret=private-value";
  const reply = await (await f.rpc("events/subscribe",{...subscription,delivery:{...subscription.delivery,url}},mcpToken)).json();
  assert.deepEqual(reply.error.data,{reason:"disallowed_endpoint",callback_host:"alternate.openai.com"});
  assert.equal(JSON.stringify(reply).includes("private-"),false);
});

test("MCP diagnostics report one bounded outcome per call without disclosing caller values", async t => {
  const lines = [];
  t.mock.method(console, "info", (...args) => lines.push(args));
  const privateValue = "synthetic-private-value";
  const f = fixture({scheme:[],authorize:async req =>
    req.headers.get("authorization") === "Bearer " + mcpToken ? undefined : new Response(null,{status:401})});

  async function check(reply, method, outcome, status = 200, extra = {}) {
    const response = await reply;
    assert.equal(response.status,status);
    assert.equal(lines.length,1);
    const args = lines.pop();
    assert.equal(args.length,1);
    const {time,...fields} = JSON.parse(args[0]);
    assert.equal(new Date(time).toISOString(),time);
    assert.deepEqual(fields,{method,outcome,...extra});
    return response;
  }

  await check(f.rpc("ping",{privateValue}),"ping","ok");
  await check(f.rpc("events/subscribe",subscription),"events/subscribe","missing_auth",401);
  await check(f.rpc("events/subscribe",subscription,privateValue),"events/subscribe","auth_rejected",401);
  const invalid = await check(f.rpc("events/subscribe",{...subscription,name:privateValue},mcpToken),
    "events/subscribe","invalid_params");
  assert.equal((await invalid.json()).error.code,-32602);
  const disallowed = {...subscription,delivery:{...subscription.delivery,url:"https://alternate.openai.com/"+privateValue}};
  await check(f.rpc("events/subscribe",disallowed,mcpToken),"events/subscribe","disallowed_endpoint",200,{callback_rule:"host"});
  await check(f.rpc("events/subscribe",subscription,mcpToken),"events/subscribe","ok");
  const unknown = await check(f.rpc(privateValue,{}),"unknown","method_not_found");
  assert.equal((await unknown.json()).error.code,-32601);
  await check(f.handle(request("mcp",{jsonrpc:"2.0",method:"notifications/initialized"})),
    "notifications/initialized","notification",202);
  await check(f.handle(request("mcp",{jsonrpc:"2.0",id:privateValue,method:{privateValue}})),
    "unknown","invalid_request",400);
  const badBody = route => new Request("https://edge.example/recall-events/"+route,{method:"POST",
    headers:{authorization:"Bearer "+dispatchToken},body:privateValue});
  await check(f.handle(badBody("mcp")),"unknown","parse_error",400);
  assert.equal((await f.handle(badBody("deliver"))).status,400);
  assert.equal((await f.handle(request("deliver",{event_id:"evt_uuid"},dispatchToken))).status,200);
  const legacy = fixture();
  assert.equal((await legacy.rpc("ping",{})).status,200);
  assert.equal((await legacy.rpc("events/subscribe",subscription)).status,401);
  assert.equal((await legacy.rpc("events/subscribe",subscription,mcpToken)).status,200);
  assert.equal((await legacy.handle(badBody("mcp"))).status,400);
  assert.deepEqual(lines,[]);

  const oauth = {scheme:[],authorize:async req => req.headers.has("authorization") ? undefined :
    new Response(null,{status:401,headers:{"www-authenticate":"Bearer"}})};
  const web = createHandler(async()=>{ throw Error(privateValue); },new Set(["chatgpt.com"]),
    async()=>({status:200,body:JSON.stringify({challenge:privateValue})}),oauth);
  const send = (method,params,key) => web(request("web/mcp",{jsonrpc:"2.0",id:privateValue,method,params},key));
  const denied = await check(send("events/subscribe",subscription),"events/subscribe","missing_auth",401);
  assert.equal(denied.headers.get("www-authenticate"),"Bearer");
  const failed = await check(send("events/subscribe",subscription,privateValue),"events/subscribe","challenge_failed");
  assert.equal((await failed.json()).error.data.reason,"challenge_failed");
  const read = await check(send("tools/call",{name:"get_canary",arguments:{session_id:privateValue}},privateValue),
    "tools/call","internal_error");
  assert.deepEqual((await read.json()).error,{code:-32603,message:"Internal error"});
});

test("logging failure preserves protocol responses",async t=>{
  t.mock.method(console,"info",()=>{throw Error("synthetic log failure");});
  const {rpc}=fixture({scheme:[],authorize:async()=>undefined});
  assert.deepEqual(await (await rpc("ping",{})).json(),{jsonrpc:"2.0",id:1,result:{}});
});

test("OAuth subscribe logs only the first URL rejection rule and an exact public label", async t=>{
  const logs=[];
  t.mock.method(console,"info",value=>logs.push(JSON.parse(value)));
  const hosts=new Set(["chatgpt.com"]);
  const policy={scheme:[],authorize:async()=>undefined};
  let dbCalls=0, transports=0;
  const handle=createHandler(async()=>{dbCalls++;},hosts,async()=>{transports++;},policy);
  const privateText="private-fixture";
  // Each row specifies the public v6 error host independently of the log-safe constant.
  const cases=[
    [null,"type"], [42,"type"],
    ["https://chatgpt.com/"+privateText.repeat(400),"length","chatgpt.com"],
    ["invalid "+privateText,"unparseable"],
    ["http://"+privateText+"@platform.openai.com:8080/private#fragment","scheme","platform.openai.com"],
    ["https://"+privateText+":password@platform.openai.com:8443/?secret=value#fragment","credentials","platform.openai.com"],
    ["https://platform.openai.com:8443/private?query=value#fragment","fragment","platform.openai.com"],
    ["https://platform.openai.com:8443/private?query=value","port","platform.openai.com"],
    ["https://PLATFORM.OpenAI.COM/private?query=value","host","platform.openai.com","platform.openai.com"],
    ["https://api.openai.com:443/"+privateText,"host","api.openai.com","api.openai.com"],
    ["https://tenant-"+privateText+".openai.com/path","host","tenant-"+privateText+".openai.com"],
    ["https://tenant-"+privateText+".chatgpt.com/path","host","tenant-"+privateText+".chatgpt.com"],
    ["https://external.example/?hostname=platform.openai.com","host"],
  ];
  async function send(method,url) {
    const delivery={...subscription.delivery,url};
    if (method==="events/unsubscribe") delete delivery.secret;
    return handle(request("web/mcp",{jsonrpc:"2.0",id:privateText,method,params:{...subscription,delivery}}));
  }
  for(const [value,rule,wireHost,knownHost] of cases){
    assert.throws(()=>validateUrl(value,hosts));
    const res=await send("events/subscribe",value);
    assert.equal(res.status,200);
    const data={reason:"disallowed_endpoint",...(wireHost?{callback_host:wireHost}:{})};
    assert.deepEqual(await res.json(),{jsonrpc:"2.0",id:privateText,error:{code:-32015,message:"CallbackEndpointError",data}});
    assert.equal(logs.length,1);
    const {time,...fields}=logs.pop();
    assert.equal(new Date(time).toISOString(),time);
    assert.deepEqual(fields,{method:"events/subscribe",outcome:"disallowed_endpoint",callback_rule:rule,
      ...(knownHost?{callback_host:knownHost}:{})});
  }
  await send("events/unsubscribe","https://platform.openai.com/path");
  const {time,...fields}=logs.pop();
  assert.deepEqual(fields,{method:"events/unsubscribe",outcome:"disallowed_endpoint"});
  // The original policy still accepts the exact configured hostname and normalized default port.
  for(const url of ["https://chatgpt.com/cb","https://CHATGPT.com:443/cb?query=value","https://chatgpt.com/#"]){
    let rejection;
    assert.equal(validateUrl(url,hosts,reason=>{rejection=reason;}).href,new URL(url).href);
    assert.equal(rejection,undefined);
  }
  let known;
  assert.throws(()=>validateUrl("https://chatgpt.com/cb",new Set(),failure=>{known=failure;}));
  assert.deepEqual(known,{rule:"host",knownHost:"chatgpt.com"});
  assert.equal(dbCalls,0);
  assert.equal(transports,0);
});
