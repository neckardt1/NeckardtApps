import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const build = fileURLToPath(new URL("../scripts/build-pages.mjs", import.meta.url));
const run = (out, vars) => spawnSync(process.execPath, [build, out], {
  encoding: "utf8", env: { ...process.env, RECALL_SUPABASE_URL: "", RECALL_SUPABASE_PUBLISHABLE_KEY: "", ...vars }
});
const fixture = {
  RECALL_SUPABASE_URL: "https://abcdefghijklmnopqrst.supabase.co",
  RECALL_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_build_fixture"
};

async function serve(out) {
  const files = createServer(async (req, res) => {
    try {
      const path = new URL(req.url, "http://127.0.0.1").pathname.replace(/^\/NeckardtApps(?=\/)/, "");
      const file = resolve(out, "." + path + (path.endsWith("/") ? "index.html" : ""));
      if (!file.startsWith(out + sep)) throw Error("Not found");
      const type = file.endsWith(".html") ? "text/html" : file.endsWith(".css") ? "text/css" : "text/javascript";
      const body = await readFile(file);
      res.writeHead(200, { "Content-Type": type });
      res.end(body);
    } catch {
      if (!res.headersSent) res.writeHead(404);
      res.end();
    }
  });
  await new Promise((yes, no) => files.on("error", no).listen(0, "127.0.0.1", yes));
  return { files, origin: `http://127.0.0.1:${files.address().port}` };
}

test("a real nested HTML entry hard-refreshes at both Pages base paths; only UI assets build", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "neckardtapps-pages-"));
  let files;
  try {
    const out = join(tmp, "site");
    const done = run(out, fixture);
    assert.equal(done.status, 0, done.stderr);
    assert.deepEqual((await readdir(out)).sort(), ["index.html", "recall"]);
    assert.deepEqual((await readdir(join(out, "recall"))).sort(), ["assets", "index.html"]);
    const assets = await readdir(join(out, "recall", "assets"));
    assert.equal(assets.length, 2);
    assert(assets.every((name) => /^index-[\w-]+\.(css|js)$/.test(name)));

    let origin;
    ({ files, origin } = await serve(out));
    for (const base of ["/", "/NeckardtApps/"]) {
      const launcher = await fetch(origin + base);
      assert.equal(launcher.status, 200);
      const home = await launcher.text();
      assert(!home.includes("<script"), "launcher should stay public and independent of auth");
      const href = home.match(/href="([^"]+recall\/)"/)?.[1];
      assert(href);
      const recallRoot = new URL(href, origin + base);
      assert.equal(recallRoot.pathname, base + "recall/");

      for (const directLoad of [recallRoot, new URL("index.html", recallRoot)]) {
        const recall = await fetch(directLoad);
        assert.equal(recall.status, 200);
        const html = await recall.text();
        assert.match(html, /<div id="root"><\/div>/);
        const links = [...html.matchAll(/(?:src|href)="(\.\/assets\/index-[\w-]+\.(?:css|js))"/g)].map(m => m[1]);
        assert.equal(links.length, 2);
        for (const link of links) {
          const assetUrl = new URL(link, directLoad);
          assert(assetUrl.pathname.startsWith(base + "recall/assets/"));
          const asset = await fetch(assetUrl);
          assert.equal(asset.status, 200);
          const body = await asset.text();
          assert(body.length > 0);
          if (link.endsWith(".js")) {
            assert(body.includes(fixture.RECALL_SUPABASE_URL));
            assert(body.includes(fixture.RECALL_SUPABASE_PUBLISHABLE_KEY));
          }
        }
      }
    }
  } finally {
    if (files) await new Promise((yes) => files.close(yes));
    await rm(tmp, { recursive: true, force: true });
  }
});

test("the build accepts browser-safe defaults but refuses partial overrides, secret keys and false hosts", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "neckardtapps-config-"));
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
    const done = run(out, {});
    assert.equal(done.status, 0, done.stderr);
    const defaults = JSON.parse(await readFile(new URL("../apps/recall/public-config.json", import.meta.url), "utf8"));
    const assets = join(out, "recall", "assets");
    const js = await readFile(join(assets, (await readdir(assets)).find(name => name.endsWith(".js"))), "utf8");
    assert(js.includes(defaults.url));
    assert(js.includes(defaults.publishableKey));
  } finally { await rm(tmp, { recursive: true, force: true }); }
});
