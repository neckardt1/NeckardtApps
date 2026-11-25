import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { runInNewContext } from "node:vm";
import { mkdtemp, mkdir, readdir, readFile, writeFile, symlink, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import defaults from "@neckardt/backend/public-config" with { type: "json" };
import { checkBrowserRoutes } from "./pages-browser.mjs";
import { checkAutomaticRounds } from "./automatic-rounds-browser.mjs";
import { checkPairedHabit } from "./paired-habit-browser.mjs";

const build = fileURLToPath(new URL("../scripts/build-pages.mjs", import.meta.url));
const primaryOwnerId = "deafcafe-deaf-4ace-8123-abcd1234abcd";
const legacyCanaryId = "22222222-2222-4222-8222-222222222222";
const expectedDigest = id => createHash("sha256")
  .update("neckardtapps:recall-consent:owner:v1:" + id.toLowerCase(), "utf8").digest("hex");
const fixture = {
  NECKARDT_APPS_SUPABASE_URL: "https://abcdefghijklmnopqrst.supabase.co",
  NECKARDT_APPS_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_build_fixture",
  VITE_CANARY_CLIENT_ID: "11111111-1111-4111-8111-111111111111",
  VITE_CANARY_USER_DIGEST: expectedDigest(primaryOwnerId),
  RECALL_LEGACY_CANARY_USER_ID: legacyCanaryId,
  VITE_CANARY_USER_ID: primaryOwnerId, // The retired public variable must never leak into a build.
  VITE_CANARY_CALLBACK_URL: "https://consent.example.invalid/callback",
  VITE_SUITE_CLIENT_ID: "55555555-5555-4555-8555-555555555555",
  VITE_SUITE_CALLBACK_URL: "https://consent.example.invalid/suite"
};
const run = (out, vars = {}) => spawnSync(process.execPath, [build, out], {
  encoding: "utf8", env: {
    ...process.env,
    NECKARDT_APPS_SUPABASE_URL: "", NECKARDT_APPS_SUPABASE_PUBLISHABLE_KEY: "",
    RECALL_SUPABASE_URL: "", RECALL_SUPABASE_PUBLISHABLE_KEY: "",
    VITE_CANARY_CLIENT_ID: "", VITE_CANARY_USER_DIGEST: "", RECALL_LEGACY_CANARY_USER_ID: "",
    VITE_CANARY_USER_ID: "", VITE_CANARY_CALLBACK_URL: "", VITE_SUITE_CLIENT_ID: "", VITE_SUITE_CALLBACK_URL: "",
    ...vars
  }
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
    } catch {
      res.writeHead(404, { "Content-Type": "text/html" });
      res.end(await readFile(join(out, "404.html")));
    }
  });
  await new Promise((yes, no) => files.on("error", no).listen(0, "127.0.0.1", yes));
  return { files, origin: "http://127.0.0.1:" + files.address().port };
}
async function scriptGraph(out, entry, graph = new Map()) {
  if (graph.has(entry)) return graph;
  graph.set(entry, "");
  const source = await readFile(join(out, "assets", entry), "utf8");
  graph.set(entry, source);
  const dependencies = [...source.matchAll(/(?:from\s*|import\s*\(?\s*)["'`]\.\/([\w-]+\.js)["'`]/g)].map(match => match[1]);
  await Promise.all(dependencies.map(file => scriptGraph(out, file, graph)));
  return graph;
}
function assetReferences(html) {
  assert.match(html, /<script\b[^>]*type="module"[^>]*src=/);
  return [...html.matchAll(/(?:src|href)="([^"]+\.(?:css|js))"/g)].map(match => match[1]);
}
async function pageGraph(out, html) {
  const graph = new Map();
  // Include script and modulepreload roots, then follow emitted module imports.
  // Config and SDK chunks need not be linked directly from every HTML entry.
  for (const link of assetReferences(html).filter(link => link.endsWith(".js"))) {
    const entry = link.split("/").at(-1);
    assert.match(entry, /^[\w-]+\.js$/);
    await scriptGraph(out, entry, graph);
  }
  return graph;
}
async function checkPageAssets(out, html, pageUrl, assetsUrl) {
  const references = assetReferences(html);
  assert(references.some(link => link.endsWith(".js")));
  assert(references.some(link => link.endsWith(".css")));
  for (const link of references) {
    const url = new URL(link, pageUrl);
    assert.equal(new URL(".", url).href, assetsUrl);
    assert.equal((await fetch(url)).status, 200, url.href);
  }
  const graph = await pageGraph(out, html);
  for (const [name, source] of graph) {
    const url = new URL(name, assetsUrl);
    const response = await fetch(url);
    assert.equal(response.status, 200, url.href);
    assert.equal(await response.text(), source, url.href);
  }
  return graph;
}
const graphText = graph => [...graph.values()].join("\n");
const recallCode = /recall-grade|recall_due|recall_opportunities|recall_record_action|demo_flashcards_due|recall\.round|recall\.live/;

async function assertOwnerValuesAbsent(out, values) {
  const files = await readdir(out, { recursive: true, withFileTypes: true });
  for (const file of files.filter(entry => entry.isFile())) {
    const path = join(file.parentPath, file.name);
    const content = (await readFile(path)).toString("utf8").toLowerCase();
    for (const value of values) {
      assert(!content.includes(value.toLowerCase()), `Unexpected owner configuration in ${path}`);
    }
  }
}

test("Pages serves one routed app and a separate OAuth consent document at both bases", async t => {
  const tmp = await mkdtemp(join(tmpdir(), "neckardtapps-practice-"));
  let files;
  try {
    const out = join(tmp, "site");
    const done = run(out, fixture);
    assert.equal(done.status, 0, done.stderr);
    await assertOwnerValuesAbsent(out, [primaryOwnerId, legacyCanaryId, expectedDigest(legacyCanaryId)]);
    assert.deepEqual((await readdir(out)).sort(), ["404.html", "assets", "index.html", "oauth"]);
    assert.deepEqual(await readdir(join(out, "oauth")), ["consent"]);
    assert.deepEqual(await readdir(join(out, "oauth", "consent")), ["index.html"]);
    const assets = await readdir(join(out, "assets"));
    assert(assets.length >= 4);
    assert(assets.every(name => /^[\w-]+\.(?:js|css)$/.test(name)));
    const entries = new Set(), pages = [];
    let origin;
    ({ files, origin } = await serve(out));
    await t.test("Chrome opens and refreshes deep links on the built site", {
      skip: !process.env.CHROME_BIN && !process.env.GITHUB_ACTIONS
    }, () => checkBrowserRoutes(origin));
    await t.test("A paired habit survives a lost answer receipt, duplicate Finish and a second browser", {
      skip: !process.env.CHROME_BIN && !process.env.GITHUB_ACTIONS
    }, () => checkPairedHabit(origin, fixture.NECKARDT_APPS_SUPABASE_URL));
    await t.test("Automatic subscriptions deliver the selected scope across mobile reviews and stop on revocation", {
      skip: !process.env.CHROME_BIN && !process.env.GITHUB_ACTIONS
    }, () => checkAutomaticRounds(origin, fixture.NECKARDT_APPS_SUPABASE_URL));
    for (const base of ["/", "/NeckardtApps/"]) {
      for (const path of ["", "index.html", "oauth/consent/", "oauth/consent/index.html"]) {
        const kind = path.startsWith("oauth/") ? "consent" : "apps";
        const query = kind === "consent" ? "?authorization_id=t6iubjdnqfkp4d4odxwleypuhprekmuh" : "";
        const url = new URL(base + path + query, origin);
        const response = await fetch(url);
        assert.equal(response.status, 200, url.href);
        const html = await response.text();
        const entry = html.match(/<script[^>]+src="[^"]*assets\/([\w-]+\.js)"/)?.[1];
        assert(entry);
        entries.add(entry);
        const graph = await checkPageAssets(out, html, url, origin + base + "assets/");
        const js = graphText(graph);
        pages.push({ kind, graph });
        assert(js.includes(fixture.NECKARDT_APPS_SUPABASE_URL));
        assert(js.includes(fixture.NECKARDT_APPS_SUPABASE_PUBLISHABLE_KEY));
        if (kind === "consent") {
          assert.doesNotMatch(js, recallCode);
          assert.match(html, /<title>[^<]*(?:consent|authoriz|connect)[^<]*<\/title>/i);
          assert(js.includes("neckardt-apps-oauth-consent"));
          for (const key of ["VITE_CANARY_CLIENT_ID", "VITE_CANARY_USER_DIGEST", "VITE_CANARY_CALLBACK_URL",
            "VITE_SUITE_CLIENT_ID", "VITE_SUITE_CALLBACK_URL"]) {
            assert(js.includes(fixture[key]), `OAuth graph must include synthetic ${key}`);
          }
        } else {
          assert.doesNotMatch(html, /user-scalable=no|maximum-scale/);
          assert(!js.includes("neckardt-apps-oauth-consent"));
          const practice = [...graph].find(([, source]) => source.includes("recall_opportunities"));
          assert(practice, "SPA must be able to load Habit Practice");
          assert(!assetReferences(html).some(link => link.endsWith("/" + practice[0])),
            "launcher must not preload Habit Practice");
          for (const expected of ["recall_due", "recall-grade", "recall_record_action", "recall.round.v2.", "recall.live.v1."]) {
            assert(js.includes(expected), `Habit Practice graph must include ${expected}`);
          }
          const href = html.match(/href="([^"]+recall\/)"/)?.[1];
          assert(href);
          assert.equal(new URL(href, url).pathname, base + "recall/");
        }
      }

      // A real Pages miss returns the custom 404 body, not a server-side rewrite.
      for (const path of ["recall", "recall/", "recall/index.html"]) {
        const url = new URL(base + path + "?q=a%2Bb&q=x%26y#fragment%23with-hash", origin);
        const response = await fetch(url);
        assert.equal(response.status, 404);
        const fallbackScript = (await response.text()).match(/<script>([\s\S]*?)<\/script>/)?.[1];
        assert(fallbackScript);
        let redirect;
        runInNewContext(fallbackScript, { location: Object.assign(url, { replace: href => { redirect = new URL(href, url); } }) });
        assert.equal(redirect?.pathname, base);
        assert.equal(redirect.hash, "#pages:" + url.pathname + url.search + url.hash);
        assert.equal((await fetch(redirect)).status, 200);
      }
      for (const missing of ["recall/assets/index-BGcdV7RE.js", "recall/src/main.tsx", "public-config.json", "src/oauth/main.tsx",
        "recall/supabase/config.toml", "shared/browser-auth.mts", "apps/recall/index.html"]) {
        assert.equal((await fetch(origin + base + missing)).status, 404, missing);
      }
    }
    assert.equal(entries.size, 2, "Consent has its own entry and never mounts the app shell");
    const css = (await Promise.all(assets.filter(name => name.endsWith(".css")).map(name => readFile(join(out, "assets", name), "utf8")))).join("\n");
    assert.match(css, /\.account-form input\{[^}]*font-size:max\(1rem,16px\)/);
    assert.doesNotMatch(css, /touch-action:none/);
    const scripts = await Promise.all(assets.filter(name => name.endsWith(".js")).map(async name => ({ name, source: await readFile(join(out, "assets", name), "utf8") })));
    const sessions = scripts.filter(({ source }) => source.includes("Unable to check your session. Reload to try again."));
    assert.equal(sessions.length, 1, "Apps and Habit Practice share one Account session bundle");
    for (const { kind, graph } of pages) {
      assert.equal(graph.has(sessions[0].name), kind !== "consent", `${kind} Account session dependency`);
    }
  } finally {
    if (files) await new Promise(yes => files.close(yes));
    await rm(tmp, { recursive: true, force: true });
  }
});
test("legacy synthetic owner configuration publishes its domain-separated digest", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "neckardtapps-legacy-consent-"));
  try {
    const out = join(tmp, "site");
    const done = run(out, { ...fixture, VITE_CANARY_USER_DIGEST: "" });
    assert.equal(done.status, 0, done.stderr);
    const html = await readFile(join(out, "oauth", "consent", "index.html"), "utf8");
    const js = graphText(await pageGraph(out, html));
    assert(js.includes(expectedDigest(legacyCanaryId)), "Consent must recognize the legacy synthetic account");
    await assertOwnerValuesAbsent(out, [primaryOwnerId, legacyCanaryId, expectedDigest(primaryOwnerId)]);
  } finally { await rm(tmp, { recursive: true, force: true }); }
});
test("root build accepts public defaults and refuses partial, secret, or false-host configuration", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "neckardtapps-shell-config-"));
  try {
    const out = join(tmp, "site");
    for (const bad of [
      { NECKARDT_APPS_SUPABASE_URL: fixture.NECKARDT_APPS_SUPABASE_URL },
      { NECKARDT_APPS_SUPABASE_PUBLISHABLE_KEY: fixture.NECKARDT_APPS_SUPABASE_PUBLISHABLE_KEY },
      { ...fixture, NECKARDT_APPS_SUPABASE_PUBLISHABLE_KEY: "sb_secret_fake_must_not_ship" },
      { ...fixture, NECKARDT_APPS_SUPABASE_URL: "https://abcdefghijklmnopqrst.supabase.co.invalid" },
      { ...fixture, NECKARDT_APPS_SUPABASE_URL: "https://abcdefghijklmnopqrst.supabase.co/path" }
    ]) {
      assert.notEqual(run(out, bad).status, 0);
      assert.deepEqual(await readdir(tmp), []);
    }
    const done = run(out);
    assert.equal(done.status, 0, done.stderr);
    for (const path of ["index.html", "oauth/consent/index.html"]) {
      const js = graphText(await pageGraph(out, await readFile(join(out, path), "utf8")));
      assert(js.includes(defaults.url), path);
      assert(js.includes(defaults.publishableKey), path);
    }
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
