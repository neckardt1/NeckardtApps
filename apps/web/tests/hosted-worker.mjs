import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { createServer } from "vite";
import { loadPublicBuildConfig } from "../build-config.ts";

export function hostedConfig(env) {
  const config = loadPublicBuildConfig(env);
  if (!env.HABIT_FIXTURE_KEY) throw Error("Set the host-scoped HABIT_FIXTURE_KEY for provisioning.");
  if (config.url !== `https://${env.HABIT_FIXTURE_PROJECT_REF?.trim()}.supabase.co`) {
    throw Error("HABIT_FIXTURE_PROJECT_REF must match the app's configured Supabase project.");
  }
  return config;
}

export async function openWorker(browser, origin, config, createFixture) {
  const context = await browser.newContext({ serviceWorkers: "block" });
  try {
    await context.route("**/*", route => [origin, config.url].includes(new URL(route.request().url()).origin)
      ? route.continue() : route.abort());
    const page = await context.newPage();
    page.setDefaultTimeout(15_000);
    const password = randomBytes(32).toString("base64url") + "aA1!";
    const { email, id } = await createFixture(password);
    await page.goto(origin);
    await page.getByRole("button", { name: "Account", exact: true }).click();
    // Playwright failure messages can echo fill arguments. Keep credentials out of diagnostics.
    try {
      await page.getByLabel("Email", { exact: true }).fill(email);
      await page.getByLabel("Password", { exact: true }).fill(password);
      const [login] = await Promise.all([
        page.waitForResponse(r => r.request().method() === "POST" && r.url().startsWith(config.url + "/auth/v1/token?")),
        page.getByRole("button", { name: "Sign in", exact: true }).click()
      ]);
      if (!login.ok() || (await login.json()).user?.id !== id) throw Error();
      await page.getByRole("button", { name: "Sign in", exact: true }).waitFor({ state: "detached" });
    } catch {
      throw Error("The app's password sign-in did not establish the assigned fixture identity.");
    }
    return { page, context, origin, config, id };
  } catch (error) {
    await context.close();
    throw error;
  }
}

// Ask the same supabase-js client as the Vite app to refresh and authorize requests.
async function fixtureRpc(worker, name) {
  return worker.page.evaluate(async ({ config, name, id }) => {
    const { getSiteClient } = await import("/src/shell/site-client.ts");
    const client = getSiteClient(config);
    const { data: { session } } = await client.auth.getSession();
    if (session?.user.id !== id) throw Error("The browser session changed.");
    const { data, error } = await client.rpc(name);
    if (error) throw Error(`Fixture RPC ${name} failed (${error.code}).`);
    if (name === "recall_reset_fixture") localStorage.removeItem(`recall.round.v2.${config.url}.${id}`);
    return data;
  }, { config: worker.config, id: worker.id, name });
}

export async function prepareRound(worker) {
  await worker.page.goto(worker.origin);
  const card = await fixtureRpc(worker, "recall_reset_fixture");
  await worker.page.goto(worker.origin + "/recall/");
  await worker.page.getByRole("button", { name: "Start review" }).click();
  await worker.page.getByRole("heading", { name: "Worker card " + worker.id, exact: true }).waitFor();
  return card;
}

export async function gradeRound(worker, card) {
  const { page, config } = worker;
  await page.getByRole("button", { name: "Reveal answer" }).click();
  await page.getByText("Fixture answer", { exact: true }).waitFor();
  const [response] = await Promise.all([
    page.waitForResponse(r => r.request().method() === "POST" && r.url() === config.url + "/functions/v1/recall-grade"),
    page.getByRole("button", { name: "Good", exact: true }).click()
  ]);
  assert.ok(response.ok(), `Grading returned HTTP ${response.status()}.`);
  const receipt = await response.json();
  assert.equal(receipt.card_id, card);
  assert.equal(receipt.revision, 1);
  await page.getByRole("button", { name: "Finish" }).click();
  await page.getByRole("heading", { name: "Saved.", exact: true }).waitFor();
}

export async function smoke(workers) {
  const cards = await Promise.all(workers.map(prepareRound));
  assert.equal(new Set(cards).size, cards.length);
  await gradeRound(workers[0], cards[0]);
  if (workers[1]) {
    const due = await fixtureRpc(workers[1], "recall_due");
    assert.deepEqual(due.map(row => [row.card_id, row.revision]), [[cards[1], 0]]);
    await gradeRound(workers[1], cards[1]);
  }
}

async function main() {
  // Playwright API debug logs can include password-field input.
  if (process.env.DEBUG || process.env.PWDEBUG) throw Error("Disable debug logging before opening a fixture session.");
  const config = hostedConfig(process.env);
  const provision = async password => {
    const response = await fetch(config.url + "/functions/v1/provision-worker", {
      method: "POST", redirect: "error", signal: AbortSignal.timeout(20_000),
      headers: { "content-type": "application/json", "x-fixture-key": process.env.HABIT_FIXTURE_KEY },
      body: JSON.stringify({ password })
    });
    if (response.status !== 201) throw Error(`Fixture provisioning returned HTTP ${response.status}.`);
    return response.json();
  };
  const started = performance.now();
  const root = fileURLToPath(new URL("../", import.meta.url));
  const vite = await createServer({ root, logLevel: "error", server: { host: "127.0.0.1", port: 0 } });
  let browser;
  try {
    await vite.listen();
    const origin = `http://127.0.0.1:${vite.httpServer.address().port}`;
    const launch = process.env.CHROME_BIN ? { executablePath: process.env.CHROME_BIN } : { channel: "chrome" };
    const proxy = process.env.HTTPS_PROXY || process.env.https_proxy;
    if (proxy) {
      const address = new URL(proxy);
      launch.proxy = { server: address.origin, bypass: "localhost,127.0.0.1",
        username: decodeURIComponent(address.username), password: decodeURIComponent(address.password) };
    }
    browser = await chromium.launch(launch);
    const count = process.argv.includes("--pair") ? 2 : 1;
    const workers = await Promise.all(Array.from({ length: count }, () => openWorker(browser, origin, config, provision)));
    console.log(`${count} fixture session(s) ready in ${Math.round(performance.now() - started)} ms.`);
    async function run() {
      const start = performance.now();
      await smoke(workers);
      console.log(`Saved and verified in ${Math.round(performance.now() - start)} ms.`);
    }
    if (process.argv.includes("--watch")) {
      const input = createInterface({ input: process.stdin });
      try {
        const check = () => run().catch(error => console.error(error.message));
        await check();
        console.log("Edit the app, then press Enter to reset and rerun. End input to quit.");
        for await (const _line of input) await check();
      } finally { input.close(); }
    } else {
      await run();
    }
  } finally {
    try { await browser?.close(); } finally { await vite.close(); }
  }
}

if (import.meta.main) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
