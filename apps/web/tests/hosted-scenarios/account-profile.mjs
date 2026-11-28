import assert from "node:assert/strict";

export default async function accountProfile({ page, origin }) {
  await page.goto(origin + "/recall/");
  await page.getByRole("link", { name: "Account", exact: true }).click();
  await page.getByRole("button", { name: "Edit profile" }).click();
  await page.getByLabel("Account name").fill("Profile fixture");
  const png = await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 8; canvas.height = 4;
    canvas.getContext("2d").fillRect(0, 0, 4, 4);
    return canvas.toDataURL().split(",")[1];
  });
  await page.getByLabel("Profile picture", { exact: true }).setInputFiles({
    name: "test.png", mimeType: "image/png", buffer: Buffer.from(png, "base64")
  });
  await page.getByAltText("Profile picture preview").waitFor();
  await page.getByRole("button", { name: "Save profile" }).click();
  const account = page.getByRole("link", { name: "Account: Profile fixture", exact: true });
  await account.waitFor();
  await page.getByRole("link", { name: "Home", exact: true }).click();
  await page.getByRole("heading", { name: "Home" }).waitFor();
  assert.equal(page.url(), origin + "/");
  await page.reload();
  await account.waitFor();
  assert.ok(await account.locator("img").evaluate(img => img.complete && img.naturalWidth === 160));
  for (const viewport of [{ width: 390, height: 844 }, { width: 1280, height: 800 }]) {
    await page.setViewportSize(viewport);
    for (const colorScheme of ["light", "dark"]) {
      await page.emulateMedia({ colorScheme });
      await account.click();
      await page.getByRole("heading", { name: "Profile", exact: true }).waitFor();
      assert.equal(page.url(), origin + "/profile");
      assert.equal(await page.getByRole("dialog").count(), 0);
      const home = await page.getByRole("link", { name: "Home", exact: true }).boundingBox();
      const avatar = await account.boundingBox();
      if (viewport.width < 720) {
        assert.ok(avatar.x < home.x && avatar.y > viewport.height / 2);
      } else {
        assert.ok(avatar.x > home.x && avatar.y < viewport.height / 2);
      }
      assert.equal(await page.locator("html").evaluate(el => getComputedStyle(el).colorScheme), colorScheme);
      await page.getByRole("button", { name: "Edit profile" }).click();
      assert.equal(await page.getByLabel("Account name").inputValue(), "Profile fixture");
      await page.getByRole("button", { name: "Cancel" }).click();
      assert.ok(await page.getByRole("link", { name: "Manage connections" }).isVisible());
      await page.goBack();
      await page.getByRole("heading", { name: "Home" }).waitFor();
    }
  }
  await account.click();
  await page.getByRole("button", { name: "Edit profile" }).click();
  await page.getByRole("button", { name: "Remove picture" }).click();
  await page.getByLabel("Account name").fill("");
  await page.getByRole("button", { name: "Save profile" }).click();
  await page.getByText("Profile saved.", { exact: true }).waitFor();
  await page.reload();
  await page.getByRole("heading", { name: "Profile", exact: true }).waitFor();
  await page.getByRole("button", { name: "Edit profile" }).click();
  assert.equal(await page.getByLabel("Account name").inputValue(), "");
  assert.equal(await page.getByAltText("Profile picture preview").count(), 0);
}
