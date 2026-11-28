import { createEvents, capabilities } from "./apps/habit-practice/events.ts";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { JWTVerifyGetKey } from "jose";
import { createTokenVerifier, scopes } from "./auth.ts";
import { type CallToolRequest, type JSONRPCRequest, CallToolRequestSchema, ErrorCode, ListToolsRequestSchema, McpError } from "@modelcontextprotocol/sdk/types.js";
import { linkTool, getHabitPracticeLink } from "./apps/habit-practice/tools.ts";
import { cardTools } from "./apps/habit-practice/cards.ts";
import { taskTools } from "./apps/tasks/tools.ts";
import { DataToolError, type DataRpc } from "./data-tool.ts";

const dataTools = [...cardTools, ...taskTools];
const path = "/neckardt-apps-mcp";
const metadataPath = path + "/.well-known/oauth-protected-resource";
const website = "https://apps.neckardt.com";

export function createHandler(projectUrl: string, testKeys?: JWTVerifyGetKey, events?: ReturnType<typeof createEvents>, dataRpc?: DataRpc) {
  const origin = new URL(projectUrl).origin;
  const issuer = origin + "/auth/v1";
  const resource = origin + "/functions/v1" + path;
  const metadataUrl = origin + "/functions/v1" + metadataPath;
  const accepts = createTokenVerifier(issuer, resource, testKeys);
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
    const authorization = request.headers.get("Authorization");
    const authenticated = authorization === null ? null : await accepts(authorization);
    if ((authorization !== null && !authenticated) ||
        (!authenticated && ["GET", "HEAD"].includes(request.method))) {
      return new Response(null, { status: 401, headers });
    }
    if (browserOrigin && browserOrigin !== website && browserOrigin !== authenticated?.origin)
      return new Response(null, authenticated ? { status: 403 } : { status: 401, headers });
    if (request.method !== "POST")
      return new Response(null, { status: 405, headers: { ...headers, Allow: "POST" } });

    // Discovery works before consent. Every tool call authenticates its own request.
    const allowedEvents = authenticated && !authenticated.subscriptions ? undefined : events;
    const advertised = allowedEvents ? capabilities : { tools: {} };
    const server = new Server({ name: "neckardt-apps-mcp", version: "0.1.0", websiteUrl: website },
      { capabilities: advertised });
    server.fallbackRequestHandler = async (req: JSONRPCRequest) => {
      if (req.method === "server/discover")
        return { resultType: "complete", supportedVersions: ["2026-07-28"], capabilities: advertised };
      if (!allowedEvents) throw new McpError(ErrorCode.MethodNotFound, "Method not found");
      try { return await allowedEvents.handle(req.method, req.params, authenticated?.subject ?? null); }
      catch (error) {
        if (error instanceof McpError) throw error;
        throw new McpError(ErrorCode.InternalError, "Event service unavailable");
      }
    };
    server.setRequestHandler(ListToolsRequestSchema, async () => {
      let allowed: unknown = [];
      if (authenticated && dataRpc) {
        try { allowed = await dataRpc(authenticated.client, authenticated.subject, "tools/list", {}); }
        catch { console.warn("MCP data tool registry unavailable during discovery."); }
      }
      const granted = dataTools.filter(tool => Array.isArray(allowed) && allowed.includes(tool.definition.name));
      return { tools: [linkTool, ...granted.map(tool => tool.definition)] };
    });
    server.setRequestHandler(CallToolRequestSchema, async ({ params }: CallToolRequest) => {
      const args = params.arguments ?? {};
      const tool = dataTools.find(tool => tool.definition.name === params.name);
      if (!tool && params.name !== linkTool.name)
        throw new McpError(ErrorCode.InvalidParams, "Unknown tool.");
      if (!authenticated) return {
        isError: true, content: [{ type: "text", text: "Connect Neckardt Apps to continue." }],
        _meta: { "mcp/www_authenticate": [challenge] },
      };
      if (!tool) {
        if (Object.keys(args).some(k => k !== "debrief") || (args.debrief !== undefined && typeof args.debrief !== "boolean"))
          throw new McpError(ErrorCode.InvalidParams, "Invalid Habit Practice link arguments.");
        return getHabitPracticeLink();
      }
      if (!dataRpc) throw new McpError(ErrorCode.MethodNotFound, "Tool unavailable.");
      const input = tool.parse(args);
      try {
        const result = await dataRpc(authenticated.client, authenticated.subject, params.name, input);
        return { structuredContent: result, content: [{ type: "text", text: JSON.stringify(result) }] };
      } catch (error) {
        const message = error instanceof DataToolError ? error.message : "Data service unavailable. Verify the result before retrying.";
        return { isError: true, content: [{ type: "text", text: message }] };
      }
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
