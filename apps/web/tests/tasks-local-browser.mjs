// Run against disposable local Auth + PostgREST accounts, through the built Pages launcher.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { pacificDate, shiftDate } from "../src/apps/tasks/model.ts";
import { servePages } from "./serve-pages.mjs";
import { checkBottomAction, checkTaskActions } from "./mobile-layout.mjs";

const fixture = JSON.parse(await readFile(process.argv[2], "utf8"));
const local = new URL(fixture.url);
assert.equal(local.protocol, "http:");
assert.equal(local.hostname, "127.0.0.1");
assert.equal(fixture.users.length, 2);
const build = fileURLToPath(new URL("../scripts/build-pages.mjs", import.meta.url));
const tmp = await mkdtemp(join(tmpdir(), "tasks-browser-"));
const out = join(tmp, "site");
let files, browser;
const today = pacificDate(new Date());
const future = shiftDate(today, 10);
const deadline = shiftDate(today, 18);
const run = randomUUID().slice(0, 8);
const shared = `Shared ${run}`;
const edited = `Revised ${run}`;
const button = (root, name) => root.getByRole("button", { name, exact: true });
const title = (page, name) => button(page, name);
const pending = (page, method) => page.waitForResponse(r => r.url().endsWith("/rpc/" + method) && r.request().method() === "POST");

async function startAccount(origin, user, mobile) {
  const context = await browser.newContext(mobile
    ? { viewport: { width: 375, height: 667 }, isMobile: true, hasTouch: true, timezoneId: "Asia/Tokyo" }
    : { viewport: { width: 1180, height: 850 }, timezoneId: "Pacific/Honolulu" });
  const page = await context.newPage();
  page.setDefaultTimeout(8000);
  const state = { loseCreate: false, creates: [] };
  await page.route("**/*", async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin === origin) return route.continue();
    if (url.origin !== fixture.publicOrigin) return route.abort();
    const response = await route.fetch({ url: new URL(url.pathname + url.search, local).href, maxRedirects: 0 });
    if (url.pathname.endsWith("/rpc/tasks_create") && request.method() === "POST") {
      state.creates.push(request.postDataJSON());
      if (state.loseCreate && response.ok()) {
        state.loseCreate = false;
        return route.abort("failed"); // Postgres committed, but the originating UI got no receipt.
      }
    }
    return route.fulfill({ response });
  });
  await page.goto(origin + (mobile ? "/NeckardtApps/tasks/" : "/tasks/"));
  await page.getByText("Sign in under Account to open Tasks.").waitFor();
  await page.getByRole("link", { name: "Home", exact: true }).click();
  await page.getByRole("link", { name: "Account", exact: true }).click();
  await page.getByLabel("Email", { exact: true }).fill(user.email);
  await page.getByLabel("Password", { exact: true }).fill(user.password);
  const tokenReply = page.waitForResponse(r => r.url().includes("/auth/v1/token?grant_type=password"));
  await button(page, "Sign in").click();
  const session = await (await tokenReply).json();
  assert.equal(session.user?.id, user.id, "GoTrue authenticated the expected disposable account");
  await button(page, "Apps").click();
  await page.getByRole("link", { name: /^Tasks\b/ }).click();
  await page.getByRole("heading", { name: "Today", exact: true }).waitFor();
  const rpc = (name, body = {}) => fetch(new URL("/rest/v1/rpc/tasks_" + name, local), {
    method: "POST", headers: { apikey: fixture.publishableKey, authorization: "Bearer " + session.access_token, "content-type": "application/json" },
    body: JSON.stringify({ p_actor: user.id, ...body }), redirect: "error",
  });
  const read = async () => {
    const response = await rpc("read");
    assert.equal(response.status, 200);
    return response.json();
  };
  return { page, rpc, read, state, mobile };
}

