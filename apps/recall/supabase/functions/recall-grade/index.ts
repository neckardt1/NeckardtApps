import { createClient } from "npm:@supabase/supabase-js@2.119.2";
import * as fsrsLib from "npm:ts-fsrs@5.4.2";
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
const backend=createClient(url,serverSecret,options);
// The backend uses Supabase-provided server credentials exclusively inside
// the function. We never log them, return them, or give them to the browser.
async function rpc(name: string, args: Record<string, unknown>){
  const {data,error}=await backend.rpc(name,args);
  if(error) throw error;
  return data;
}
Deno.serve(gradeHandler({
  getOwner:(jwt: string)=>firstPartyOwner(authClient.auth,issuer,jwt),
  prepare:(args: Record<string, unknown>)=>rpc("recall_grade_context",args),
  commit:(args: Record<string, unknown>)=>rpc("recall_commit_review",args),
  schedule:schedulerFor(fsrsLib)
}));
