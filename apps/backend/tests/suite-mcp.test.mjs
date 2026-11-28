import assert from "node:assert/strict";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import test from "node:test";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { createHandler } from "../supabase/functions/neckardt-apps-mcp/server.ts";
import { createEvents } from "../supabase/functions/neckardt-apps-mcp/apps/habit-practice/events.ts";
import { checkedUrl, publicAddress } from "../supabase/functions/neckardt-apps-mcp/callback.mjs";
import { apps } from "../../web/src/shell/apps.ts";

test("the suite MCP resource requires a signed grant for its own audience and OAuth client", async (t) => {
  const origin = "https://suite.example.invalid";
  const endpoint = origin + "/functions/v1/neckardt-apps-mcp";
  const metadataUrl = endpoint + "/.well-known/oauth-protected-resource";
  const clientId = randomUUID();
  const { publicKey, privateKey } = await generateKeyPair("ES256");
  const keys = createLocalJWKSet({ keys: [{ ...await exportJWK(publicKey), kid: "test" }] });
  const handler = createHandler(origin, keys);
  const issuer = origin + "/auth/v1";
  const claims = { sub: randomUUID(), session_id: randomUUID(), role: "neckardt_apps_oauth",
    client_id: clientId, neckardt_mcp: { subscriptions:true, origin:"https://chatgpt.com" }, is_anonymous: false, aud: endpoint, iss: issuer };

  async function token(overrides = {}) {
    return new SignJWT({ ...claims, ...overrides }).setProtectedHeader({ alg: "ES256", kid: "test" })
      .setIssuedAt().setExpirationTime("5m").sign(privateKey);
  }
  function rpc(method, params, bearer, serve = handler) {
    const headers = { "Content-Type": "application/json", Accept: "application/json, text/event-stream" };
    if (bearer) headers.Authorization = "Bearer " + bearer;
    return serve(new Request(endpoint, { method: "POST", headers,
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) }));
  }
  const call = { name: "get_habit_practice_link", arguments: {} };

  await t.test("the HTTP challenge points to exact resource and issuer metadata", async () => {
    const response = await handler(new Request(endpoint));
    assert.equal(response.status, 401);
    assert.ok(response.headers.get("WWW-Authenticate").includes(metadataUrl));
    const meta = await (await handler(new Request(metadataUrl))).json();
    assert.equal(meta.resource, endpoint);
    assert.deepEqual(meta.authorization_servers, [issuer]);
    assert.deepEqual(meta.scopes_supported, ["openid"]);
  });
  await t.test("a fresh client can initialize and discover the protected link tool", async () => {
    const init = await rpc("initialize", { protocolVersion: "2025-11-25", capabilities: {},
      clientInfo: { name: "suite-test", version: "1" } });
    assert.equal((await init.json()).result.serverInfo.name, "neckardt-apps-mcp");
    const { result } = await (await rpc("tools/list", {})).json();
    assert.deepEqual(result.tools.map(tool => tool.name), [call.name]);
    assert.deepEqual(result.tools[0]._meta.securitySchemes, [{ type: "oauth2", scopes: ["openid"] }]);
    const denied = (await (await rpc("tools/call", call)).json()).result;
    assert.equal(denied.isError, true);
    assert.ok(denied._meta["mcp/www_authenticate"][0].includes(metadataUrl));
  });
  await t.test("a registry outage keeps link discovery available and closes data calls", async () => {
    const serve = createHandler(origin, keys, undefined, async () => { throw Error("private fixture error"); });
    const bearer = await token();
    const { result } = await (await rpc("tools/list", {}, bearer, serve)).json();
    assert.deepEqual(result.tools.map(tool => tool.name), [call.name]);
    assert.ok((await (await rpc("tools/call", call, bearer, serve)).json()).result.structuredContent.url);
    const data = (await (await rpc("tools/call", {name:"list_tasks",arguments:{}}, bearer, serve)).json()).result;
    assert.equal(data.isError, true);
    assert.ok(!JSON.stringify(data).includes("private fixture error"));
  });
  await t.test("a grant for the suite returns the launcher's existing Habit Practice URL", async () => {
    const { result } = await (await rpc("tools/call", call, await token())).json();
    const app = apps.find(app => app.name === "Habit Practice");
    assert.deepEqual(result.structuredContent, { url: new URL(app.path, "https://apps.neckardt.com").href });
    assert.equal(result.content[0].text, result.structuredContent.url);
  });
  await t.test("a first-party, canary, or mismatched token cannot call the tool", async () => {
    for (const different of [{ role: "authenticated", aud: "authenticated" }, { role: "recall_canary_oauth" },
      { aud: endpoint + "/other" }, { aud: [endpoint, "authenticated"] }, { iss: origin + "/other" },
      { client_id: "invalid" }, { session_id: "invalid" }, { neckardt_mcp: undefined },
      { neckardt_mcp: { subscriptions:"true", origin:"https://chatgpt.com" } }, { is_anonymous: true }]) {
      const response = await rpc("tools/call", call, await token(different));
      assert.equal(response.status, 401, JSON.stringify(different));
    }
  });
  await t.test("one connected owner registers a verified callback and receives an aggregate once", async () => {
    const secret = "whsec_" + randomBytes(32).toString("base64");
    const dispatch = randomBytes(32).toString("hex");
    const deliveryId = randomUUID();
    const url = "https://connectors.api.openai.com/fixture";
    const name = "habit.practice.round.completed";
    const requests = [];
    const emitted = [];
    let subscribed;
    let pending = true;
    const events = createEvents(async (action, payload) => {
      requests.push([action,payload]);
      if (action === "subscribe" || action === "subscribe_automatic") subscribed = payload;
      if (action === "claim") {
        if (!pending) return null;
        pending = false;
        return {delivery_id:deliveryId, url, secret, subscription_id:subscribed.id,
          finished_at:"2026-11-24T01:02:03Z", review_count:2, action_count:1, superseded_count:0,
          owner_id:claims.sub, front:"private fixture prompt", outcomes:{ medium:2, yes:1, extra:"private" }};
      }
      return true;
    }, dispatch, async (target,post) => {
      assert.equal(target.href,url);
      const headers = post.headers;
      const expected = createHmac("sha256",Buffer.from(secret.slice(6),"base64"))
        .update([headers["webhook-id"],headers["webhook-timestamp"],post.body].join(".")).digest("base64");
      assert.equal(headers["webhook-signature"],"v1," + expected);
      const message = JSON.parse(post.body);
      if (message.type === "verification") return { status:200,body:JSON.stringify({challenge:message.challenge}) };
      emitted.push(message);
      return {status:200,body:""};
    });
    const serve = createHandler(origin,keys,events);
    const call = async (method,params,bearer) => (await rpc(method,params,bearer,serve)).json();
    const auth = await token();
    assert.deepEqual((await call("initialize",{protocolVersion:"2025-11-25",capabilities:{},
      clientInfo:{name:"fixture",version:"1"}})).result.capabilities.events,{});
    assert.ok((await call("server/discover",{})).result.capabilities.events);
    const [definition] = (await call("events/list", {})).result.events;
    assert.equal(definition.name, name);
    const item = definition.payloadSchema.properties.items.items;
    assert.deepEqual(item.required.sort(), ["answer","answered_at","back","card_id","card_name","due_at",
      "front","grade","item_kind","next_due_at","position"].sort());
    assert.equal(definition.payloadSchema.required.includes("items"), false);
    const debriefLink = await call("tools/call",{name:"get_habit_practice_link",arguments:{debrief:true}},auth);
    assert.equal(debriefLink.result.structuredContent.url,"https://apps.neckardt.com/recall/");
    const params = {name,arguments:{},delivery:{mode:"webhook",url,secret}};
    assert.ok((await call("events/subscribe",params)).error);
    assert.ok((await call("events/subscribe",{...params,arguments:{owner_id:randomUUID()}},auth)).error);
    assert.equal(requests.length,0);
    const pilot = await token({ client_id: randomUUID(), neckardt_mcp: { subscriptions:false, origin:"https://agent.example.invalid" } });
    assert.equal((await call("tools/call", {name:"get_habit_practice_link",arguments:{}}, pilot)).result.structuredContent.url,
      "https://apps.neckardt.com/recall/");
    assert.deepEqual((await call("server/discover",{},pilot)).result.capabilities, {tools:{}});
    for (const method of ["events/list","events/subscribe","events/unsubscribe"])
      assert.equal((await call(method,params,pilot)).error.code,-32601);
    assert.equal(requests.length,0);
    const withOrigin = origin => serve(new Request(endpoint, {method:"POST", headers: {Origin:origin,
      Authorization:"Bearer "+pilot, "Content-Type":"application/json", Accept:"application/json, text/event-stream"},
      body:JSON.stringify({jsonrpc:"2.0",id:1,method:"tools/list",params:{}})}));
    assert.equal((await withOrigin("https://agent.example.invalid")).status,200);
    assert.equal((await withOrigin("https://other.example.invalid")).status,403);
    const registered = (await call("events/subscribe",params,auth)).result;
    assert.equal(registered.id,subscribed.id);
    assert.equal(subscribed.owner_id,claims.sub);
    assert.ok((await call("events/subscribe",{...params,arguments:{automatic:"true"}},auth)).error);
    assert.ok((await call("events/subscribe",{...params,arguments:{share_items:true}},auth)).error);
    const autoParams = {...params,arguments:{automatic:true}};
    const automatic = (await call("events/subscribe",autoParams,auth)).result;
    assert.notEqual(automatic.id,registered.id);
    assert.deepEqual(requests.at(-1),["subscribe_automatic",subscribed]);
    assert.equal((await call("events/subscribe",autoParams,auth)).result.id,automatic.id);
    const detailedParams = {...params,arguments:{automatic:true,share_items:true}};
    const detailed = (await call("events/subscribe",detailedParams,auth)).result;
    assert.notEqual(detailed.id,automatic.id);
    assert.equal(subscribed.share_items,true);
    assert.equal((await call("events/subscribe",detailedParams,auth)).result.id,detailed.id);
    const deliver = bearer => serve(new Request(endpoint+"/deliver",{method:"POST",
      headers:{Authorization:"Bearer "+bearer,"Content-Type":"application/json"},
      body:JSON.stringify({delivery_id:deliveryId})}));
    assert.equal((await deliver(auth)).status,401);
    assert.equal((await deliver(pilot)).status,401);
    assert.equal((await deliver(dispatch)).status,204);
    assert.equal((await deliver(dispatch)).status,204);
    assert.equal(emitted.length,1);
    assert.deepEqual(emitted[0],{eventId:deliveryId,name,timestamp:"2026-11-24T01:02:03Z",cursor:null,
      data:{finished_at:"2026-11-24T01:02:03Z",review_count:2,action_count:1,superseded_count:0,outcomes:{medium:2,yes:1}}});
    assert.deepEqual(requests.filter(([a])=>a==="ack"),[["ack",{delivery_id:deliveryId,http_status:200}]]);
    const unsub = await call("events/unsubscribe",{...params,delivery:{mode:"webhook",url}},auth);
    assert.deepEqual(unsub.result,{});
    assert.deepEqual(requests.at(-1),["unsubscribe",{owner_id:claims.sub,id:registered.id}]);
  });

});

test("callbacks require the exact HTTPS origin and an exclusively public IPv4 answer set", () => {
  for (const url of ["http://connectors.api.openai.com/", "https://a.connectors.api.openai.com/",
    "https://example@connectors.api.openai.com", "https://connectors.api.openai.com:444/a",
    "https://connectors.api.openai.com/#fragment"])
    assert.throws(()=>checkedUrl(url));
  for (const list of [[],["127.0.0.1"],["8.8.8.8","169.254.169.254"],["::1"]])
    assert.throws(()=>publicAddress(list));
  assert.equal(publicAddress(["8.8.8.8"]),"8.8.8.8");
});
