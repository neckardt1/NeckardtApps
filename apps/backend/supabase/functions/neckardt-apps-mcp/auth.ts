import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";

const uuid = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
export const scopes = ["openid"];

export function createTokenVerifier(issuer: string, resource: string, testKeys?: JWTVerifyGetKey) {
  const keys = testKeys ?? createRemoteJWKSet(new URL(issuer + "/.well-known/jwks.json"));

  return async function accepts(authorization: string): Promise<{ subject: string; client: string; subscriptions: boolean; origin: string } | null> {
    if (authorization.length > 16384) return null;
    const bearer = /^Bearer ([^\s]+)$/i.exec(authorization);
    if (!bearer) return null;
    try {
      const { payload } = await jwtVerify(bearer[1], keys, {
        issuer, audience: resource, algorithms: ["ES256", "RS256"],
        requiredClaims: ["exp", "iat", "sub", "client_id", "role", "session_id", "is_anonymous", "neckardt_mcp"],
      });
      const policy = payload.neckardt_mcp;
      if (payload.aud !== resource || payload.role !== "neckardt_apps_oauth" || payload.is_anonymous !== false ||
          typeof payload.client_id !== "string" || !uuid.test(payload.client_id) ||
          typeof payload.sub !== "string" || !uuid.test(payload.sub) ||
          typeof payload.session_id !== "string" || !uuid.test(payload.session_id) ||
          !policy || typeof policy !== "object" || !("subscriptions" in policy) || typeof policy.subscriptions !== "boolean" ||
          !("origin" in policy) || typeof policy.origin !== "string") return null;
      return { subject: payload.sub, client: payload.client_id, subscriptions: policy.subscriptions, origin: policy.origin };
    } catch {
      return null;
    }
  };
}
