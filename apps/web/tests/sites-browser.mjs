import assert from "node:assert/strict";
import { chromium } from "playwright-core";
import { checkBottomAction, phones } from "./mobile-layout.mjs";

export async function checkPrivateSites(origin, remote) {
  const browser = await chromium.launch(process.env.CHROME_BIN
    ? { executablePath: process.env.CHROME_BIN } : { channel: "chrome" });
  try {
    const page = await browser.newPage();
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
      const rows = url.pathname.endsWith("site_links") ? [] : path === "eq.trips/packing"
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
      await checkBottomAction(page, page.getByRole("link", { name: "All private sites" }), { right: true });
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await checkBottomAction(page, page.getByRole("link", { name: "All private sites" }), { right: true });
    }
  } finally { await browser.close(); }
}
