import { prepareRound } from "../hosted-worker.mjs";

export async function checkNewCardIntervals(page) {
  await page.getByRole("button", { name: "Reveal answer" }).click();
  for (const [grade, interval] of Object.entries({ Again: "1 min", Hard: "6 min", Good: "10 min", Easy: "8 days" })) {
    await page.getByRole("button", { name: grade, exact: true }).getByText(interval, { exact: true }).waitFor();
  }
}

export default async function reviewIntervals(worker) {
  await prepareRound(worker);
  await checkNewCardIntervals(worker.page);
}
