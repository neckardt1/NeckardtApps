import assert from "node:assert/strict";
import { resetRound } from "../hosted-worker.mjs";
import { checkAppHome, checkBottomAction, phones } from "../mobile-layout.mjs";

export default async function practiceHome(worker) {
  const { page, origin } = worker;
  const card = "Worker card " + worker.id;
  const button = name => page.getByRole("button", { name, exact: true });
  const home = page.getByRole("link", { name: "Habits home", exact: true });
  const original = page.viewportSize();
  const opens = [];
  const opening = request => {
    if (new URL(request.url()).pathname.endsWith("/rpc/recall_open_round")) opens.push(request);
  };
  page.on("request", opening);
  try {
    await resetRound(worker);
    await page.goto(origin + "/recall/");
    for (const size of phones) {
      await page.setViewportSize(size);
      await checkBottomAction(page, button("Start round"), { right: true });
      await checkBottomAction(page, button("Browse all cards"));
    }
    await button("Browse all cards").click();
    await page.getByLabel("Search cards").fill("no-such-fixture");
    await page.getByText("No matching cards.").waitFor();
    await page.getByLabel("Search cards").fill("Fixture answer");
    await page.getByText(card, { exact: true }).click();
    await page.getByText("Fixture answer", { exact: true }).waitFor();
    for (const size of phones) {
      await page.setViewportSize(size);
      await checkAppHome(page, "Habits");
    }
    await home.focus();
    await page.keyboard.press("Enter");
    await button("Start round").waitFor();
    assert(await page.locator("main").evaluate(el => el === document.activeElement));
    await page.goBack();
    await page.getByLabel("Search cards").waitFor();
    await page.goForward();
    await button("Start round").waitFor();
    assert.equal(opens.length, 0);
    await button("Start round").click();
    await checkBottomAction(page, button("Reveal answer"), { right: true });
    await button("Reveal answer").click();
    await page.getByRole("button", { name: "Good", exact: true }).waitFor();
    await home.click();
    await button("Continue round").waitFor();
    await page.reload();
    for (const size of phones) {
      await page.setViewportSize(size);
      await checkBottomAction(page, button("Continue round"), { right: true });
    }
    await button("Continue round").click();
    await page.getByRole("heading", { name: card }).waitFor();
    await page.getByText("Fixture answer", { exact: true }).waitFor();
    for (const size of phones) {
      await page.setViewportSize(size);
      await checkBottomAction(page, button("Good"), { right: true });
    }
    await button("Good").click();
    await page.getByRole("heading", { name: "Saved." }).waitFor();
    await home.click();
    await page.getByText("No cards due right now.").waitFor();
    await page.goBack();
    await page.getByText("No cards due right now.").waitFor();
  } finally {
    page.off("request", opening);
    if (original) await page.setViewportSize(original);
  }
}
