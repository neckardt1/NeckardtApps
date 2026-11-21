import { StrictMode, act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { App } from "../src/App.tsx";
import { makeRecallApi, type RecallApi } from "../src/recall-api.ts";
import type { DueCard, ReviewEvent } from "../src/review-session.ts";
import { makeSiteClientGetter, readPublicSupabaseConfig } from "../../../shared/browser-auth.mts";

const mockSdk = vi.hoisted(() => ({
  auth: { signOut: vi.fn(async (_: { scope: string }) => ({ error: null })) },
  rpc: vi.fn(async (_name: string, _params: object) => ({ data: [], error: null })),
  functions: { invoke: vi.fn(async (_name: string, _payload: object) => ({ error: null })) }
}));
vi.mock("@supabase/supabase-js", () => ({ createClient: () => mockSdk }));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root;
let target: HTMLElement;
beforeEach(() => {
  localStorage.clear();
  target = document.createElement("div");
  document.body.append(target);
  root = createRoot(target);
});
afterEach(async () => {
  await act(async () => root.unmount());
  target.remove();
});

const origin = "https://abcdefghijklmnopqrst.supabase.co";
const cards = (): DueCard[] => ["A", "B", "C", "D", "E", "F"].map((value) => ({
  card_id: value, front: `Question ${value}`, back: `Answer ${value}`, revision: 0
}));
const button = (label: string) => [...target.querySelectorAll("button")].find((el) => el.textContent === label);
const tap = async (label: string) => {
  const el = button(label);
  expect(el, label).toBeDefined();
  await act(async () => el?.click());
};
const key = async (value: string) => {
  await act(async () => document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", { key: value, bubbles: true })));
};
const deferred = <T,>() => {
  let finish!: (value: T) => void;
  const promise = new Promise<T>(resolve => { finish = resolve; });
  return { promise, finish };
};

test("review reveals only the current answer, advances before acknowledgement, and retries the same rating", async () => {
  const hold = deferred<void>();
  const calls: ReviewEvent[] = [];
  const persisted = new Map<string, ReviewEvent>();
  let activeObservers = 0;
  const api: RecallApi = {
    origin,
    observeOwner(owner) { activeObservers++; owner("test-owner"); return () => { activeObservers--; }; },
    async signIn() { return "test-owner"; },
    async signOut() {},
    async due() { return cards(); },
    async grade(event) {
      calls.push(event);
      if (calls.length === 1) {
        await hold.promise;
        persisted.set(event.review_id, event);
        throw Error("connection dropped after the save");
      }
      if (!persisted.has(event.review_id)) persisted.set(event.review_id, event);
    }
  };
  await act(async () => root.render(<StrictMode><App api={api} /></StrictMode>));
  expect(activeObservers).toBe(1);
  expect(target.textContent).toContain("Card 1 of 5");
  expect(target.textContent).toContain("Question A");
  expect(target.textContent).not.toContain("Answer A");
  expect(button("Good")).toBeUndefined();
  await key("3");
  expect(calls).toHaveLength(0);
  await tap("Show answer");
  expect(target.textContent).toContain("Question A");
  expect(target.textContent).toContain("Answer A");
  expect([...target.querySelector("[aria-label='Rate your recall']")!.querySelectorAll("button")].map(el => el.textContent))
    .toEqual(["Again", "Hard", "Good", "Easy"]);
  expect(calls).toHaveLength(0);

  await tap("Good");
  expect(calls[0].grade).toBe("medium");
  expect(persisted.size).toBe(0); // The saver deliberately hasn't returned.
  expect(target.textContent).toContain("Saving 1…");
  expect(target.textContent).toContain("Question B");
  expect(target.textContent).not.toMatch(/Answer A|Answer B|Question C|Question F/);
  expect(button("Good")).toBeUndefined();
  expect(button("Show answer")).toBeDefined();
  expect(document.activeElement?.textContent).toBe("Question B");
  await act(async () => hold.finish());
  expect(target.textContent).toContain("1 need a retry");
  await tap("Retry save");
  expect(calls).toHaveLength(2);
  expect(calls[1]).toEqual(calls[0]);
  expect(persisted.size).toBe(1);
  expect(target.textContent).toContain("No unsaved ratings");
  await key(" ");
  expect(target.textContent).toContain("Answer B");
  await tap("Sign out");
  expect(target.textContent).toContain("Sign in to Recall");
  expect(target.textContent).not.toContain("Question B");
});

test("sign-out and owner changes do not display a stale due response or old card", async () => {
  let notifyOwner: (id: string | null) => void = () => {};
  const old = deferred<DueCard[]>();
  const newer = deferred<DueCard[]>();
  const first: DueCard = { card_id: "old", front: "Old owner's card", back: "Private answer", revision: 0 };
  let requested = 0;
  const api: RecallApi = {
    origin,
    observeOwner(callback) { notifyOwner = callback; callback("old-owner"); return () => {}; },
    async signIn() { return "old-owner"; },
    async signOut() {},
    async due() { return ++requested === 1 ? old.promise : newer.promise; },
    async grade() { throw Error("No grade expected"); }
  };
  await act(async () => root.render(<App api={api} />));
  await act(async () => old.finish([first]));
  expect(target.textContent).toContain(first.front);
  await act(async () => notifyOwner("another-owner"));
  expect(target.textContent).not.toContain(first.front);
  await tap("Sign out");
  await act(async () => newer.finish([{ ...first, front: "Second owner's stale card" }]));
  expect(target.textContent).toContain("Sign in to Recall");
  expect(target.textContent).not.toContain("Second owner's stale card");
});

test("future apps share the current browser-auth convention without widening permissions", () => {
  const calls: unknown[][] = [];
  const getter = makeSiteClientGetter((...args) => { calls.push(args); return {}; });
  const config = readPublicSupabaseConfig({ url: origin, publishableKey: "sb_publishable_fixture" });
  expect(config).not.toBeNull();
  expect(getter(config!)).toBe(getter(config!));
  expect(calls).toEqual([[origin, "sb_publishable_fixture", {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false }
  }]]);
  expect(readPublicSupabaseConfig({ url: origin, publishableKey: "server_fixture_not_allowed" })).toBeNull();
});


test("the Supabase adapter keeps the due/grade contract and signs out locally", async () => {
  const api = makeRecallApi({ url: origin, publishableKey: "sb_publishable_fixture" });
  const event: ReviewEvent = {
    review_id: "mock-review", card_id: "mock-card", grade: "miss", revision: 0, reviewed_at: "2026-01-01T00:00:00Z"
  };
  await api.due();
  await api.grade(event);
  await api.signOut();
  expect(mockSdk.rpc).toHaveBeenCalledWith("demo_flashcards_due", { p_limit: 5 });
  expect(mockSdk.functions.invoke).toHaveBeenCalledWith("recall-grade", { body: event });
  expect(mockSdk.auth.signOut).toHaveBeenCalledWith({ scope: "local" });
});
