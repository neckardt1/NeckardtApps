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

export async function checkSuiteNavigation(page, appName, bottomInset = 0) {
  const suite = page.locator(".topbar");
  const account = suite.getByRole("link", { name: /^Account/ });
  const apps = suite.getByRole("button", { name: "Apps", exact: true });
  const home = suite.getByRole("link", { name: "Home", exact: true });
  const controls = [account];
  if (appName) controls.push(suite.getByRole("link", { name: appName + " home", exact: true }));
  controls.push(apps, home);
  const { width, height } = page.viewportSize();
  const bar = await suite.boundingBox();
  assert.ok(bar && Math.abs(bar.y + bar.height - height) <= 1, "Suite bar touches the bottom edge.");
  let end = 0;
  for (const control of controls) {
    const box = await control.boundingBox();
    assert.ok(box && box.width >= 44 && box.height >= 44 && box.x >= end - 1,
      `${await control.getAttribute("class")} at ${JSON.stringify(box)}, previous right edge ${end}, viewport ${width}×${height}`);
    assert.ok(box.y >= bar.y && box.y + box.height <= height - bottomInset);
    assert.ok(await control.evaluate(el => {
      const r = el.getBoundingClientRect();
      return el.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2));
    }));
    end = box.x + box.width;
  }
  const picker = await apps.boundingBox();
  assert.ok(Math.abs(picker.x + picker.width / 2 - (bar.x + bar.width / 2)) <= 1, "Apps stays centered on every route.");
  assert.ok((await account.boundingBox()).x < width * .1 && end > width * .9 && end <= width);
}

export async function checkTaskActions(page) {
  const original = page.viewportSize();
  const add = page.getByRole("button", { name: "Add task", exact: true });
  const views = page.getByRole("navigation", { name: "Task views" });
  try {
    for (const size of phones) {
      await page.setViewportSize(size);
      await checkSuiteNavigation(page, "Tasks");
      const bar = await page.locator(".topbar").boundingBox();
      const suite = page.locator(".topbar");
      await suite.getByRole("link", { name: /^Account/ }).focus();
      for (const control of [suite.getByRole("link", { name: "Tasks home" }), suite.getByRole("button", { name: "Apps" }), suite.getByRole("link", { name: "Home", exact: true })]) {
        await page.keyboard.press("Tab");
        assert.ok(await control.evaluate(el => el === document.activeElement), "Tab follows the visible suite controls.");
      }
      const addBox = await add.boundingBox();
      assert.ok(addBox.width >= 44 && addBox.height >= 44 && addBox.x > size.width * .75);
      let end = 0;
      for (const name of ["Inbox", "Today", "Upcoming", "Browse"]) {
        const tab = views.getByRole("button", { name, exact: true });
        const box = await tab.boundingBox();
        assert.ok(box.x >= end && box.width >= 44 && box.height >= 44);
        assert.ok(box.y >= bar.y - 60 && box.y + box.height <= bar.y);
        assert.ok(Math.abs(box.y + box.height / 2 - addBox.y - addBox.height / 2) < 2);
        assert.ok(await tab.evaluate(el => {
          const rect = el.getBoundingClientRect();
          return el.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2));
        }));
        end = box.x + box.width;
        await tab.tap();
        await page.getByRole("heading", { name, exact: true }).waitFor();
        assert.equal(await tab.getAttribute("aria-current"), "page");
        await checkSuiteNavigation(page, "Tasks");
      }
      assert.ok(end <= addBox.x + 1);
      const directory = page.getByRole("navigation", { name: "Task lists" });
      assert.deepEqual(await directory.getByRole("button").allTextContents(), ["Private", "Household"]);
      for (const choice of await directory.getByRole("button").all()) {
        const box = await choice.boundingBox();
        assert.ok(box.y + box.height / 2 >= size.height / 2 && box.height >= 44 && box.y + box.height <= addBox.y);
      }
      await directory.getByRole("button", { name: "Household" }).click();
      await page.getByRole("heading", { name: "Household" }).waitFor();
      assert.equal(await views.getByRole("button", { name: "Browse" }).getAttribute("aria-current"), "page");
      await add.click();
      const editor = page.getByRole("dialog", { name: "New task" });
      assert.equal(await editor.locator("option:checked").textContent(), "Household");
      assert.ok(await editor.getByLabel("Title").evaluate(el => el === document.activeElement));
      await page.setViewportSize({ width: size.width, height: 320 });
      await editor.getByLabel("Show after date").scrollIntoViewIfNeeded();
      const save = editor.getByRole("button", { name: "Add task" });
      const box = await save.boundingBox();
      assert.ok(box && box.x + box.width / 2 > size.width / 2 && box.y > 220 && box.y + box.height <= 320);
      await save.click({ trial: true });
      await page.keyboard.press("Escape");
      assert.ok(await add.evaluate(el => el === document.activeElement));
      await page.setViewportSize(size);
      const enlarged = await page.addStyleTag({ content: ":root { font-size: 200%; }" });
      try {
        await views.getByRole("button", { name: "Browse" }).tap();
        for (const tab of await views.getByRole("button").all()) {
          assert.ok(await tab.evaluate(el => {
            const label = document.createRange();
            label.selectNodeContents(el.lastChild);
            return label.getClientRects().length === 1 && el.clientWidth >= el.scrollWidth;
          }), "Each enlarged tab label fits on one line.");
        }
        await checkSuiteNavigation(page, "Tasks");
        const apps = suite.getByRole("button", { name: "Apps", exact: true });
        await apps.tap();
        await page.getByRole("dialog", { name: "Apps" }).waitFor();
        await page.keyboard.press("Escape");
        assert.ok(await apps.evaluate(el => el === document.activeElement));
        await suite.getByRole("link", { name: "Tasks home" }).tap();
      } finally { await enlarged.evaluate(el => el.remove()); }
      await page.getByRole("heading", { name: "Today", exact: true }).waitFor();
      await page.goBack();
      await page.getByRole("heading", { name: "Browse", exact: true }).waitFor();
      await page.goBack();
      await page.getByRole("heading", { name: "Household" }).waitFor();
      await views.getByRole("button", { name: "Today" }).click();
    }
  } finally { if (original) await page.setViewportSize(original); }
}
