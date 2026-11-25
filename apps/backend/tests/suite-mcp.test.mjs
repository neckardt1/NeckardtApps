import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { createHandler } from "../supabase/functions/neckardt-apps-mcp/server.ts";
import { apps } from "../../web/src/shell/apps.ts";

test("the suite MCP resource requires a signed grant for its own audience and OAuth client", async (t) => {
  const origin = "https://suite.example.invalid";
  const endpoint = origin + "/functions/v1/neckardt-apps-mcp";
  const metadataUrl = endpoint + "/.well-known/oauth-protected-resource";
  const clientId = randomUUID();
  const { publicKey, privateKey } = await generateKeyPair("ES256");
  const keys = createLocalJWKSet({ keys: [{ ...await exportJWK(publicKey), kid: "test" }] });
  const handler = createHandler(origin, clientId, keys);
  const issuer = origin + "/auth/v1";
  const claims = { sub: randomUUID(), session_id: randomUUID(), role: "neckardt_apps_oauth",
    client_id: clientId, is_anonymous: false, aud: endpoint, iss: issuer };

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
  await t.test("a grant for the suite returns the launcher's existing Habit Practice URL", async () => {
    const { result } = await (await rpc("tools/call", call, await token())).json();
    const app = apps.find(app => app.name === "Habit Practice");
    assert.deepEqual(result.structuredContent, { url: new URL(app.path, "https://apps.neckardt.com").href });
    assert.equal(result.content[0].text, result.structuredContent.url);
  });
  await t.test("a first-party, canary, or mismatched token cannot call the tool", async () => {
    for (const different of [{ role: "authenticated", aud: "authenticated" }, { role: "recall_canary_oauth" },
      { aud: endpoint + "/other" }, { aud: [endpoint, "authenticated"] }, { iss: origin + "/other" },
      { client_id: randomUUID() }, { is_anonymous: true }]) {
      const response = await rpc("tools/call", call, await token(different));
      assert.equal(response.status, 401, JSON.stringify(different));
    }
    const unbound = createHandler(origin, undefined, keys);
    assert.equal((await rpc("tools/call", call, await token(), unbound)).status, 401);
  });
});
