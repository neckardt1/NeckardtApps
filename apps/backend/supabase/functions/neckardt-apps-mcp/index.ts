import { createHandler } from "./server.ts";

Deno.serve(createHandler(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("NECKARDT_APPS_OAUTH_CLIENT_ID"),
));
