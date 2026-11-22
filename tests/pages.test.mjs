import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, readdir, readFile, writeFile, symlink, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const build = fileURLToPath(new URL("../scripts/build-pages.mjs", import.meta.url));
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
      res.writeHead(200, { "Content-Type": file.endsWith(".html") ? "text/html" : "application/octet-stream" });
      res.end(body);
    } catch {
      if (!res.headersSent) res.writeHead(404);
      res.end();
    }
  });
  await new Promise((yes, no) => files.on("error", no).listen(0, "127.0.0.1", yes));
  return { files, origin: "http://127.0.0.1:" + files.address().port };
}
function inert(html) {
  assert.doesNotMatch(html, /<(?:script|iframe|object|embed|form|input|button|base)\b|\bon\w+\s*=|javascript:|@import|url\s*\(/i);
  assert.doesNotMatch(html, /http-equiv=["']refresh|https?:\/\/|supabase|sb_publishable_|sb_secret_|localStorage|sessionStorage|indexedDB|serviceWorker/i);
}
test("fresh loads serve only offline HTML and a public launcher at both Pages bases", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "neckardtapps-offline-"));
  let files;
  try {
    const out = join(tmp, "site");
    const done = run(out);
    assert.equal(done.status, 0, done.stderr);
    assert.deepEqual((await readdir(out)).sort(), ["index.html", "recall"]);
    assert.deepEqual(await readdir(join(out, "recall")), ["index.html"]);
    let origin;
    ({ files, origin } = await serve(out));
    for (const base of ["/", "/NeckardtApps/"]) {
      const launcher = await fetch(origin + base);
      assert.equal(launcher.status, 200);
      const home = await launcher.text();
      inert(home);
      assert.match(home, /temporarily offline/i);
      const href = home.match(/href="([^"]+recall\/)"/)?.[1];
      assert(href);
      const recallRoot = new URL(href, origin + base);
      assert.equal(recallRoot.pathname, base + "recall/");
      for (const directLoad of [recallRoot, new URL("index.html", recallRoot)]) {
        const recall = await fetch(directLoad);
        assert.equal(recall.status, 200);
        const html = await recall.text();
        inert(html);
        assert.match(html, /Recall is temporarily offline/i);
        assert.match(html, /Content-Security-Policy/);
        for (const directive of ["default-src 'none'", "style-src 'unsafe-inline'", "base-uri 'none'", "form-action 'none'"]) {
          assert(html.includes(directive));
        }
        assert.doesNotMatch(html, /id=["']root["']|(?:src|href)=["'][^"']*assets\//i);
        const backHref = html.match(/href="(\.\.\/)"/)?.[1];
        assert(backHref);
        const back = new URL(backHref, directLoad);
        assert.equal(back.pathname, base);
        assert.equal(await (await fetch(back)).text(), home);
      }
      for (const missing of [
        "recall/assets/index-BGcdV7RE.js", "recall/src/main.tsx", "recall/public-config.json",
        "recall/supabase/config.toml", "recall/supabase/functions/recall-grade/index.ts", "shared/browser-auth.mts"
      ]) assert.equal((await fetch(origin + base + missing)).status, 404, missing);
    }
  } finally {
    if (files) await new Promise(yes => files.close(yes));
    await rm(tmp, { recursive: true, force: true });
  }
});
test("browser and secret configuration variables cannot alter or leak into the offline artifact", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "neckardtapps-offline-env-"));
  try {
    const baseline = join(tmp, "baseline");
    assert.equal(run(baseline).status, 0);
    const overrides = [
      { RECALL_SUPABASE_URL: "https://abcdefghijklmnopqrst.supabase.co" },
      { RECALL_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_offline_fixture" },
      { RECALL_SUPABASE_URL: "https://invalid.example/path", RECALL_SUPABASE_PUBLISHABLE_KEY: "sb_secret_fake_must_not_ship" }
    ];
    for (const [i, vars] of overrides.entries()) {
      const out = join(tmp, "site-" + i);
      const done = run(out, vars);
      assert.equal(done.status, 0, done.stderr);
      assert.deepEqual((await readdir(out)).sort(), ["index.html", "recall"]);
      assert.deepEqual(await readdir(join(out, "recall")), ["index.html"]);
      for (const path of ["index.html", "recall/index.html"]) {
        assert.equal(await readFile(join(out, path), "utf8"), await readFile(join(baseline, path), "utf8"));
      }
    }
  } finally { await rm(tmp, { recursive: true, force: true }); }
});
test("build rejects existing output directories, files, and symlinks without touching stale assets", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "neckardtapps-offline-stale-"));
  try {
    const stale = join(tmp, "site");
    await mkdir(join(stale, "recall", "assets"), { recursive: true });
    const oldAsset = join(stale, "recall", "assets", "old.js");
    await writeFile(oldAsset, "synthetic stale review code");
    assert.notEqual(run(stale).status, 0);
    assert.equal(await readFile(oldAsset, "utf8"), "synthetic stale review code");
    assert.deepEqual(await readdir(stale), ["recall"]);
    const file = join(tmp, "file");
    await writeFile(file, "preserve");
    assert.notEqual(run(file).status, 0);
    assert.equal(await readFile(file, "utf8"), "preserve");
    const target = join(tmp, "target"), link = join(tmp, "link");
    await mkdir(target); await symlink(target, link);
    assert.notEqual(run(link).status, 0);
    assert.deepEqual(await readdir(target), []);
  } finally { await rm(tmp, { recursive: true, force: true }); }
});
