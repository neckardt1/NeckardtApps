import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

// Use pg_catalog directly so missing privileges cannot hide a table from discovery.
const inventory = `select n.nspname::text as schema, c.relname::text as name,
    c.relkind::text as kind,
    has_schema_privilege(n.oid, 'USAGE') and has_table_privilege(c.oid, 'SELECT')
      and not row_security_active(c.oid) as readable
  from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace
  where n.nspname !~ '^pg_' and n.nspname <> 'information_schema'
    and c.relkind in ('r', 'p', 'f')`;

export const inventorySQL = `select * from (${inventory}) i order by schema collate "C", name collate "C";`;

function validate(tables) {
  if (!Array.isArray(tables) || !tables.length) throw new Error("Empty table inventory");
  const keys = new Set();
  for (const { schema, name, kind, readable } of tables) {
    if (typeof schema !== "string" || !schema || typeof name !== "string" || !name ||
        !["r", "p"].includes(kind) || readable !== true)
      throw new Error("Unsupported or restricted table in inventory");
    const key = JSON.stringify([schema, name]);
    if (keys.has(key)) throw new Error("Duplicate table");
    keys.add(key);
  }
}

const ident = value => '"' + value.replaceAll('"', '""') + '"';

export function snapshotSQL(commit, tables) {
  if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error("Expected deployed commit SHA");
  validate(tables);
  const reads = tables.map(({ schema, name }, index) =>
    `select ${index} as i, coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) as rows
       from only ${ident(schema)}.${ident(name)} t`);
  // Encode catalog names as data, independently of SQL string settings.
  const encoded = Buffer.from(JSON.stringify(tables)).toString("hex");
  return `with expected as (select convert_from(decode('${encoded}', 'hex'), 'UTF8')::jsonb as tables),
    actual as (select jsonb_agg(to_jsonb(i) order by schema collate "C", name collate "C") as tables
      from (${inventory}) i),
    captures as (${reads.join("\nunion all\n")}),
    snapshot as (select jsonb_build_object('format', 'neckardtapps-db-rows-v2', 'commit', '${commit}',
      'captured', to_char(statement_timestamp() at time zone 'UTC', 'YYYYMMDD"T"HH24MISS"Z"'),
      'tables', (select jsonb_agg((expected.tables->i) || jsonb_build_object('rows', rows) order by i)
        from captures))::text as payload
      from expected, actual where expected.tables = actual.tables)
    select payload, encode(sha256(convert_to(payload, 'UTF8')), 'hex') as sha256 from snapshot;`;
}

export function verify({ payload, sha256 }) {
  if (typeof payload !== "string" || createHash("sha256").update(payload).digest("hex") !== sha256)
    throw new Error("Incomplete snapshot or checksum mismatch");
  const data = JSON.parse(payload);
  if (data.format !== "neckardtapps-db-rows-v2" || !/^[0-9a-f]{40}$/.test(data.commit) ||
      !/^\d{8}T\d{6}Z$/.test(data.captured)) throw new Error("Invalid snapshot header");
  validate(data.tables);
  if (!data.tables.every(table => Array.isArray(table.rows))) throw new Error("Invalid table rows");
  return `neckardtapps-db-rows-v2-${data.captured}-${data.commit}.json`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [, , command, argument] = process.argv;
  if (command === "inventory") console.log(inventorySQL);
  else if (command === "sql") console.log(snapshotSQL(argument, JSON.parse(readFileSync(0, "utf8"))));
  else if (command === "save" && argument) {
    const row = JSON.parse(readFileSync(0, "utf8"));
    const path = join(argument, verify(row));
    // Persist PostgreSQL's original text to retain full numeric precision.
    writeFileSync(path, row.payload, { flag: "wx", mode: 0o600 });
    console.log(path, row.sha256);
  } else throw new Error("Use inventory, sql <deployed-sha>, or save <private-directory>");
}
