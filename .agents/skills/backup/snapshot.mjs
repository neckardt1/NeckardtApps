import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export const tables = [
  "action_opportunities", "action_responses", "app_owner", "cards", "notion_imports",
  "practice_rounds", "reviews", "round_completions", "round_items"
];

export function snapshotSQL(commit) {
  if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error("Expected deployed commit SHA");
  const entries = tables.map(name =>
    `'${name}', (select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) from flashcards_private.${name} t)`
  );
  return `with snapshot as (select jsonb_build_object(
    'format', 'neckardtapps-habit-v1', 'commit', '${commit}',
    'captured', to_char(statement_timestamp() at time zone 'UTC', 'YYYYMMDD"T"HH24MISS"Z"'),
    'inventory', (select array_agg(c.relname order by c.relname)
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'flashcards_private' and c.relkind in ('r', 'p')),
    'tables', jsonb_build_object(${entries.join(",\n")})
  )::text as payload)
  select payload, encode(sha256(convert_to(payload, 'UTF8')), 'hex') as sha256 from snapshot;`;
}

// Keep the original PostgreSQL JSON text. Re-serializing through JS could round large numbers.
export function verify({ payload, sha256 }) {
  if (typeof payload !== "string" || createHash("sha256").update(payload).digest("hex") !== sha256)
    throw new Error("Incomplete snapshot or checksum mismatch");
  const data = JSON.parse(payload);
  if (data.format !== "neckardtapps-habit-v1" || !/^[0-9a-f]{40}$/.test(data.commit) ||
      !/^\d{8}T\d{6}Z$/.test(data.captured)) throw new Error("Invalid snapshot header");
  if (JSON.stringify(data.inventory) !== JSON.stringify(tables) ||
      JSON.stringify(Object.keys(data.tables).sort()) !== JSON.stringify(tables) ||
      !tables.every(name => Array.isArray(data.tables[name])))
    throw new Error("Table inventory changed; review the backup scope");
  return `neckardtapps-habit-v1-${data.captured}-${data.commit}.json`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [, , command, argument] = process.argv;
  if (command === "sql") console.log(snapshotSQL(argument));
  else if (command === "save" && argument) {
    const row = JSON.parse(readFileSync(0, "utf8"));
    const path = join(argument, verify(row));
    writeFileSync(path, row.payload, { flag: "wx", mode: 0o600 });
    console.log(path, row.sha256);
  } else throw new Error("Use sql <deployed-sha> or save <private-directory> (one SQL result row on stdin)");
}
