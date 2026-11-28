import type { SupabaseClient } from "@supabase/supabase-js";

const uuid = (s: unknown): s is string => typeof s === "string"
  && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);

export async function firstPartyOwner(auth: Pick<SupabaseClient["auth"], "getClaims" | "getUser">,
  issuer: string, jwt: string) {
  const verified = await auth.getClaims(jwt);
  if (verified.error && (!verified.error.status || verified.error.status >= 500)) throw verified.error;
  const claims = verified.data?.claims;
  if (verified.error || !claims || claims.iss !== issuer || claims.aud !== "authenticated"
    || claims.role !== "authenticated" || Object.hasOwn(claims, "client_id")
    || !uuid(claims.sub) || !uuid(claims.session_id)
    || (Object.hasOwn(claims, "is_anonymous") && claims.is_anonymous !== false)) return null;
  const current = await auth.getUser(jwt);
  if (current.error && (!current.error.status || current.error.status >= 500)) throw current.error;
  const user = current.data.user;
  return !current.error && user?.id === claims.sub && !user.is_anonymous ? user.id : null;
}