async function view(account, name) {
  const { page } = account;
  if (account.mobile && ["Private", "Household", "Completed"].includes(name)) await button(page, "Browse").click();
  await button(page, name).click();
  await page.getByRole("heading", { name, exact: true }).first().waitFor();
}
async function refresh(page) {
  const result = pending(page, "tasks_read");
  await button(page, "Refresh").click();
  assert((await result).ok());
}
async function beginCreate(page, name, list) {
  await button(page, "Add task").first().click();
  const dialog = page.getByRole("dialog", { name: "New task" });
  await dialog.getByLabel("Title", { exact: true }).fill(name);
  if (list) await dialog.getByRole("combobox").selectOption({ label: list });
  return dialog;
}
async function gesture(page, row, path) {
  await row.scrollIntoViewIfNeeded();
  const rect = await row.boundingBox();
  assert(rect);
  const [x, y] = [Math.round(rect.x + rect.width / 2), Math.round(rect.y + rect.height / 2)];
  const cdp = await page.context().newCDPSession(page);
  try {
    for (const [i, [dx, dy]] of path.entries()) {
      await cdp.send("Input.dispatchTouchEvent", { type: i ? "touchMove" : "touchStart", touchPoints: [{ x: x + dx, y: y + dy }] });
    }
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  } finally { await cdp.detach(); }
}
const swipe = (page, task, direction) => gesture(page, title(page, task),
  [[0, 0], [12, 4], [29, 9], [49, 20], [76, 37], [99, 52]].map(([x, y]) => [x * direction, y]));

async function checkHomeWidget(account, listId) {
  const { page } = account;
  const names = [1, 2, 3, 4].map(n => `Home task ${n} ${run}`);
  for (const name of names) {
    const result = await account.rpc("create", { p_list: listId, p_request: randomUUID(), p_fields: {
      title: name, plannedDate: null, plannedTime: null, deadlineDate: null, deadlineTime: null,
      showAfterDate: null, showAfterTime: null,
    } });
    assert(result.ok);
  }
  const home = () => page.getByRole("link", { name: "Home", exact: true }).click();
  await home();
  await button(page, "Pick tasks").click();
  const focus = page.getByRole("region", { name: "Focus", exact: true });
  for (const name of names) {
    await swipe(page, name, 1);
    await title(focus, name).waitFor();
  }
  const ordered = await focus.locator(".tasks-title").allTextContents();
  assert.deepEqual(ordered.slice(0, 4), names.toReversed());
  await button(page, "Done").click();
  await page.waitForURL(url => !url.pathname.endsWith("/tasks/"));
  await home();
  await title(page, names[3]).waitFor();
  assert.deepEqual(await page.locator(".tasks-title").allTextContents(), ordered.slice(0, 3));
  await page.reload();
  await title(page, names[3]).click();
  const editor = page.getByRole("dialog", { name: "Edit task" });
  const revised = names[3] + " edited";
  await editor.getByLabel("Title", { exact: true }).fill(revised);
  await button(editor, "Save changes").click();
  await title(page, revised).waitFor();
  await page.getByRole("checkbox", { name: "Complete " + revised, exact: true }).click();
  await title(page, names[0]).waitFor();
  assert.deepEqual(await page.locator(".tasks-title").allTextContents(), ordered.slice(1, 4));
  await checkBottomAction(page, button(page, "Undo"), { right: true });
  await button(page, "Undo").click();
  await title(page, revised).waitFor();
  await page.getByRole("checkbox", { name: "Complete " + revised, exact: true }).click();
  await title(page, names[0]).waitFor();
  await swipe(page, names[1], -1);
  await button(page.getByRole("region", { name: "Reschedule " + names[1] }), "Tomorrow").click();
  await page.getByRole("link", { name: "All tasks", exact: true }).click();
  await title(focus, names[1]).waitFor();
  assert.equal((await account.read()).tasks.find(t => t.title === names[1]).plannedDate, shiftDate(today, 1));
  await home();
  for (const index of [2, 1, 0]) {
    await page.getByRole("checkbox", { name: "Complete " + names[index], exact: true }).click();
    await title(page, names[index]).waitFor({ state: "hidden" });
  }
  assert(!(await account.read()).tasks.some(t => names.includes(t.title) || t.title === revised));
  await button(page, "Apps").click();
  await page.getByRole("dialog", { name: "Apps" }).getByRole("link", { name: "Tasks", exact: true }).click();
  await page.getByRole("heading", { name: "Today", exact: true }).waitFor();
  console.log("Home kept Today’s Focus order, edited and rescheduled real tasks, and promoted the fourth row into view after completion.");
}

