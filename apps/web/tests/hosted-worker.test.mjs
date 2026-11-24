import assert from "node:assert/strict";
import { test } from "node:test";
import { loadPublicBuildConfig } from "../build-config.ts";
import { hostedConfig } from "./hosted-worker.mjs";

test("hosted workers use the app's public config and require an explicitly matching target", () => {
  const shared = loadPublicBuildConfig({});
  const sharedRef = new URL(shared.url).hostname.split(".")[0];
  const settings = { HABIT_FIXTURE_PROJECT_REF: sharedRef, HABIT_FIXTURE_KEY: "test-placeholder" };
  assert.deepEqual(hostedConfig(settings), shared);
  assert.throws(() => hostedConfig({ HABIT_FIXTURE_PROJECT_REF: sharedRef }), /HABIT_FIXTURE_KEY/);
  assert.throws(() => hostedConfig({ HABIT_FIXTURE_KEY: "test-placeholder" }), /HABIT_FIXTURE_PROJECT_REF/);

  const otherRef = "a".repeat(20);
  const alternate = {
    RECALL_SUPABASE_URL: `https://${otherRef}.supabase.co`,
    RECALL_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_fixture"
  };
  assert.throws(() => hostedConfig({ ...settings, RECALL_SUPABASE_URL: alternate.RECALL_SUPABASE_URL }), /Set both/);
  assert.throws(() => hostedConfig({ ...settings, ...alternate }), /HABIT_FIXTURE_PROJECT_REF/);
  assert.equal(hostedConfig({ ...settings, ...alternate, HABIT_FIXTURE_PROJECT_REF: otherRef }).url,
    alternate.RECALL_SUPABASE_URL);
});
