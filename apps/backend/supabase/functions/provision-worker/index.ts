import { createClient } from "@supabase/supabase-js";
import { readFixtureSettings } from "./settings.ts";

const { projectRef: ref, key } = readFixtureSettings(name => Deno.env.get(name));
const url = Deno.env.get("SUPABASE_URL");
if (!ref || !/^[a-z0-9]{20}$/.test(ref) || !url || url !== `https://${ref}.supabase.co`
    || !key || key.length < 32) {
  throw new Error("Set NECKARDT_APPS_FIXTURE_KEY and bind NECKARDT_APPS_FIXTURE_PROJECT_REF to this project.");
}
const adminKey = JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") ?? "{}").default
  ?? Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
if (!adminKey) throw new Error("Supabase managed credentials unavailable.");
const client = createClient(url, adminKey, {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }
});

Deno.serve(async request => {
  if (request.method !== "POST") return new Response(null, { status: 405 });
  if (request.headers.get("x-fixture-key") !== key) return new Response(null, { status: 403 });
  const body = await request.json().catch(() => null);
  if (typeof body?.password !== "string" || body.password.length < 32 || body.password.length > 72) {
    return new Response(null, { status: 400 });
  }
  const id = crypto.randomUUID();
  const email = `worker-${id}@example.test`;
  const { data, error } = await client.auth.admin.createUser({
    id, email, password: body.password, email_confirm: true,
    app_metadata: { neckardt_fixture: "habit-practice-v1" }
  });
  if (error || data.user?.id !== id) {
    console.error("Unable to create fixture user", error?.status, error?.code);
    return new Response(null, { status: 502 });
  }
  return Response.json({ email, id }, { status: 201, headers: { "Cache-Control": "no-store" } });
});
