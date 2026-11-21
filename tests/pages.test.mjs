import assert from "node:assert/strict";
import {test} from "node:test";
import {mkdtemp,readdir,readFile,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {spawnSync} from "node:child_process";
import {fileURLToPath} from "node:url";
import {runInNewContext} from "node:vm";

const build=fileURLToPath(new URL("../scripts/build-pages.mjs",import.meta.url));
const run=(out,vars)=>spawnSync(process.execPath,[build,out],{
  encoding:"utf8",env:{...process.env,RECALL_SUPABASE_URL:"",RECALL_SUPABASE_PUBLISHABLE_KEY:"",...vars}
});
const fixture={
  RECALL_SUPABASE_URL:"https://abcdefghijklmnopqrst.supabase.co",
  RECALL_SUPABASE_PUBLISHABLE_KEY:"sb_publishable_build_fixture"
};

test("Pages builds only the static frontend; directory and asset links work on both base URLs",async()=>{
 const tmp=await mkdtemp(join(tmpdir(),"neckardtapps-pages-"));
 try {
   const out=join(tmp,"site");
   const done=run(out,fixture);
   assert.equal(done.status,0,done.stderr);
   assert.deepEqual((await readdir(out)).sort(),["index.html","recall"]);
   assert.deepEqual((await readdir(join(out,"recall"))).sort(),["app.js","config.js","index.html"]);
   const home=await readFile(join(out,"index.html"),"utf8");
   const recall=await readFile(join(out,"recall","index.html"),"utf8");
   const config=await readFile(join(out,"recall","config.js"),"utf8");
   const app=await readFile(join(out,"recall","app.js"),"utf8");
   const href=home.match(/href="([^"]+recall\/)"/)?.[1];
   const assets=[...recall.matchAll(/<script[^>]+src="([^"]+)"/g)].map((match)=>match[1]);
   assert(href);
   assert.deepEqual(assets,["./config.js","./app.js"]);
   for(const base of ["https://example.github.io/NeckardtApps/","https://apps.neckardt.com/"]){
     const recallRoot=new URL(href,base);
     assert.equal(recallRoot.href,base+"recall/");
     for(const [i,name] of ["config.js","app.js"].entries()) {
       assert.equal(new URL(assets[i],recallRoot).href,base+"recall/"+name);
     }
   }
   assert.match(recall,/>Show answer</);
   assert.match(recall,/data-grade="miss"[^>]+>Again</);
   assert.match(recall,/data-grade="medium"[^>]+>Good</);
   assert.match(app,/signOut\(\{scope:"local"\}\)/);
   const ctx={window:{}}; runInNewContext(config,ctx);
   assert.deepEqual(JSON.parse(JSON.stringify(ctx.window.RECALL_SUPABASE)),{
     url:fixture.RECALL_SUPABASE_URL,publishableKey:fixture.RECALL_SUPABASE_PUBLISHABLE_KEY
   });
 } finally {await rm(tmp,{recursive:true,force:true});}
});

test("Pages uses the public defaults and rejects partial overrides, secret keys and deceptive project hosts",async()=>{
 const tmp=await mkdtemp(join(tmpdir(),"neckardtapps-config-"));
 try {
   const out=join(tmp,"site");
   for(const bad of [
     {RECALL_SUPABASE_URL:fixture.RECALL_SUPABASE_URL},
     {RECALL_SUPABASE_PUBLISHABLE_KEY:fixture.RECALL_SUPABASE_PUBLISHABLE_KEY},
     {...fixture,RECALL_SUPABASE_PUBLISHABLE_KEY:"sb_secret_fake_must_not_ship"},
     {...fixture,RECALL_SUPABASE_URL:"https://abcdefghijklmnopqrst.supabase.co.invalid"},
     {...fixture,RECALL_SUPABASE_URL:"https://abcdefghijklmnopqrst.supabase.co/path"}
   ]) {
     assert.notEqual(run(out,bad).status,0);
     assert.deepEqual(await readdir(tmp),[]);
   }
   const done=run(out,{});
   assert.equal(done.status,0,done.stderr);
   const expected=JSON.parse(await readFile(new URL("../apps/recall/public-config.json", import.meta.url), "utf8"));
   const config=await readFile(join(out,"recall","config.js"),"utf8");
   const ctx={window:{}}; runInNewContext(config,ctx);
   assert.deepEqual(JSON.parse(JSON.stringify(ctx.window.RECALL_SUPABASE)),expected);
 } finally {await rm(tmp,{recursive:true,force:true});}
});
