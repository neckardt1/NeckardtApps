import assert from "node:assert/strict";
import { chromium } from "playwright-core";
import { checkSuiteNavigation, checkTaskActions, phones } from "./mobile-layout.mjs";

export async function checkSiteAndTaskRoutes(origin, remote) {
  const browser = await chromium.launch(process.env.CHROME_BIN
    ? { executablePath: process.env.CHROME_BIN } : { channel: "chrome" });
  try {
    const page = await browser.newPage({ hasTouch: true });
    await page.addInitScript(key => {
      if (window !== window.top) return;
      localStorage.setItem(key, JSON.stringify({ access_token: "fixture", refresh_token: "fixture", token_type: "bearer",
        expires_at: Math.floor(Date.now() / 1000) + 3600, user: { id: "fixture-owner", aud: "authenticated" } }));
    }, "sb-" + new URL(remote).hostname.split(".")[0] + "-auth-token");
    const external = [];
    await page.route("**/*", async route => {
      const request = route.request(), url = new URL(request.url());
      if (url.origin === origin) return route.continue();
      if (url.origin !== remote) { external.push(url.href); return route.abort(); }
      const headers = { "access-control-allow-origin": origin, "access-control-allow-headers": request.headers()["access-control-request-headers"] ?? "*" };
      if (request.method() === "OPTIONS") return route.fulfill({ status: 204, headers });
      assert.equal(request.headers().authorization, "Bearer fixture");
      const path = url.searchParams.get("path");
      const html = '<p>Private content</p><img src="https://fixture.invalid/image"><script>document.body.dataset.executed="yes"</script>';
      const rows = (url.pathname.endsWith("site_links") || url.pathname.endsWith("/sites")) ? [] : path === "eq.trips/packing"
        ? [{ title: "Packing", html }] : [{ path: "", title: "Home" }, { path: "trips/packing", title: "Packing" }];
      await route.fulfill({ json: rows, headers });
    });
    const href = origin + "/NeckardtApps/sites/family/trips/packing";
    await page.goto(href);
    const frame = page.frameLocator("iframe");
    await frame.getByText("Private content").waitFor();
    assert.equal(await page.locator("iframe").getAttribute("sandbox"), "");
    assert.equal(await frame.locator("body").getAttribute("data-executed"), null);
    assert.deepEqual(external, []);
    assert.equal(await page.getByRole("navigation", { name: "Site navigation" }).getByRole("link", { name: "Home", exact: true }).getAttribute("href"), "/NeckardtApps/sites/family");
    for (const size of phones) {
      await page.setViewportSize(size);
      await checkSuiteNavigation(page, "Sites");
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await checkSuiteNavigation(page, "Sites");
    }
    await page.getByRole("link", { name: "Sites home" }).click();
    for (const size of phones) {
      await page.setViewportSize(size);
      await checkSuiteNavigation(page, "Sites");
    }
    await page.goBack();
    await frame.getByText("Private content").waitFor();
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.getByRole("link", { name: "Sites home" }).click();
    assert.equal(new URL(page.url()).pathname, "/NeckardtApps/sites");
    await page.goBack();
    await frame.getByText("Private content").waitFor();
    // Follow the shared switcher from a nested site into the signed-in Tasks UI.
    await page.route("**/rest/v1/rpc/tasks_read", route => route.fulfill({ json: {
      lists: [{ id: "private-list", kind: "private" }, { id: "shared-list", kind: "household" }],
      tasks: [], focus: [], focusDay: "2026-01-01",
    } }));
    await page.setViewportSize(phones[0]);
    await page.getByRole("button", { name: "Apps", exact: true }).tap();
    await page.getByRole("dialog", { name: "Apps" }).getByRole("link", { name: "Tasks" }).tap();
    await page.getByRole("button", { name: "Add task" }).waitFor();
    await checkTaskActions(page);
    await page.getByRole("link", { name: "Home", exact: true }).tap();
    for (const size of phones) {
      await page.setViewportSize(size);
      await checkSuiteNavigation(page);
    }
  } finally { await browser.close(); }
}
