import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

let browser, server, folder, url;
before(async () => {
  folder = await mkdtemp(join(tmpdir(), "kamax-browser-"));
  const file = join(folder, "index.html");
  execFileSync(process.execPath, [fileURLToPath(new URL("./build.mjs", import.meta.url)), file]);
  const html = await readFile(file);
  server = createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(html);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  url = "http://127.0.0.1:" + server.address().port;
  browser = await chromium.launch({ executablePath: process.env.CHROME_BIN || undefined });
});
after(async () => {
  await browser?.close();
  if (server) await new Promise((r) => server.close(r));
  if (folder) await rm(folder, { recursive: true, force: true });
});

async function session(t, mobile = false) {
  const ctx = await browser.newContext({
    viewport: mobile ? { width: 390, height: 844 } : { width: 1200, height: 850 },
    hasTouch: mobile,
    isMobile: mobile,
    timezoneId: "UTC",
  });
  t.after(() => ctx.close());
  const external = [],
    errors = [];
  await ctx.route("**/*", (r) => {
    if (new URL(r.request().url()).origin !== url) {
      external.push(r.request().url());
      return r.abort();
    }
    return r.continue();
  });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  page.setDefaultTimeout(5000);
  await page.clock.install({ time: new Date("2026-11-28T08:45:00Z") });
  await page.goto(url);
  await page.getByRole("heading", { name: "Today's focus" }).waitFor();
  t.after(() => {
    assert.deepEqual(external, []);
    assert.deepEqual(errors, []);
  });
  return { ctx, page };
}
const button = (p, name) => p.getByRole("button", { name, exact: true });
const focus = (p) => p.getByRole("region", { name: "Today's focus" });
const row = (p, title) => p.locator("[data-task]").filter({ has: p.getByText(title, { exact: true }) });
async function swipe(page, element, dx, dy = 0) {
  await element.scrollIntoViewIfNeeded();
  const box = await element.boundingBox(),
    x = box.x + box.width / 2,
    y = box.y + box.height / 2;
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
  for (let i = 1; i <= 6; i++)
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [{ x: x + (dx * i) / 6, y: y + (dy * i) / 6 }],
    });
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await cdp.detach();
}
test("mobile entry separates gestures, details and completion with explicit focus replacement", async (t) => {
  const { page } = await session(t, true);
  assert.equal(await focus(page).getByRole("checkbox").count(), 3);
  assert.equal(
    await page.getByRole("button", { name: /Everything else/ }).getAttribute("aria-expanded"),
    "false",
  );
  await page.getByRole("button", { name: /Everything else/ }).tap();
  await swipe(page, row(page, "Make a grocery list").locator(".task-copy"), 92);
  await page.getByRole("dialog", { name: "Make room in focus" }).waitFor();
  await button(page, "Book the lakeside cabin").tap();
  await focus(page).getByText("Make a grocery list").waitFor();
  await swipe(page, row(page, "Make a grocery list").locator(".task-copy"), -96);
  await page.getByRole("dialog", { name: "Reschedule" }).waitFor();
  await page.getByRole("button", { name: /Tomorrow/ }).tap();
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  assert.equal(await focus(page).getByRole("checkbox").count(), 2);
  const story = row(page, "Outline two interview stories");
  await story.locator(".task-copy").tap();
  await page.getByRole("dialog", { name: "Task details" }).waitFor();
  await button(page, "Close dialog").tap();
  await story.getByRole("checkbox").tap();
  await button(page, "Undo").waitFor();
  await button(page, "Undo").tap();
  await focus(page).getByText("Outline two interview stories").waitFor();
  await page.reload();
  await focus(page).getByText("Outline two interview stories").waitFor();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
});
test("weekly planning, a show-after boundary, and optional simulations through the desktop entry", async (t) => {
  const { page } = await session(t);
  await button(page, "Add task").click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Task name").fill("Fixture check-in");
  await dialog.getByLabel("Priority", { exact: true }).selectOption("High");
  await dialog.getByLabel("Planned date").fill("2026-11-28");
  await dialog.getByLabel("Planned time").fill("19:00");
  await button(dialog, "Scheduling details").click();
  await dialog.getByLabel("Show after").fill("2026-11-28T18:00");
  await dialog.getByLabel("Deadline").fill("2026-11-30");
  await button(dialog, "Add task").click();
  await page.getByRole("button", { name: /Everything else/ }).click();
  assert.equal(await page.getByText("Fixture check-in", { exact: true }).count(), 0);
  await button(page, "This Week").click();
  await row(page, "Fixture check-in").waitFor();
  await button(page, "Preview lab").click();
  await page.getByLabel("Local date and time").fill("2026-11-28T18:01");
  await button(page, "Set preview time").click();
  await page.getByLabel("Nudge frequency").selectOption("2");
  await button(page, "Preview nudges").click();
  await page.getByRole("heading", { name: "Midday nudge" }).waitFor();
  await button(page, "Preview check-in").click();
  assert.equal(await page.locator(".checkin-item").count(), 3);
  assert.equal(await page.locator(".checkin-item").filter({ hasText: "Fixture check-in" }).count(), 0);
  await page.getByLabel("Show simulated focus blocks").click();
  await page.getByText("Focus block", { exact: true }).first().waitFor();
  await page.getByRole("navigation", { name: "Planning" }).getByRole("button", { name: /Today/ }).click();
  await row(page, "Fixture check-in").waitFor();
});
test("two sample profiles share task edits and revocation while private work remains in its owner's view", async (t) => {
  const { page } = await session(t);
  await row(page, "Book the lakeside cabin").locator(".task-copy").click();
  await page.getByLabel("Task name").fill("Reserve the cabin");
  await button(page, "Save changes").click();
  await button(page, "Sample workspace").click();
  await button(page, "Stacey").click();
  await focus(page).getByText("Reserve the cabin").waitFor();
  assert.equal(await page.getByText("Outline two interview stories", { exact: true }).count(), 0);
  await page
    .getByRole("navigation", { name: "Projects" })
    .getByRole("button", { name: "Weekend away" })
    .click();
  await button(page, "Manage sharing").click();
  await button(page, "Make private").click();
  await button(page, "Sample workspace").click();
  await button(page, "Nick").click();
  assert.equal(await page.getByText("Reserve the cabin", { exact: true }).count(), 0);
  assert.equal(
    await page
      .getByRole("navigation", { name: "Projects" })
      .getByRole("button", { name: "Weekend away" })
      .count(),
    0,
  );
});

