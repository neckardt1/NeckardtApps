import { sendCallback } from "../supabase/functions/neckardt-apps-mcp/callback.mjs";
// Optional loopback regression test for the Deno transport. Uses an ephemeral certificate
// and no live callback, credentials or DNS. Run from the backend workspace with Deno and openssl:
// deno run -A --no-lock --node-modules-dir=manual --config=supabase/functions/neckardt-apps-mcp/deno.json tests/notification-transport.deno.mjs
const directory = await Deno.makeTempDir();
let cert, key;
try {
  const result = await new Deno.Command("openssl", {stderr:"null", args:[
    "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days","1",
    "-subj","/CN=connectors.api.openai.com","-addext","subjectAltName=DNS:connectors.api.openai.com",
    "-addext","basicConstraints=critical,CA:FALSE","-keyout",directory+"/key.pem","-out",directory+"/cert.pem",
  ]}).output();
  if (!result.success) throw Error("Could not generate fixture certificate");
  cert = await Deno.readTextFile(directory+"/cert.pem");
  key = await Deno.readTextFile(directory+"/key.pem");
} finally { await Deno.remove(directory,{recursive:true}); }
let received = 0;
const local = Deno.serve({hostname:"127.0.0.1",port:0,cert,key,onListen(){}},async req => {
  received++;
  if (req.headers.get("Host") !== "connectors.api.openai.com") throw Error("Wrong host");
  if (await req.text() !== "synthetic") throw Error("Wrong body");
  switch (new URL(req.url).pathname) {
    case "/oversize": return new Response("x".repeat(10000));
    case "/redirect": return new Response(null,{status:302,headers:{location:"https://invalid.example/"}});
    default: return new Response('{"ok":true}');
  }
});
const stalled = Deno.listen({hostname:"127.0.0.1",port:0});
const connect=Deno.connect, tls=Deno.startTls;
let stall = false;
let stalledPeer;
let trusted=true;
Deno.resolveDns = async host => {
  if (host!=="connectors.api.openai.com") throw Error("Unexpected DNS query");
  return ["8.8.8.8"];
};
Deno.connect = async opts => {
  if (opts.hostname!=="8.8.8.8" || opts.port!==443) throw Error("Address pin mismatch");
  return connect({hostname:"127.0.0.1",port:stall ? stalled.addr.port : local.addr.port});
};
Deno.startTls = (conn,opts) => {
  if (opts.hostname!=="connectors.api.openai.com") throw Error("TLS name mismatch");
  return tls(conn,{...opts,caCerts:trusted?[cert]:[]});
};
const call=path=>sendCallback(new URL("https://connectors.api.openai.com"+path),{headers:{},body:"synthetic"});
try {
 const ok=await call("/"); if(ok.status!==200 || ok.body!=='{"ok":true}') throw Error("Response mismatch");
 const redirect=await call("/redirect"); if(redirect.status!==302 || received!==2) throw Error("Redirect followed");
 const limited=await call("/oversize").then(()=>false,()=>true); if(!limited) throw Error("Unbounded response");
 trusted=false;
 const refused=await call("/").then(()=>false,()=>true); if(!refused || received!==3) throw Error("Untrusted TLS");
 trusted=true;
 stall=true;
 const start = performance.now();
 const peer = stalled.accept();
 const result = call("/").then(()=>false,()=>true);
 stalledPeer = await peer;
 if (!(await result) || performance.now()-start > 7500) throw Error("Stalled handshake missed deadline");
 console.log("Confirmed deadline, pinned address + hostname, verified TLS, correct body, redirect refused, bounded response, untrusted certificate blocked.");
} finally { stalledPeer?.close(); stalled.close(); await local.shutdown(); }
