import assert from "node:assert/strict";
import { test } from "node:test";
import { makeSiteClientGetter, readPublicSupabaseConfig } from "../src/shell/browser-auth.mts";

// Retained from the removed Recall UI suite: shared auth is still available
// for future apps, but neither offline HTML entry loads it.
test("future apps share the current browser-auth convention without widening permissions", () => {
  const origin = "https://abcdefghijklmnopqrst.supabase.co";
  const calls = [];
  const getter = makeSiteClientGetter((...args) => { calls.push(args); return {}; });
  const config = readPublicSupabaseConfig({ url: origin, publishableKey: "sb_publishable_fixture" });
  assert(config);
  assert.equal(getter(config), getter(config));
  assert.deepEqual(calls, [[origin, "sb_publishable_fixture", {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false }
  }]]);
  assert.equal(readPublicSupabaseConfig({ url: origin, publishableKey: "server_fixture_not_allowed" }), null);
});
