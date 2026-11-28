import assert from "node:assert/strict";

export const phones = [{ width: 320, height: 568 }, { width: 390, height: 844 }];

// Measure before clicking. Playwright's click would scroll an offscreen target into view.
export async function checkBottomAction(page, control, { right = false } = {}) {
  await control.waitFor();
  const nav = await page.locator(".topbar").boundingBox();
  const box = await control.boundingBox();
  assert.ok(box && nav && box.width >= 44 && box.height >= 44);
  assert.ok(box.y >= nav.y - 125 && box.y + box.height <= nav.y + 1,
    `Action at ${box.y}..${box.y + box.height}, navigation starts at ${nav.y}`);
  const x = right ? Math.min(box.x + box.width - 6, nav.width * .85) : box.x + box.width / 2;
  if (right) assert.ok(x >= nav.width * .65, "The right thumb can reach the action.");
  assert.ok(await control.evaluate((el, point) => el.contains(document.elementFromPoint(point.x, point.y)),
    { x, y: box.y + box.height / 2 }), "The action receives a tap at this point.");
}

export async function checkTaskActions(page) {
  const original = page.viewportSize();
  const add = page.getByRole("button", { name: "Add task", exact: true });
  const views = page.getByRole("button", { name: "Task views", exact: true });
  try {
    for (const size of phones) {
      await page.setViewportSize(size);
      await checkBottomAction(page, add, { right: true });
      await checkBottomAction(page, views);
      await views.click();
      const drawer = page.getByRole("dialog", { name: "Tasks", exact: true });
      const household = await drawer.getByRole("button", { name: "Household" }).boundingBox();
      assert.ok(household && household.y > size.height / 2 && household.height >= 44);
      await page.keyboard.press("Escape");
      await add.click();
      const editor = page.getByRole("dialog", { name: "New task" });
      assert.ok(await editor.getByLabel("Title").evaluate(el => el === document.activeElement));
      await page.setViewportSize({ width: size.width, height: 320 });
      await editor.getByLabel("Show after date").scrollIntoViewIfNeeded();
      const save = editor.getByRole("button", { name: "Add task" });
      const box = await save.boundingBox();
      assert.ok(box && box.x + box.width / 2 > size.width / 2 && box.y > 220 && box.y + box.height <= 320);
      await save.click({ trial: true });
      await page.keyboard.press("Escape");
      assert.ok(await add.evaluate(el => el === document.activeElement));
    }
  } finally { if (original) await page.setViewportSize(original); }
}
