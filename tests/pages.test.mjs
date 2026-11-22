import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readdir, readFile, writeFile, symlink, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const build = fileURLToPath(new URL("../scripts/build-pages.mjs", import.meta.url));
const fixture = {
  RECALL_SUPABASE_URL: "https://abcdefghijklmnopqrst.supabase.co",
  RECALL_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_build_fixture"
};
const run = (out, vars = {}) => spawnSync(process.execPath, [build, out], {
  encoding: "utf8", env: { ...process.env, RECALL_SUPABASE_URL: "", RECALL_SUPABASE_PUBLISHABLE_KEY: "", ...vars }
});
async function serve(out) {
  const files = createServer(async (req, res) => {
    try {
      const path = new URL(req.url, "http://127.0.0.1").pathname.replace(/^\/NeckardtApps(?=\/)/, "");
      const file = resolve(out, "." + path + (path.endsWith("/") ? "index.html" : ""));
      if (!file.startsWith(out + sep)) throw Error("Not found");
      const body = await readFile(file);
      res.writeHead(200, { "Content-Type": file.endsWith(".html") ? "text/html" : file.endsWith(".css") ? "text/css" : "text/javascript" });
      res.end(body);
    } catch { if (!res.headersSent) res.writeHead(404); res.end(); }
  });
  await new Promise((yes, no) => files.on("error", no).listen(0, "127.0.0.1", yes));
  return { files, origin: "http://127.0.0.1:" + files.address().port };
}
function inertMaintenance(html) {
  assert.doesNotMatch(html, /<(?:script|iframe|object|embed|form|input|button|base)\b|\bon\w+\s*=|javascript:|@import|url\s*\(/i);
  assert.doesNotMatch(html, /http-equiv=["']refresh|https?:\/\/|supabase|sb_publishable_|localStorage|sessionStorage|indexedDB|serviceWorker/i);
  assert.match(html, /default-src 'none'/);
}
test("top-level multipage build serves the public shell and unchanged maintenance on both Pages bases", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "neckardtapps-shell-"));
  let files;
  try {
    const source = await readFile(new URL("../recall/index.html", import.meta.url));
    const blob = createHash("sha1").update("blob " + source.length + "\0").update(source).digest("hex");
    // Pinned maintenance content from the approved clean-slate main.
    assert.equal(blob, "c720c6508f96524c9d0fef69c59c89d0786957fd");
    const out = join(tmp, "site");
    const done = run(out, fixture);
    assert.equal(done.status, 0, done.stderr);
    assert.deepEqual((await readdir(out)).sort(), ["assets", "index.html", "recall"]);
    assert.deepEqual(await readdir(join(out, "recall")), ["index.html"]);
    assert((await readFile(join(out, "recall", "index.html"))).equals(source), "Built maintenance HTML must match its source bytes");
    const assets = await readdir(join(out, "assets"));
    assert.equal(assets.length, 2);
    assert(assets.every(name => /^[\w-]+\.(?:js|css)$/.test(name)));
    let origin;
    ({ files, origin } = await serve(out));
    for (const base of ["/", "/NeckardtApps/"]) {
      for (const homeUrl of [origin + base, origin + base + "index.html"]) {
        const response = await fetch(homeUrl);
        assert.equal(response.status, 200);
        const home = await response.text();
        assert.match(home, /Habit Practice/); // public noscript fallback
        const appHref = home.match(/href="([^"]+recall\/)"/)?.[1];
        assert(appHref);
        assert.equal(new URL(appHref, homeUrl).pathname, base + "recall/");
        const links = [...home.matchAll(/(?:src|href)="(\.\/assets\/[\w-]+\.(?:css|js))"/g)].map(m => m[1]);
        assert.equal(links.length, 2);
        for (const link of links) {
          const assetUrl = new URL(link, homeUrl);
          assert(assetUrl.pathname.startsWith(base + "assets/"));
          const asset = await fetch(assetUrl);
          assert.equal(asset.status, 200);
          const content = await asset.text();
          if (link.endsWith(".js")) {
            assert(content.includes(fixture.RECALL_SUPABASE_URL));
            assert(content.includes(fixture.RECALL_SUPABASE_PUBLISHABLE_KEY));
            assert.doesNotMatch(content, /recall-grade|recall_due|recall_record_action|recall\.round|recall\.live/);
          }
        }
      }
      for (const path of ["recall/", "recall/index.html"]) {
        const direct = new URL(base + path, origin);
        const response = await fetch(direct);
        assert.equal(response.status, 200);
        const html = await response.text();
        assert.equal(html, source.toString());
        inertMaintenance(html);
        const back = html.match(/href="(\.\.\/)"/)?.[1];
        assert(back);
        const root = new URL(back, direct);
        assert.equal(root.pathname, base);
        assert.equal((await fetch(root)).status, 200);
      }
      for (const missing of ["recall/assets/index-BGcdV7RE.js","recall/src/main.tsx","public-config.json",
        "recall/supabase/config.toml","shared/browser-auth.mts","apps/recall/index.html"]) {
        assert.equal((await fetch(origin + base + missing)).status, 404, missing);
      }
    }
  } finally {
    if (files) await new Promise(yes => files.close(yes));
    await rm(tmp, { recursive: true, force: true });
  }
});
test("root build accepts public defaults and refuses partial, secret, or false-host configuration", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "neckardtapps-shell-config-"));
  try {
    const out = join(tmp, "site");
    for (const bad of [
      { RECALL_SUPABASE_URL: fixture.RECALL_SUPABASE_URL },
      { RECALL_SUPABASE_PUBLISHABLE_KEY: fixture.RECALL_SUPABASE_PUBLISHABLE_KEY },
      { ...fixture, RECALL_SUPABASE_PUBLISHABLE_KEY: "sb_secret_fake_must_not_ship" },
      { ...fixture, RECALL_SUPABASE_URL: "https://abcdefghijklmnopqrst.supabase.co.invalid" },
      { ...fixture, RECALL_SUPABASE_URL: "https://abcdefghijklmnopqrst.supabase.co/path" }
    ]) {
      assert.notEqual(run(out, bad).status, 0);
      assert.deepEqual(await readdir(tmp), []);
    }
    const done = run(out);
    assert.equal(done.status, 0, done.stderr);
    const defaults = JSON.parse(await readFile(new URL("../public-config.json", import.meta.url), "utf8"));
    const js = await readFile(join(out, "assets", (await readdir(join(out, "assets"))).find(name => name.endsWith(".js"))), "utf8");
    assert(js.includes(defaults.url)); assert(js.includes(defaults.publishableKey));
  } finally { await rm(tmp, { recursive: true, force: true }); }
});
test("root build rejects existing destinations without removing stale assets", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "neckardtapps-shell-stale-"));
  try {
    const stale = join(tmp, "site");
    await mkdir(join(stale, "recall", "assets"), { recursive: true });
    const oldAsset = join(stale, "recall", "assets", "old.js");
    await writeFile(oldAsset, "synthetic stale review code");
    assert.notEqual(run(stale, fixture).status, 0);
    assert.equal(await readFile(oldAsset, "utf8"), "synthetic stale review code");
    const file = join(tmp, "file");
    await writeFile(file, "preserve");
    assert.notEqual(run(file, fixture).status, 0);
    assert.equal(await readFile(file, "utf8"), "preserve");
    const target = join(tmp, "target"), link = join(tmp, "link");
    await mkdir(target); await symlink(target, link);
    assert.notEqual(run(link, fixture).status, 0);
    assert.deepEqual(await readdir(target), []);
  } finally { await rm(tmp, { recursive: true, force: true }); }
});