try {
  execFileSync(process.execPath, [build, out], { stdio: "inherit", env: { ...process.env,
    NECKARDT_APPS_SUPABASE_URL: fixture.publicOrigin, NECKARDT_APPS_SUPABASE_PUBLISHABLE_KEY: fixture.publishableKey,
  } });
  const server = await servePages(out);
  files = server.files;
  browser = await chromium.launch(process.env.CHROME_BIN ? { executablePath: process.env.CHROME_BIN } : { channel: "chrome" });
  const [a, b] = await Promise.all(fixture.users.map((user, i) => startAccount(server.origin, user, i === 1)));
  const ap = a.page, bp = b.page;
  await checkTaskActions(bp);
  const snapshots = await Promise.all([a.read(), b.read()]);
  const listId = (i, kind) => snapshots[i].lists.find(l => l.kind === kind).id;
  assert.notEqual(listId(0, "private"), listId(1, "private"));
  assert.equal(listId(0, "household"), listId(1, "household"));
  await checkHomeWidget(b, listId(1, "private"));
  for (const [i, account] of [a, b].entries()) {
    const own = `Private ${i} ${run}`;
    await view(account, "Inbox");
    const dialog = await beginCreate(account.page, own);
    assert.equal(await dialog.locator("option:checked").textContent(), "Private");
    await button(dialog, "Add task").click();
    await title(account.page, own).waitFor();
    const row = (await account.read()).tasks.find(t => t.title === own);
    const other = [b, a][i];
    assert(!(await other.read()).tasks.some(t => t.id === row.id));
    assert.equal((await other.rpc("complete", { p_task: row.id, p_version: row.version })).status, 403);
  }
  await refresh(bp);
  assert.equal(await title(bp, `Private 0 ${run}`).count(), 0);
  console.log("Two password sessions entered Tasks from Home; private API isolation passed in both directions.");

  await view(a, "Household");
  const add = await beginCreate(ap, shared, "Household");
  await add.getByLabel("Planned date", { exact: true }).fill(future);
  await add.getByLabel("Deadline date", { exact: true }).fill(deadline);
  a.state.loseCreate = true;
  await button(add, "Add task").click();
  await button(add, "Retry add").waitFor();
  const receipt = a.state.creates.at(-1);
  await view(b, "Household");
  await refresh(bp);
  await title(bp, shared).click();
  const bEdit = bp.getByRole("dialog", { name: "Edit task" });
  await bEdit.getByLabel("Title", { exact: true }).fill(edited);
  await button(bEdit, "Save changes").click();
  await title(bp, edited).waitFor();
  await button(add, "Retry add").click();
  await title(ap, edited).waitFor();
  assert.deepEqual(a.state.creates.at(-1), receipt);
  const current = async () => (await a.read()).tasks.find(t => t.title === edited);
  const original = await current();
  assert.equal(original.plannedDate, future);
  assert.equal(original.plannedTime, null);
  assert.equal(original.deadlineDate, deadline);
  assert(!(await a.read()).tasks.some(t => t.title === shared));
  console.log("Dropped create receipt, edited in the second browser, retried identical create and retained the edit.");

  await view(b, "Upcoming");
  await title(bp, edited).waitFor(); // Planned ten days out, past the end of the current week.
  await view(b, "Inbox");
  assert.equal(await title(bp, edited).count(), 0);
  await view(b, "Household");
  await swipe(bp, edited, -1);
  const datePanel = bp.getByRole("region", { name: "Reschedule " + edited });
  await datePanel.waitFor();
  await swipe(bp, edited, -1);
  await datePanel.waitFor({ state: "hidden" });
  assert(!(await b.read()).focus.some(choice => choice.taskId === original.id));
  await view(b, "Today");
  assert.equal(await title(bp, edited).count(), 0);
  await view(b, "Household");
  await swipe(bp, edited, 1);
  await view(b, "Today");
  const focus = bp.getByRole("region", { name: "Focus", exact: true });
  await title(focus, edited).waitFor();
  await view(a, "Today");
  assert.equal(await title(ap, edited).count(), 0);
  assert.deepEqual(await current(), original);
  await swipe(bp, edited, -1);
  let panel = bp.getByRole("region", { name: "Reschedule " + edited });
  for (const name of ["Tomorrow", "Later this week", "Weekend", "Next week", "Later"]) await button(panel, name).waitFor();
  // Start a mostly vertical drag on the same swipe surface while the calendar
  // gives the page enough height to scroll.
  const beforeScroll = await bp.evaluate(() => scrollY);
  await gesture(bp, title(bp, edited), [[0, 0], [3, -9], [7, -25], [10, -54], [14, -85]]);
  await bp.waitForFunction(before => scrollY > before + 6, beforeScroll, { timeout: 3000 });
  assert(await panel.isVisible());
  await swipe(bp, edited, -1);
  await title(bp.getByRole("region", { name: "Everything Else" }), edited).waitFor();
  assert.deepEqual(await current(), original);
  await swipe(bp, edited, 1);
  await title(focus, edited).waitFor();
  console.log("Curved mobile swipes promoted, opened the inline calendar and deprioritized a future task without changing its dates or the other account’s Today.");

  await view(a, "Household");
  const ar = ap.locator("[data-task]").filter({ has: title(ap, edited) });
  await ar.hover();
  for (const name of ["Edit task", "Set date", "More actions"]) assert(await button(ar, name).isVisible());
  await ap.mouse.move(1, 1);
  await title(ap, edited).focus();
  await ap.keyboard.press("Tab");
  assert(await button(ar, "Edit task").evaluate(el => el === document.activeElement));
  await ap.keyboard.press("Tab");
  assert(await button(ar, "Set date").evaluate(el => el === document.activeElement));
  await ap.keyboard.press("Enter");
  await ap.getByRole("region", { name: "Reschedule " + edited }).waitFor();
  await ap.keyboard.press("Escape");
  assert(await button(ar, "Set date").evaluate(el => el === document.activeElement));
  await button(ar, "More actions").focus();
  await ap.keyboard.press("Enter");
  await ap.getByRole("menu", { name: "Task actions" }).waitFor();
  await ap.keyboard.press("Escape");
  await button(ar, "Edit task").click();
  const aEdit = ap.getByRole("dialog", { name: "Edit task" });
  await aEdit.getByLabel("Title", { exact: true }).fill(`Stale ${run}`);
  await swipe(bp, edited, -1);
  panel = bp.getByRole("region", { name: "Reschedule " + edited });
  const targetDate = new Date(today + "T12:00:00Z");
  targetDate.setUTCMonth(targetDate.getUTCMonth() + 2, 2);
  const picked = targetDate.toISOString().slice(0, 10);
  await panel.locator(`[data-date="${picked}"]`).click();
  await panel.waitFor({ state: "hidden" });
  const stale = pending(ap, "tasks_change");
  await button(aEdit, "Save changes").click();
  assert.equal((await stale).status(), 409);
  await button(aEdit, "Load latest version").click();
  assert.equal(await aEdit.getByLabel("Title", { exact: true }).inputValue(), edited);
  assert.equal(await aEdit.getByLabel("Planned date", { exact: true }).inputValue(), picked);
  assert.equal(await aEdit.getByLabel("Deadline date", { exact: true }).inputValue(), deadline);
  await aEdit.getByLabel("Planned date", { exact: true }).fill(today);
  await aEdit.getByLabel("Planned time", { exact: true }).fill("19:00");
  await button(aEdit, "Save changes").click();
  await aEdit.waitFor({ state: "hidden" });
  const evening = await current();
  assert.equal(evening.plannedDate, today);
  assert.equal(evening.plannedTime, "19:00");
  assert.equal(evening.showAfterAt, null);
  assert.equal(evening.deadlineDate, deadline);
  await view(a, "Today");
  await title(ap, edited).click(); // Still Pacific morning on a travelling device.
  await aEdit.getByLabel("Show after date", { exact: true }).fill(future);
  await aEdit.getByLabel("Show after time", { exact: true }).fill("19:00");
  await button(aEdit, "Save changes").click();
  await title(ap, edited).waitFor({ state: "hidden" });
  await refresh(bp);
  await title(bp, edited).waitFor({ state: "hidden" });
  assert.equal((await b.rpc("focus", { p_task: original.id, p_state: "promoted" })).status, 422);
  console.log("Two-month inline calendar selection, stale version HTTP 409, Pacific timed plan and explicit Show after passed.");

  await view(b, "Household");
  await title(bp, edited).click();
  await bEdit.locator("summary").filter({ hasText: "Activity" }).click();
  await bEdit.getByText("Moved to top of Focus", { exact:true }).first().waitFor();
  await button(bEdit, "Cancel").click();

  await swipe(bp, edited, -1);
  const schedule = bp.getByRole("region", { name: "Reschedule " + edited });
  await button(schedule, "Tomorrow").click();
  await schedule.waitFor({ state: "hidden" });
  const undo = button(bp, "Undo");
  await undo.waitFor();
  const actions = await bp.locator(".tasks-heading-actions").boundingBox();
  const toast = await bp.locator(".tasks-toast").boundingBox();
  const undoBox = await undo.boundingBox();
  assert(undoBox.width >= 44 && undoBox.height >= 44 && undoBox.x > bp.viewportSize().width * .65);
  assert(toast.y + toast.height <= actions.y && actions.y - toast.y - toast.height < 18, "Undo sits just above the Tasks tabs.");
  await undo.click();
  await bp.locator(".tasks-toast").waitFor({ state: "hidden" });
  assert.equal((await current()).plannedDate, today);
  assert.equal((await current()).plannedTime, "19:00");

  await swipe(bp, edited, -1);
  await button(schedule, "Tomorrow").click();
  await schedule.waitFor({ state: "hidden" });
  const punted = await current();
  const newer = await a.rpc("update", {p_task:punted.id,p_version:punted.version,
    p_fields:{plannedDate:future,plannedTime:"08:00"}});
  assert(newer.ok);
  await undo.click();
  await bp.locator(".tasks-toast").getByText("Can’t undo. This task changed again.").waitFor();
  assert.equal((await current()).plannedDate, future);
  assert.equal((await current()).plannedTime, "08:00");

  await bp.getByLabel("Complete " + edited, { exact: true }).click();
  await title(bp, edited).waitFor({ state: "hidden" });
  await undo.click();
  await title(bp, edited).waitFor();
  await bp.getByLabel("Complete " + edited, { exact: true }).click();
  await title(bp, edited).waitFor({ state: "hidden" });
  await view(a, "Household");
  await refresh(ap);
  await title(ap, edited).waitFor({ state: "hidden" });
  await undo.waitFor();
  await undo.waitFor({ state:"hidden",timeout:15_000 });
  await view(b, "Completed");
  await button(bp, "Activity for " + edited).click();
  const myTrail = bp.getByRole("dialog", {name:edited});
  await myTrail.getByText("Moved to top of Focus", {exact:true}).first().waitFor();
  await button(myTrail, "Close dialog").click();
  await view(a, "Completed");
  await button(ap, "Activity for " + edited).click();
  const trail = ap.getByRole("dialog", {name:edited});
  await trail.getByText("Undid completion", {exact:true}).waitFor();
  assert.equal(await trail.getByText("Completed task", {exact:true}).count(),2);
  assert(await trail.getByText("Rescheduled task", {exact:true}).count() > 0);
  assert.equal(await trail.getByText("Moved to top of Focus", {exact:true}).count(),0);
  assert.equal(await current(),undefined);
  await button(trail, "Close dialog").click();
  console.log("Undo passed on Home and mobile Tasks, a later Household write won, and Completed history remained accessible after expiry.");
  const replay = await a.rpc("create", receipt);
  assert.equal(await replay.json(), original.id);
  assert.equal(await current(), undefined);
  await ap.reload();
  await ap.getByRole("heading", { name: "Today", exact: true }).waitFor();
  await ap.getByRole("link", { name: /^Account/ }).click();
  await button(ap, "Sign out").click();
  await ap.getByLabel("Password", { exact: true }).waitFor();
  await ap.goBack();
  await ap.getByText("Sign in under Account to open Tasks.").waitFor();
  assert.equal(await title(ap, `Private 0 ${run}`).count(), 0);
  console.log("Shared completion, replay after completion, direct-route reload and sign-out passed.");
} finally {
  for (const context of browser?.contexts() ?? []) {
    await context.route("**/*", route => route.abort());
    await Promise.all(context.pages().map(page => page.unrouteAll({ behavior: "wait" })));
  }
  await browser?.close();
  if (files) await new Promise(resolve => files.close(resolve));
  await rm(tmp, { recursive: true, force: true });
}
