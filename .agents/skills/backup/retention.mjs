import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const day = 86_400_000;
const filename = /^neckardtapps-habit-v1-(\d{4})(\d\d)(\d\d)T(\d\d)(\d\d)(\d\d)Z-[a-f0-9]{40}\.json$/;

function captureTime(name) {
  const match = filename.exec(name);
  if (!match) return null;
  const [, y, m, d, h, min, sec] = match;
  const iso = `${y}-${m}-${d}T${h}:${min}:${sec}.000Z`;
  const time = Date.parse(iso);
  if (!Number.isFinite(time) || new Date(time).toISOString() !== iso)
    throw new Error("Invalid snapshot timestamp");
  return time;
}

// Input is a complete listing of one private backup folder. Only plan changes.
export function plan(files, freshId) {
  const snapshots = files.map(({ id, name }) => ({ id, time: captureTime(name) }))
    .filter(file => file.time !== null)
    .sort((a, b) => a.time - b.time || a.id.localeCompare(b.id));
  if (snapshots.some(file => typeof file.id !== "string" || !file.id) ||
      new Set(snapshots.map(file => file.id)).size !== snapshots.length)
    throw new Error("Invalid Drive IDs");
  const latest = snapshots.find(file => file.id === freshId);
  if (!latest || latest.time !== snapshots.at(-1).time)
    throw new Error("Expected the freshly verified newest backup");
  const keep = new Set([freshId]);
  // Keep the first capture in each aligned window while that tier is active.
  // Windows overlap across tiers so older anchors survive repeated pruning.
  for (const [width, horizon] of [[7,21], [14,42], [28,84], [84,168], [168,336], [336,672]]) {
    const current = Math.floor(latest.time / (width * day));
    const seen = new Set();
    for (const file of snapshots) {
      const bucket = Math.floor(file.time / (width * day));
      if (bucket < current - horizon / width || seen.has(bucket)) continue;
      seen.add(bucket);
      keep.add(file.id);
    }
  }
  // Keep one older fallback across long gaps in the schedule.
  const precedingYear = snapshots.filter(file => file.time <= latest.time - 365 * day).at(-1);
  if (precedingYear) keep.add(precedingYear.id);
  return { keep: [...keep], trash: snapshots.filter(file => !keep.has(file.id)).map(file => file.id) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  console.log(JSON.stringify(plan(JSON.parse(readFileSync(0, "utf8")), process.argv[2]), null, 2));
