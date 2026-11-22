import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "npm:jose@6.2.18";
import type { OAuthPolicy } from "./handler.ts";

const functionPath = "/recall-events";
const webPath = functionPath + "/web/mcp";
const metadataPath = functionPath + "/web/.well-known/oauth-protected-resource";
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const scopes = ["openid"];
type Handler = (request: Request) => Promise<Response>;

export function createOAuth(projectUrl: string, client: string | undefined, owner: string | undefined, keys?: JWTVerifyGetKey) {
  const origin = new URL(projectUrl).origin;
  const issuer = origin + "/auth/v1";
  const resource = origin + "/functions/v1" + webPath;
  const metadata = origin + "/functions/v1" + metadataPath;
  const signingKeys = keys ?? createRemoteJWKSet(new URL(issuer + "/.well-known/jwks.json"), {timeoutDuration: 5000});
  const challenge = 'Bearer resource_metadata="' + metadata + '", scope="openid", error="invalid_token", error_description="Connect to the Recall canary"';
  const headers = {"WWW-Authenticate":challenge, "Cache-Control":"no-store"};

  function unauthorized(id?: string | number, method?: string) {
    if (method === "tools/call") {
      return Response.json({jsonrpc:"2.0", id, result:{isError:true,
        content:[{type:"text",text:"Connect your canary account to continue."}],
        _meta:{"mcp/www_authenticate":[challenge]}}}, {headers});
    }
    return new Response(null, {status:401, headers});
  }

  const policy: OAuthPolicy = {
    scheme: [{type:"oauth2",scopes}],
    async authorize(request, id, method) {
      const auth = request.headers.get("authorization") ?? "";
      const token = auth.length <= 16384 && /^Bearer ([^\s]+)$/i.exec(auth)?.[1];
      if (!token) return unauthorized(id,method);
      if (!client || !owner || !uuid.test(client) || !uuid.test(owner)) {
        return Response.json({error:"Canary identity is not configured"}, {status:503});
      }
      let payload;
      try {
        ({payload} = await jwtVerify(token, signingKeys, {algorithms:["ES256","RS256"], issuer,
          audience:resource, requiredClaims:["exp","iat","sub","session_id","client_id","role"]}));
      } catch {
        return unauthorized(id,method);
      }
      if (payload.aud !== resource || payload.sub !== owner || payload.client_id !== client ||
          payload.role !== "recall_canary_oauth" || payload.is_anonymous === true ||
          typeof payload.session_id !== "string" || !uuid.test(payload.session_id)) {
        return new Response(null, {status:403,headers:{"Cache-Control":"no-store"}});
      }
    },
  };
  return {...policy, unauthorized,
    metadataResponse:() => Response.json({resource, authorization_servers:[issuer],
      scopes_supported:scopes, bearer_methods_supported:["header"]})};
}

export function routeCanary(legacy: Handler, web: Handler, oauth: ReturnType<typeof createOAuth>) {
  return async (request: Request) => {
    // Supabase's hosted gateway strips /functions/v1 before forwarding to the function.
    const path = new URL(request.url).pathname.replace(/^\/functions\/v1\//, "/").replace(/\/$/, "");
    if (path === metadataPath && request.method === "GET") return oauth.metadataResponse();
    if (path === webPath) {
      if (request.method === "GET" || request.method === "HEAD") return oauth.unauthorized();
      return await web(request);
    }
    if ([functionPath,functionPath + "/mcp",functionPath + "/deliver"].includes(path)) return await legacy(request);
    return new Response(null, {status:404});
  };
}
