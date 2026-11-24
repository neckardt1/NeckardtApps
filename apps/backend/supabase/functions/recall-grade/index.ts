import { createClient } from "@supabase/supabase-js";
import * as fsrsLib from "ts-fsrs";
import type { Database } from "../_shared/database.types.ts";
import { firstPartyOwner, gradeHandler, schedulerFor } from "./grade.mjs";

const url=Deno.env.get("SUPABASE_URL");
const published=JSON.parse(Deno.env.get("SUPABASE_PUBLISHABLE_KEYS")??"{}").default
  ?? Deno.env.get("SUPABASE_ANON_KEY");
const serverSecret=JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS")??"{}").default
  ?? Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
if(!url||!published||!serverSecret) throw new Error("Supabase managed Edge credentials are unavailable");
const options={auth:{persistSession:false,autoRefreshToken:false,detectSessionInUrl:false}};
const authClient=createClient(url,published,options);
const issuer=new URL("/auth/v1",url).href;
const backend=createClient<Database>(url,serverSecret,options);
type Functions = Database["public"]["Functions"];
// The backend uses Supabase-provided server credentials exclusively inside
// the function. We never log them, return them, or give them to the browser.
async function result(request: PromiseLike<{ data: unknown; error: unknown }>) {
  const { data, error } = await request;
  if (error) throw error;
  return data;
}
Deno.serve(gradeHandler({
  getOwner:(jwt: string)=>firstPartyOwner(authClient.auth,issuer,jwt),
  prepare: (args: Functions["recall_grade_context"]["Args"]) => result(backend.rpc("recall_grade_context", args)),
  commit: (args: Functions["recall_commit_review"]["Args"]) => result(backend.rpc("recall_commit_review", args)),
  schedule:schedulerFor(fsrsLib)
}));