test("mobile navigation retains keyboard focus and closes with Escape", async (t) => {
  const { page } = await session(t, true);
  await button(page, "Open navigation").focus();
  await page.keyboard.press("Enter");
  const nav = page.getByRole("dialog", { name: "Workspace navigation" });
  await nav.waitFor();
  assert.ok(await nav.evaluate((el) => el.contains(document.activeElement)));
  await page.keyboard.press("Shift+Tab");
  assert.ok(await nav.evaluate((el) => el.contains(document.activeElement)));
  await page.keyboard.press("Escape");
  await nav.waitFor({ state: "hidden" });
  assert.ok(await button(page, "Open navigation").evaluate((el) => el === document.activeElement));
});
test("concurrent edits in two open forms preserve different fields and flag a same-field conflict", async (t) => {
  const { page: nick, ctx } = await session(t);
  const stacey = await ctx.newPage();
  await stacey.clock.install({ time: new Date("2026-11-28T08:45:00Z") });
  await stacey.goto(url);
  await button(stacey, "Sample workspace").click();
  await button(stacey, "Stacey").click();
  async function openBoth(title) {
    await row(nick, title).locator(".task-copy").click();
    await row(stacey, title).locator(".task-copy").click();
  }
  await openBoth("Book the lakeside cabin");
  await nick.getByLabel("Task name").fill("Reserve the cabin");
  await button(nick, "Save changes").click();
  await row(nick, "Reserve the cabin").waitFor();
  await stacey.getByLabel("Notes").fill("A shared fixture note");
  await button(stacey, "Save changes").click();
  await row(stacey, "Reserve the cabin").waitFor();
  await openBoth("Reserve the cabin");
  assert.equal(await nick.getByLabel("Notes").inputValue(), "A shared fixture note");
  await nick.getByLabel("Task name").fill("Confirm the cabin");
  await button(nick, "Save changes").click();
  await row(nick, "Confirm the cabin").waitFor();
  await stacey.getByLabel("Task name").fill("Another name");
  await button(stacey, "Save changes").click();
  await stacey.getByText("The task changed. Check its current details.").waitFor();
  await row(stacey, "Confirm the cabin").waitFor();
});
test("a deadline-only weekly task has one explicitly labelled row and can be planned", async (t) => {
  const { page } = await session(t);
  await button(page, "Add task").click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Task name").fill("File the sample receipt");
  await button(dialog, "Scheduling details").click();
  await dialog.getByLabel("Deadline").fill("2026-11-29");
  await button(dialog, "Add task").click();
  await button(page, "This Week").click();
  await page.getByText("Unscheduled & earlier tasks").click();
  const entry = row(page, "File the sample receipt");
  assert.equal(await entry.count(), 1);
  await entry.getByText("Deadline Nov 29").waitFor();
});

test("the custom date picker preserves a shared time changed while the form was open", async (t) => {
  const { page: nick, ctx } = await session(t);
  const other = await ctx.newPage();
  await other.clock.install({ time: new Date("2026-11-28T08:45:00Z") });
  await other.goto(url);
  await button(other, "Sample workspace").click();
  await button(other, "Stacey").click();
  const title = "Book the lakeside cabin";
  await button(nick, "Actions for " + title).click();
  await button(nick, "Reschedule occurrence").click();
  await row(other, title).locator(".task-copy").click();
  await other.getByLabel("Planned time").fill("14:15");
  await button(other, "Save changes").click();
  await other.getByRole("dialog").waitFor({ state: "hidden" });
  await nick.getByLabel("Pick a date").fill("2026-11-29");
  await button(nick, "Reschedule occurrence").click();
  await nick.getByRole("dialog").waitFor({ state: "hidden" });
  await button(nick, "This Week").click();
  await row(nick, title).locator(".task-copy").click();
  assert.equal(await nick.getByLabel("Planned time").inputValue(), "14:15");
  assert.equal(await nick.getByLabel("Planned date").inputValue(), "2026-11-29");
});
