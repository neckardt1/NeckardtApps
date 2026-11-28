import { checkSuiteNavigation, phones } from "../mobile-layout.mjs";

export default async function suiteNavigation({ page, origin }) {
  const bar = page.locator(".topbar");
  const apps = bar.getByRole("button", { name: "Apps", exact: true });
  await page.goto(origin);
  for (const size of phones) {
    await page.setViewportSize(size);
    for (const theme of ["light", "dark"]) {
      await page.emulateMedia({ colorScheme: theme });
      for (const name of ["Tasks", "Habits", "Sites", undefined]) {
        if (name) {
          await apps.click();
          await page.getByRole("dialog", { name: "Apps" }).getByRole("link", { name, exact: true }).click();
        } else {
          await bar.getByRole("link", { name: "Home", exact: true }).click();
        }
        await checkSuiteNavigation(page, name);
        const enlarged = await page.addStyleTag({ content: ":root { font-size: 200% }" });
        try { await checkSuiteNavigation(page, name); }
        finally { await enlarged.evaluate(el => el.remove()); }
      }
    }
  }
}
