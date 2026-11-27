import assert from "node:assert/strict";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { snapshotSQL, tables, verify } from "../../../.agents/skills/backup/snapshot.mjs";

test("snapshot recovers typed rows with exact bigint and text in a disposable database", async () => {
  const db = new PGlite();
  try {
    await db.exec("create schema flashcards_private");
    for (const name of tables)
      await db.exec(`create table flashcards_private.${name}(id bigint primary key, note text)`);
    await db.query("insert into flashcards_private.cards values (9223372036854775807, $1)", ["quoted '\" ♥\ntext"]);
    const sql = snapshotSQL("a".repeat(40));
    const { rows: [row] } = await db.query(sql);
    assert.match(verify(row), /^neckardtapps-habit-v1-/);
    assert.throws(() => verify({ ...row, payload: row.payload.slice(1) }), /checksum/);
    await db.exec("create temp table recovered (like flashcards_private.cards including all)");
    await db.query(`insert into recovered select * from jsonb_populate_recordset(
      null::flashcards_private.cards, $1::jsonb->'tables'->'cards')`, [row.payload]);
    const result = await db.query(`(table recovered except all table flashcards_private.cards)
      union all (table flashcards_private.cards except all table recovered)`);
    assert.deepEqual(result.rows, []);
    await db.exec("create table flashcards_private.new_table (id int)");
    const drift = await db.query(sql);
    assert.throws(() => verify(drift.rows[0]), /inventory/);
  } finally {
    await db.close();
  }
});
