import assert from "node:assert/strict";

export default async function practiceHeadings({ page, origin }) {
  await page.goto(origin + "/recall/");
  const deckName = page.getByRole("heading", { level: 1, name: "Habit Practice" });
  const round = page.getByRole("heading", { name: "Practice round" });
  for (const width of [390, 1440]) {
    await page.setViewportSize({ width, height: 844 });
    for (const colorScheme of ["light", "dark"]) {
      await page.emulateMedia({ colorScheme });
      await deckName.waitFor();
      assert((await deckName.boundingBox()).height <= 1);
      assert((await round.boundingBox()).height > 1);
      await page.getByRole("button", { name: "Browse all cards" }).click();
      const catalog = page.getByRole("heading", { level: 1, name: "Browse cards" });
      await catalog.waitFor();
      assert((await catalog.boundingBox()).height < 32);
      await page.getByRole("searchbox", { name: "Search cards" }).waitFor();
      await page.getByRole("button", { name: "Practice home" }).click();
    }
  }
}
