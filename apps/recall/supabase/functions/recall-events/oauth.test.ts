import assert from "node:assert/strict";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWTPayload } from "npm:jose@6.2.18";
import { createHandler } from "./handler.ts";
import { createOAuth, routeCanary } from "./oauth.ts";

const project = "https://synthetic.supabase.co";
const resource = project + "/functions/v1/recall-events/web/mcp";
const owner = "00000000-0000-4000-8000-000000000001";
const client = "00000000-0000-4000-8000-000000000002";
const session = "00000000-0000-4000-8000-000000000003";
const {privateKey, publicKey} = await generateKeyPair("ES256");
const keys = createLocalJWKSet({keys:[{...await exportJWK(publicKey),kid:"local",alg:"ES256"}]});
const oauth = createOAuth(project, client, owner, keys);
const claims = {iss:project+"/auth/v1",aud:resource,sub:owner,client_id:client,session_id:session,
  role:"recall_canary_oauth",is_anonymous:false,iat:Math.floor(Date.now()/1000),exp:Math.floor(Date.now()/1000)+300};
const sign = (changes: JWTPayload = {}, key=privateKey) => new SignJWT({...claims,...changes})
  .setProtectedHeader({alg:"ES256",kid:"local"}).sign(key);

function fixture(auth = oauth) {
  const actions: string[] = [];
  const db = (action: string, p: Record<string, unknown>) => {
    actions.push(action);
    if (action === "get") return Promise.resolve({synthetic:true,session_id:p.session_id});
    if (action === "subscribe") return Promise.resolve({id:p.id});
    if (action === "unsubscribe") return Promise.resolve({});
    if (action === "auth") return Promise.resolve(false);
    throw Error("Unexpected database operation");
  };
  const hosts = new Set(["chatgpt.com"]);
  const web = createHandler(db,hosts,(_url, post) => Promise.resolve({
    status:200,body:JSON.stringify({challenge:JSON.parse(post.bytes).challenge})}),auth);
  const handle = routeCanary(createHandler(db,hosts),web,auth);
  const rpc = (method: string, params: object = {}, token?: string, url = resource) => handle(new Request(url, {
    method:"POST", headers:token ? {authorization:"Bearer "+token} : {},
    body:JSON.stringify({jsonrpc:"2.0",id:1,method,params}),
  }));
  return {handle,rpc,actions};
}

const subscription = {name:"recall.canary.completed", arguments:{batch_id:"mcp-canary"},
  delivery:{mode:"webhook",url:"https://chatgpt.com/fixture",secret:"whsec_" + "BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc="}};

Deno.test("web discovery links to exact hosted project and prompts for OAuth on protected methods", async () => {
  const f = fixture();
  const challenge = await f.handle(new Request(resource));
  assert.equal(challenge.status,401);
  const metadata = challenge.headers.get("www-authenticate")?.match(/resource_metadata="([^"]+)"/)?.[1];
  assert.ok(metadata);
  assert.match(challenge.headers.get("www-authenticate")!, /error="invalid_token", error_description="Connect to the Recall canary"/);
  const doc = await (await f.handle(new Request(metadata))).json();
  assert.equal(doc.resource,resource);
  assert.deepEqual(doc.authorization_servers,[project+"/auth/v1"]);
  const list = await (await f.rpc("tools/list")).json();
  assert.deepEqual(list.result.tools[0]._meta.securitySchemes,[{type:"oauth2",scopes:["openid"]}]);
  assert.equal((await (await f.rpc("tools/call")).json()).result.isError,true);
  assert.equal((await f.rpc("events/subscribe",subscription)).status,401);
  assert.deepEqual(f.actions,[]);
});

Deno.test("signed synthetic owner uses protected read, subscribe, and unsubscribe on the deployed route", async () => {
  const f=fixture(), token=await sign();
  const read=await (await f.rpc("tools/call",{name:"get_canary",arguments:{session_id:"s1"}},token)).json();
  assert.deepEqual(JSON.parse(read.result.content[0].text),{synthetic:true,session_id:"s1"});
  const stored=await (await f.rpc("events/subscribe",subscription,token,resource.replace("/functions/v1",""))).json();
  assert.match(stored.result.id,/^sub_/);
  const {secret:_, ...delivery} = subscription.delivery;
  await f.rpc("events/unsubscribe",{...subscription,delivery},token);
  assert.deepEqual(f.actions,["get","subscribe","unsubscribe"]);
});

Deno.test("unscoped and misbound credentials fail before database or callback access", async () => {
  const f = fixture();
  const cases: JWTPayload[] = [
    {iss:"https://other.supabase.co/auth/v1"},{aud:"authenticated"},{aud:[resource,"other"]},
    {sub:client},{client_id:owner},{client_id:undefined},{is_anonymous:true},
    {role:"authenticated"},{role:"service_role"},{session_id:undefined},{session_id:"invalid"},
    {exp:1},{nbf:claims.exp+100},{iat:undefined},
  ];
  for (const change of cases) {
    const response=await f.rpc("events/subscribe",subscription,await sign(change));
    assert.ok([401,403].includes(response.status),JSON.stringify(change));
  }
  const different = await generateKeyPair("ES256");
  assert.equal((await f.rpc("events/subscribe",subscription,await sign({},different.privateKey))).status,401);
  assert.equal((await f.rpc("events/subscribe",subscription,"synthetic-opaque-credential")).status,401);
  assert.deepEqual(f.actions,[]);
});

Deno.test("original routes remain isolated, and the OAuth resource fails closed without owner binding", async () => {
  const f = fixture(), token = await sign();
  const base = project + "/functions/v1/recall-events";
  assert.equal((await f.rpc("events/subscribe",subscription,token,base+"/mcp")).status,401);
  assert.equal((await f.rpc("events/subscribe",subscription,token,base+"/web/deliver")).status,404);
  assert.equal((await f.rpc("events/subscribe",subscription,token,base+"/other/mcp")).status,404);
  const unconfigured=fixture(createOAuth(project,client,undefined,keys));
  assert.equal((await unconfigured.rpc("events/subscribe",subscription,token)).status,503);
  assert.deepEqual(unconfigured.actions,[]);
});
