import assert from "node:assert/strict";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { inventorySQL, snapshotSQL, verify } from "../../../.agents/skills/backup/snapshot.mjs";

test("discovers new schemas, detects drift and recovers partition rows exactly once", async () => {
  const db = new PGlite();
  try {
    await db.exec("create table public.cards (id bigint)");
    const inventory = async () => (await db.query(inventorySQL)).rows;
    const capture = async tables => (await db.query(snapshotSQL("a".repeat(40), tables))).rows;
    const before = await inventory();
    await db.exec(`create schema "new's";
      create table "new's".cards (id bigint) partition by range (id);
      create table "new's"."part""1" partition of "new's".cards default;
      insert into "new's".cards values (9223372036854775807)`);
    assert.deepEqual(await capture(before), []);
    const catalog = await inventory();
    for (const change of [{ readable: false }, { kind: "f" }])
      assert.throws(() => snapshotSQL("a".repeat(40), [{ ...catalog[0], ...change }]), /restricted/);
    const [row] = await capture(catalog);
    assert.match(verify(row), /^neckardtapps-db-rows-v2-/);
    assert.throws(() => verify({ ...row, payload: row.payload.slice(1) }), /checksum/);
    const tables = JSON.parse(row.payload).tables;
    assert.equal(tables.filter(t => t.name === "cards").length, 2);
    assert.equal(tables.flatMap(t => t.rows).length, 1);
    await db.exec("create temp table recovered (id bigint)");
    await db.query(`insert into recovered select r.* from jsonb_array_elements($1::jsonb->'tables') t
      cross join lateral jsonb_populate_recordset(null::recovered, t->'rows') r
      where t->>'schema' = $2 and t->>'name' = $3`, [row.payload, "new's", 'part"1']);
    const { rows } = await db.query(`(table recovered except all table "new's".cards)
      union all (table "new's".cards except all table recovered)`);
    assert.deepEqual(rows, []);
  } finally {
    await db.close();
  }
});
