import assert from "node:assert/strict";
import { test } from "node:test";
import { loadPublicBuildConfig } from "../build-config.ts";
import { hostedConfig, loadScenario } from "./hosted-worker.mjs";

test("the fixture key defaults to the checked-in project and binds explicitly to an alternate", () => {
  const shared = loadPublicBuildConfig({});
  const sharedRef = new URL(shared.url).hostname.split(".")[0];
  const settings = { NECKARDT_APPS_FIXTURE_KEY: "test-placeholder" };
  const expected = { config: shared, fixtureKey: "test-placeholder" };
  assert.deepEqual(hostedConfig(settings), expected);
  assert.deepEqual(hostedConfig({ ...settings, NECKARDT_APPS_FIXTURE_PROJECT_REF: sharedRef }), expected);
  assert.throws(() => hostedConfig({}), /NECKARDT_APPS_FIXTURE_KEY/);

  const otherRef = "a".repeat(20);
  const alternate = {
    NECKARDT_APPS_SUPABASE_URL: `https://${otherRef}.supabase.co`,
    NECKARDT_APPS_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_fixture"
  };
  assert.throws(() => hostedConfig({ ...settings, NECKARDT_APPS_SUPABASE_URL: alternate.NECKARDT_APPS_SUPABASE_URL }), /Set both/);
  assert.throws(() => hostedConfig({ ...settings, ...alternate }), /NECKARDT_APPS_FIXTURE_PROJECT_REF/);
  assert.throws(() => hostedConfig({ ...settings, ...alternate, NECKARDT_APPS_FIXTURE_PROJECT_REF: sharedRef }), /NECKARDT_APPS_FIXTURE_PROJECT_REF/);
  assert.equal(hostedConfig({ ...settings, ...alternate, NECKARDT_APPS_FIXTURE_PROJECT_REF: otherRef }).config.url,
    alternate.NECKARDT_APPS_SUPABASE_URL);
});

test("existing environments can migrate each settings pair without mixing projects or keys", () => {
  const oldRef = "a".repeat(20);
  const newRef = "b".repeat(20);
  const legacy = {
    RECALL_SUPABASE_URL: `https://${oldRef}.supabase.co`,
    RECALL_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_older",
    HABIT_FIXTURE_PROJECT_REF: oldRef,
    HABIT_FIXTURE_KEY: "old-placeholder"
  };
  const current = {
    NECKARDT_APPS_SUPABASE_URL: `https://${newRef}.supabase.co`,
    NECKARDT_APPS_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_current",
    NECKARDT_APPS_FIXTURE_PROJECT_REF: newRef,
    NECKARDT_APPS_FIXTURE_KEY: "new-placeholder"
  };
  assert.deepEqual(hostedConfig(legacy), {
    config: { url: legacy.RECALL_SUPABASE_URL, publishableKey: legacy.RECALL_SUPABASE_PUBLISHABLE_KEY },
    fixtureKey: legacy.HABIT_FIXTURE_KEY
  });
  assert.deepEqual(hostedConfig({ ...legacy, ...current }), {
    config: { url: current.NECKARDT_APPS_SUPABASE_URL, publishableKey: current.NECKARDT_APPS_SUPABASE_PUBLISHABLE_KEY },
    fixtureKey: current.NECKARDT_APPS_FIXTURE_KEY
  });
  assert.throws(() => hostedConfig({ ...legacy, NECKARDT_APPS_SUPABASE_URL: current.NECKARDT_APPS_SUPABASE_URL }), /Set both/);
  assert.throws(() => hostedConfig({ ...legacy, NECKARDT_APPS_FIXTURE_PROJECT_REF: oldRef }), /NECKARDT_APPS_FIXTURE_KEY/);
  assert.throws(() => hostedConfig({ ...legacy, NECKARDT_APPS_FIXTURE_KEY: "new-placeholder" }), /NECKARDT_APPS_FIXTURE_PROJECT_REF/);
});

test("select a named hosted check without falling back to smoke on a typo", async () => {
  const example = await import("./hosted-scenarios/reveal-answer.mjs");
  assert.equal(await loadScenario("reveal-answer"), example.default);
  await assert.rejects(loadScenario("missing-check"), /Unknown hosted scenario.*reveal-answer/);
});
