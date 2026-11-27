import assert from "node:assert/strict";
import test from "node:test";
import { plan } from "../../../.agents/skills/backup/retention.mjs";

function snapshot(week) {
  const stamp = new Date(Date.UTC(2024, 0, 1 + week * 7)).toISOString().replace(/[-:]/g, "").replace(".000", "");
  return { id: String(week), name: `neckardtapps-db-rows-v2-${stamp}-${"a".repeat(40)}.json` };
}

test("three years of repeated pruning preserve young and old checkpoints despite missed runs", () => {
  let live = [];
  for (let week = 0; week <= 156; week++) {
    if (week % 21 === 4) continue;
    const fresh = snapshot(week);
    live.push(fresh);
    const result = plan([...live, { id: "other", name: fresh.name.replace("db-rows-v2", "habit-v1") }], fresh.id);
    assert.ok(!result.trash.includes("other"));
    live = live.filter(file => !result.trash.includes(file.id));
    assert.deepEqual(plan(live, fresh.id).trash, []);
    if (week >= 104) {
      const ages = live.map(file => week - Number(file.id));
      for (const [min, max] of [[0,0],[1,2],[2,4],[3,7],[7,23],[15,47],[52,100]])
        assert.ok(ages.some(age => age >= min && age <= max), String(ages));
      assert.ok(live.length <= 20);
    }
  }
  assert.throws(() => plan(live, live[0].id), /newest/);
});
