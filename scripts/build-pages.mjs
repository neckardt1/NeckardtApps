import {copyFile, mkdir, readFile, writeFile} from "node:fs/promises";
import {join,resolve} from "node:path";
import {fileURLToPath} from "node:url";
import {createRequire} from "node:module";

const repo=fileURLToPath(new URL("../",import.meta.url));
const recall=join(repo,"apps","recall");
const require=createRequire(join(recall,"package.json"));
const {build}=require("esbuild");
const overrideUrl=(process.env.RECALL_SUPABASE_URL??"").trim();
const overrideKey=(process.env.RECALL_SUPABASE_PUBLISHABLE_KEY??"").trim();
const override=Boolean(overrideUrl||overrideKey);
const expected=JSON.parse(await readFile(join(recall,"public-config.json"),"utf8"));
const rawUrl=override?overrideUrl:expected.url;
const publishableKey=override?overrideKey:expected.publishableKey;
let parsed;
try {parsed=new URL(rawUrl);} catch {}
if(!parsed || !/^https:\/\/[a-z0-9]{20}\.supabase\.co$/.test(parsed.origin)
   || parsed.pathname!=="/" || parsed.username || parsed.password || parsed.search || parsed.hash
   || !/^sb_publishable_[A-Za-z0-9_-]+$/.test(publishableKey??"")){
  throw new Error("Set the public Supabase project URL and sb_publishable_ key together. No server/secret keys accepted.");
}
const url=parsed.origin;

const out=process.argv[2]?resolve(process.argv[2]):join(repo,"_site");
// Reject a stale build directory instead of accidentally packaging extra files.
await mkdir(out);
await mkdir(join(out,"recall"));
await copyFile(join(repo,"index.html"),join(out,"index.html"));
await copyFile(join(recall,"index.html"),join(out,"recall","index.html"));
await writeFile(join(out,"recall","config.js"),"window.RECALL_SUPABASE="+JSON.stringify({url,publishableKey})+";\n");
await build({
  entryPoints:[join(recall,"src","app.js")],
  outfile:join(out,"recall","app.js"),bundle:true,minify:true,format:"esm",
  legalComments:"eof"
});
console.log("Built static Pages output (home and Recall).");
