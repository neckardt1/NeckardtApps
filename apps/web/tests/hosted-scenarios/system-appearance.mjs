import assert from "node:assert/strict";
import { prepareRound } from "../hosted-worker.mjs";

export default async function systemAppearance(worker) {
  const { page } = worker;
  await prepareRound(worker);
  await page.getByRole("button", { name: "Reveal answer" }).click();
  const answer = page.getByText("Fixture answer", { exact: true });

  try {
    for (const colorScheme of ["dark", "light"]) {
      await page.emulateMedia({ colorScheme });
      await answer.waitFor();
      const palette = await page.locator(".answer-panel").evaluate(panel => ({
        scheme: getComputedStyle(panel).colorScheme,
        ink: getComputedStyle(panel).color,
        surface: getComputedStyle(panel).backgroundColor,
      }));
      assert.equal(palette.scheme, colorScheme);
      const channels = rgb => rgb.match(/\d+/g).map(Number);
      const [light, dark] = colorScheme === "dark"
        ? [palette.ink, palette.surface] : [palette.surface, palette.ink];
      assert(channels(light).every(value => value > 170), light);
      assert(channels(dark).every(value => value < 100), dark);
      assert(await page.getByRole("button", { name: "Good", exact: true }).isEnabled());
    }
  } finally {
    await page.emulateMedia({ colorScheme: null });
  }
}
