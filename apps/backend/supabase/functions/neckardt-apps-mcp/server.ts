import { createEvents, capabilities } from "./apps/habit-practice/events.ts";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { JWTVerifyGetKey } from "jose";
import { createTokenVerifier, scopes } from "./auth.ts";
import { CallToolRequestSchema, ErrorCode, ListToolsRequestSchema, McpError } from "@modelcontextprotocol/sdk/types.js";
import { linkTool, getHabitPracticeLink } from "./apps/habit-practice/tools.ts";

const path = "/neckardt-apps-mcp";
const metadataPath = path + "/.well-known/oauth-protected-resource";
const website = "https://apps.neckardt.com";

export function createHandler(projectUrl: string, clientId?: string, testKeys?: JWTVerifyGetKey, events?: ReturnType<typeof createEvents>) {
  const origin = new URL(projectUrl).origin;
  const issuer = origin + "/auth/v1";
  const resource = origin + "/functions/v1" + path;
  const metadataUrl = origin + "/functions/v1" + metadataPath;
  const accepts = createTokenVerifier(issuer, resource, clientId, testKeys);
  const challenge = `Bearer resource_metadata="${metadataUrl}", scope="openid"`;
  const headers = { "WWW-Authenticate": challenge, "Cache-Control": "no-store" };

  return async (request: Request): Promise<Response> => {
    // The hosted Edge gateway removes /functions/v1 when forwarding a request.
    const requestPath = new URL(request.url).pathname.replace(/^\/functions\/v1(?=\/)/, "").replace(/\/$/, "");
    if (requestPath === metadataPath && ["GET", "HEAD"].includes(request.method)) {
      const metadata = { resource, resource_name: "Neckardt Apps MCP", authorization_servers: [issuer],
        scopes_supported: scopes, bearer_methods_supported: ["header"] };
      return request.method === "HEAD" ? new Response(null) : Response.json(metadata);
    }
    if (requestPath === path + "/deliver" && events) {
      try { return await events.deliver(request); }
      catch { return new Response(null, { status: 503 }); }
    }
    if (requestPath !== path) return new Response(null, { status: 404 });
    const browserOrigin = request.headers.get("Origin");
    if (browserOrigin && browserOrigin !== website && browserOrigin !== "https://chatgpt.com")
      return new Response(null, { status: 403 });

    const authorization = request.headers.get("Authorization");
    const authenticated = authorization === null ? null : await accepts(authorization);
    if ((authorization !== null && !authenticated) ||
        (!authenticated && ["GET", "HEAD"].includes(request.method))) {
      return new Response(null, { status: 401, headers });
    }
    if (request.method !== "POST")
      return new Response(null, { status: 405, headers: { ...headers, Allow: "POST" } });

    // Discovery works before consent. Every tool call authenticates its own request.
    const server = new Server({ name: "neckardt-apps-mcp", version: "0.1.0", websiteUrl: website },
      { capabilities: events ? capabilities : { tools: {} } });
    if (events) server.fallbackRequestHandler = async req => {
      try { return await events.handle(req.method, req.params, authenticated); }
      catch (error) {
        if (error instanceof McpError) throw error;
        throw new McpError(ErrorCode.InternalError, "Event service unavailable");
      }
    };
    server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: [linkTool] }));
    server.setRequestHandler(CallToolRequestSchema, ({ params }) => {
      if (params.name !== linkTool.name || Object.keys(params.arguments ?? {}).some(k => k !== "debrief") ||
          (params.arguments?.debrief !== undefined && typeof params.arguments.debrief !== "boolean"))
        throw new McpError(ErrorCode.InvalidParams, "Invalid Habit Practice link arguments.");
      if (!authenticated) return {
        isError: true, content: [{ type: "text", text: "Connect Neckardt Apps to continue." }],
        _meta: { "mcp/www_authenticate": [challenge] },
      };
      return getHabitPracticeLink();
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
