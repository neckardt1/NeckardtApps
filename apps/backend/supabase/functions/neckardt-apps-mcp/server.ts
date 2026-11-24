import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { CallToolRequestSchema, ErrorCode, ListToolsRequestSchema, McpError } from "@modelcontextprotocol/sdk/types.js";
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";

const path = "/neckardt-apps-mcp";
const metadataPath = path + "/.well-known/oauth-protected-resource";
const website = "https://apps.neckardt.com";
const reviewUrl = website + "/recall/";
const uuid = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const scopes = ["openid"];
const securitySchemes = [{ type: "oauth2", scopes }];
const linkTool = {
  name: "get_habit_practice_link",
  title: "Open Habit Practice",
  description: "Get the link to start or resume a review in the Habit Practice web app.",
  inputSchema: { type: "object" as const, properties: {}, additionalProperties: false },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  securitySchemes,
  _meta: { securitySchemes },
};

export function createHandler(projectUrl: string, clientId?: string, testKeys?: JWTVerifyGetKey) {
  const origin = new URL(projectUrl).origin;
  const issuer = origin + "/auth/v1";
  const resource = origin + "/functions/v1" + path;
  const metadataUrl = origin + "/functions/v1" + metadataPath;
  const keys = testKeys ?? createRemoteJWKSet(new URL(issuer + "/.well-known/jwks.json"));
  const challenge = `Bearer resource_metadata="${metadataUrl}", scope="openid"`;
  const headers = { "WWW-Authenticate": challenge, "Cache-Control": "no-store" };

  async function accepts(authorization: string): Promise<boolean> {
    if (!clientId || !uuid.test(clientId) || authorization.length > 16384) return false;
    const bearer = /^Bearer ([^\s]+)$/i.exec(authorization);
    if (!bearer) return false;
    try {
      const { payload } = await jwtVerify(bearer[1], keys, {
        issuer, audience: resource, algorithms: ["ES256", "RS256"],
        requiredClaims: ["exp", "iat", "sub", "client_id", "role", "session_id", "is_anonymous"],
      });
      return payload.aud === resource && payload.client_id === clientId &&
        payload.role === "neckardt_apps_oauth" && payload.is_anonymous === false &&
        typeof payload.sub === "string" && uuid.test(payload.sub) &&
        typeof payload.session_id === "string" && uuid.test(payload.session_id);
    } catch {
      return false;
    }
  }

  return async (request: Request): Promise<Response> => {
    // The hosted Edge gateway removes /functions/v1 when forwarding a request.
    const requestPath = new URL(request.url).pathname.replace(/^\/functions\/v1(?=\/)/, "").replace(/\/$/, "");
    if (requestPath === metadataPath && ["GET", "HEAD"].includes(request.method)) {
      const metadata = { resource, resource_name: "Neckardt Apps MCP", authorization_servers: [issuer],
        scopes_supported: scopes, bearer_methods_supported: ["header"] };
      return request.method === "HEAD" ? new Response(null) : Response.json(metadata);
    }
    if (requestPath !== path) return new Response(null, { status: 404 });
    const browserOrigin = request.headers.get("Origin");
    if (browserOrigin && browserOrigin !== website && browserOrigin !== "https://chatgpt.com")
      return new Response(null, { status: 403 });

    const authorization = request.headers.get("Authorization");
    const authenticated = authorization !== null && await accepts(authorization);
    if ((authorization !== null && !authenticated) ||
        (!authenticated && ["GET", "HEAD"].includes(request.method))) {
      return new Response(null, { status: 401, headers });
    }
    if (request.method !== "POST")
      return new Response(null, { status: 405, headers: { ...headers, Allow: "POST" } });

    // Discovery works before consent. Every tool call authenticates its own request.
    const server = new Server({ name: "neckardt-apps-mcp", version: "0.1.0", websiteUrl: website },
      { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: [linkTool] }));
    server.setRequestHandler(CallToolRequestSchema, ({ params }) => {
      if (params.name !== linkTool.name || Object.keys(params.arguments ?? {}).length)
        throw new McpError(ErrorCode.InvalidParams, "Expected get_habit_practice_link with no arguments.");
      if (!authenticated) return {
        isError: true, content: [{ type: "text", text: "Connect Neckardt Apps to continue." }],
        _meta: { "mcp/www_authenticate": [challenge] },
      };
      return { content: [{ type: "text", text: reviewUrl }], structuredContent: { url: reviewUrl } };
    });
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined, enableJsonResponse: true, maxRequestBodySize: 65536,
    });
    await server.connect(transport);
    try {
      const response = await transport.handleRequest(request);
      const resultHeaders = new Headers(response.headers);
      resultHeaders.set("WWW-Authenticate", challenge);
      resultHeaders.set("Cache-Control", "no-store");
      return new Response(response.body, { status: response.status, headers: resultHeaders });
    } finally {
      await server.close();
    }
  };
}
