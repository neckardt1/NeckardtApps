import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { cardSQL } from "../../../.agents/skills/add-cards/add-cards.mjs";

test("approved batches are atomic, owner-scoped and replayable against the migrated schema", async () => {
  const db = new PGlite();
  try {
    await db.exec(`create role anon; create role authenticated; create role service_role;
      create role supabase_auth_admin; create schema auth; create table auth.users(id uuid primary key);
      create function auth.uid() returns uuid stable language sql as $$select null::uuid$$;
      grant usage on schema auth to anon, authenticated, service_role;`);
    const dir = new URL("../supabase/migrations/", import.meta.url);
    for (const name of (await readdir(dir)).filter(n => n.endsWith(".sql")).sort())
      await db.exec(await readFile(new URL(name, dir), "utf8"));
    const owner = randomUUID(), other = randomUUID();
    await db.query("insert into auth.users values ($1),($2)", [owner, other]);
    await db.query("insert into flashcards_private.app_owner values ($1),($2)", [owner, other]);
    const card = front => ({ id: randomUUID(), front, back: "It's **this**.\n\n[Link](https://example.org/)" });
    const fact = { kind: "fact", card: card("Fact?") };
    const habit = { kind: "habit", cue: card("Evening cue?"), action: card("Did I do it?") };
    const batch = { owner_id: owner, items: [fact, habit] };
    const write = b => db.exec(cardSQL("insert", b));
    const read = async b => (await db.query(cardSQL("verify", b))).rows;
    await write(batch);
    const saved = await read(batch);
    assert.equal(saved.length, 3);
    for (const [expected, kind, cue] of [[fact.card, "fact", null], [habit.cue, "habit-recall", null],
      [habit.action, "habit-action", habit.cue.id]]) {
      const row = saved.find(r => r.id === expected.id);
      assert.deepEqual([row.owner_id, row.front, row.back, row.kind, row.cue_card_id, row.active],
        [owner, expected.front, expected.back, kind, cue, true]);
      assert.ok(row.due_at);
    }
    await db.query("update flashcards_private.cards set revision=3, due_at='2040-01-01' where id=$1", [fact.card.id]);
    const before = await read(batch);
    await write(batch);
    assert.deepEqual(await read(batch), before);
    const fresh = { kind: "fact", card: card("New?") };
    await assert.rejects(write({ owner_id: owner, items: [fresh, { ...fact, card: { ...fact.card, back: "Changed" } }] }),
      /conflicts/);
    assert.deepEqual(await read({ owner_id: owner, items: [fresh] }), []);
    await assert.rejects(write({ ...batch, owner_id: other }), /conflicts/);
    assert.deepEqual(await read({ ...batch, owner_id: other }), []);
    assert.throws(() => cardSQL("insert", { ...batch, items: [{ kind: "habit", cue: habit.cue }] }));
    assert.throws(() => cardSQL("insert", { ...batch, items: [fact, fact] }), /Repeated/);
  } finally {
    await db.close();
  }
});
