import assert from "node:assert/strict";
import { resetRound } from "../hosted-worker.mjs";

const phones = [
  { width: 375, height: 667, theme: "light" },
  { width: 390, height: 844, theme: "dark" },
  { width: 430, height: 932, theme: "light" },
];

async function dockPositions(page, step, action) {
  const positions = [];
  for (const { width, height, theme } of phones) {
    await page.setViewportSize({ width, height });
    await page.emulateMedia({ colorScheme: theme });
    await page.getByText(`Step ${step} of 2`, { exact: true }).waitFor();
    const button = page.getByRole("button", { name: action, exact: true });
    const box = await button.boundingBox();
    const nav = await page.locator(step === 1 ? ".tasks-heading-actions" : ".topbar").boundingBox();
    const footer = await page.locator(".guide-footer").boundingBox();
    assert(box.height >= 44 && box.y + box.height <= nav.y && footer.y + footer.height <= nav.y + 1);
    assert(await button.evaluate(el => {
      const r = el.getBoundingClientRect();
      return el.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2));
    }));
    assert.equal(await page.locator("html").evaluate(el => getComputedStyle(el).colorScheme), theme);
    if (step === 2) {
      const ratings = await page.locator(".ratings").boundingBox();
      assert(ratings.y >= 0 && ratings.y + ratings.height <= footer.y);
      for (const grade of ["Again", "Hard", "Good", "Easy"]) assert(await page.getByRole("button", { name: grade, exact: true }).isEnabled());
    }
    positions.push([box.x + box.width, box.y + box.height]);
  }
  return positions;
}

export default async function guidedHome(worker) {
  const { page, id, origin } = worker;
  const card = await resetRound(worker);
  await page.evaluate(({ project, id }) => {
    for (const marker of ["started", "planned", "dismissed"]) localStorage.removeItem(`home.daily.${project}.${id}.${marker}`);
  }, { project: worker.config.url, id });
  const button = name => page.getByRole("button", { name, exact: true });
  const home = () => page.getByRole("link", { name: "Home", exact: true }).click();
  const reminder = page.getByRole("link", { name: "Habit Practice", exact: true });
  const finishCalls = [];
  const observe = request => {
    if (request.method() === "POST" && new URL(request.url()).pathname.endsWith("/rpc/recall_finish_round")) finishCalls.push(request);
  };
  const cdp = await page.context().newCDPSession(page);
  page.on("request", observe);
  try {
    // Use an actual Pacific midnight. Return to wall time before recording a grade.
    await page.clock.setFixedTime(new Date("2026-03-08T07:59:58Z"));
    await page.setViewportSize({ width: phones[0].width, height: phones[0].height });
    await page.goto(origin);
    await button("Pick tasks").click();
    await page.getByRole("heading", { name: "Today", exact: true }).waitFor();
    await home();
    await page.reload();
    await button("Continue planning").click();
    await page.reload();
    const positions = await dockPositions(page, 1, "Done");
    await button("Done").click();
    await button("Reveal answer").click();
    await page.getByText("Fixture answer", { exact: true }).waitFor();
    assert.deepEqual(await dockPositions(page, 2, "Skip practice"), positions);
    await button("Skip practice").click();
    await reminder.waitFor();
    await page.reload();
    await reminder.click();
    await page.getByText("Fixture answer", { exact: true }).waitFor();
    await page.reload();
    await page.getByText("Fixture answer", { exact: true }).waitFor();
    await button("Skip practice").click();
    await button("Dismiss Habit Practice for today").click();
    await page.reload();
    await page.getByText("Nothing in Focus.", { exact: true }).waitFor();
    assert.equal(await reminder.count(), 0);

    await page.clock.setFixedTime(new Date("2026-03-08T08:00:01Z"));
    await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
    await button("Pick tasks").click();
    await button("Done").click();
    await page.getByText("Fixture answer", { exact: true }).waitFor();
    await button("Skip practice").click();
    const row = await reminder.boundingBox();
    const x = row.x + row.width / 2, y = row.y + row.height / 2;
    await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: true });
    for (const [i, dx] of [0, 15, 40, 80].entries()) {
      await cdp.send("Input.dispatchTouchEvent", { type: i ? "touchMove" : "touchStart", touchPoints: [{ x: x - dx, y }] });
    }
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await page.getByText("Nothing in Focus.", { exact: true }).waitFor();
    assert.equal(finishCalls.length, 0, "leaving and dismissing must preserve the actual round");

    await page.clock.setFixedTime(new Date());
    await page.goto(origin);
    await button("Pick tasks").click();
    await button("Done").click();
    await page.getByText("Fixture answer", { exact: true }).waitFor();
    const [grade, finished] = await Promise.all([
      page.waitForResponse(r => r.url().endsWith("/functions/v1/recall-grade") && r.request().postDataJSON()?.grade === "medium"),
      page.waitForResponse(r => r.url().includes("/rpc/recall_finish_round") && r.request().method() === "POST"),
      button("Good").click(),
    ]);
    assert(grade.ok() && finished.ok());
    const receipt = await grade.json();
    assert.equal(receipt.card_id, card);
    assert.equal(receipt.revision, 1);
    await page.getByText("All done for today.", { exact: true }).waitFor();
    assert.equal(new URL(page.url()).pathname, "/");
    await page.reload();
    await page.getByRole("link", { name: "Pick more tasks" }).waitFor();
    assert.equal(await reminder.count(), 0);
    await page.goto(origin + "/recall/");
    await page.getByText("No cards due right now.").waitFor();
    await button("Browse all cards").click();
    await page.getByLabel("Search cards").waitFor();
    assert.equal(await button("Skip practice").count(), 0);
  } finally {
    page.off("request", observe);
    await cdp.detach();
  }
}
