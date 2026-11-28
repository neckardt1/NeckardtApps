import assert from "node:assert/strict";
import { chromium } from "playwright-core";

export async function checkBrowserRoutes(origin) {
  const browser = await chromium.launch(process.env.CHROME_BIN
    ? { executablePath: process.env.CHROME_BIN }
    : { channel: "chrome" });
  try {
    const page = await browser.newPage();
    await page.route("**/*", route => new URL(route.request().url()).origin === origin
      ? route.continue() : route.abort());
    const practice = page.getByRole("heading", { name: "Habit Practice", exact: true });
    const checkPractice = async url => {
      await practice.waitFor();
      assert.equal(page.url(), url);
      assert.equal(await page.title(), "Habit Practice");
    };
    const documents = [];
    page.on("request", request => {
      if (request.isNavigationRequest()) documents.push(request.url());
    });
    for (const base of ["/", "/NeckardtApps/"]) {
      const root = origin + base;
      const deep = root + "recall/?tag=a%2Bb&tag=x%26y#saved%23detail";
      await page.goto(deep, { waitUntil: "commit" });
      await checkPractice(deep);
      await page.reload({ waitUntil: "commit" });
      await checkPractice(deep);

      const before = documents.length;
      await page.getByRole("link", { name: "Home", exact: true }).click();
      await page.getByRole("heading", { name: "Home" }).waitFor();
      assert.equal(page.url(), root);
      await page.goBack();
      await checkPractice(deep);
      assert.equal(documents.length, before, "In-app navigation keeps the same document");

      await page.getByRole("link", { name: "Account", exact: true }).click();
      const profile = page.getByRole("heading", { name: "Profile", exact: true });
      await profile.waitFor();
      assert.equal(page.url(), root + "profile");
      await page.reload({ waitUntil: "commit" });
      await profile.waitFor();
      await page.getByLabel("Password", { exact: true }).waitFor();
      assert.equal(await page.title(), "Profile");
      await page.goBack();
      await checkPractice(deep);

      await page.getByRole("button", { name: "Apps" }).click();
      await page.getByRole("dialog", { name: "Apps" }).getByRole("link", { name: "All apps" }).click();
      await page.getByRole("heading", { name: "All apps" }).waitFor();
      assert.equal(page.url(), root + "apps/");
      await page.reload({ waitUntil: "commit" });
      await page.getByRole("heading", { name: "All apps" }).waitFor();
      await page.getByRole("link", { name: "Home", exact: true }).click();
      await page.getByRole("heading", { name: "Home" }).waitFor();
      assert.equal(page.url(), root);

      const alias = root + "recall/index.html";
      await page.goto(alias, { waitUntil: "commit" });
      await checkPractice(alias);
      await page.goto(root + "ReCaLl/index.html", { waitUntil: "commit" });
      await page.getByRole("link", { name: "Habits home" }).click();
      await checkPractice(root + "recall/");
      const consent = root + "oauth/consent/?authorization_id=t6iubjdnqfkp4d4odxwleypuhprekmuh#return";
      assert.equal((await page.goto(consent)).status(), 200);
      await page.getByRole("button", { name: "Continue" }).waitFor();
      assert.equal(page.url(), consent);
      assert.equal(await page.getByRole("link", { name: "Account" }).count(), 0);
      for (const mode of [consent, root + "oauth/consent/?manage"]) {
        await page.setContent('<iframe title="Connection settings"></iframe>');
        await page.locator("iframe").evaluate((frame, url) => { frame.src = url; }, mode);
        const frame = page.frameLocator("iframe");
        await frame.getByText("Open Neckardt Apps in its own tab to manage or approve connections.").waitFor();
        assert.equal(await frame.locator("input,button").count(), 0);
      }
    }
  } finally {
    await browser.close();
  }
}
