import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { createHandler, hash } from "./handler.ts";

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
function fixture() {
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
  const handle = createHandler(db,new Set(["chatgpt.com"]),transport);
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
