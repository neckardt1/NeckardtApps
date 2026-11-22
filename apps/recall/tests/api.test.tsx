import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ rpc: vi.fn(), invoke: vi.fn() }));
vi.mock("@supabase/supabase-js", () => ({ createClient: () => ({
  rpc: mocks.rpc, functions: { invoke: mocks.invoke }, auth: {}
}) }));
import { makeRecallApi, type ActionEvent } from "../src/recall-api.ts";
import type { ReviewEvent } from "../src/review-session.ts";
const api = makeRecallApi({ url: "https://fixture.supabase.co", publishableKey: "fixture" });
const event: ReviewEvent = { review_id: "review", card_id: "card", revision: 2, grade: "medium", reviewed_at: "2026-11-22T00:00:00.000Z" };
const saved = { review_id: "review", card_id: "card", revision: 3, due_at: "2026-11-22T00:10:00.000Z" };
const action: ActionEvent = { action_id: "action", opportunity_id: "occasion", card_id: "card", revision: 0, outcome: "no_opportunity", answered_at: "2026-11-22T00:00:00.000Z" };
beforeEach(() => { vi.clearAllMocks(); });

describe("verified review saves", () => {
  it("accepts an exact committed or replayed receipt", async () => {
    mocks.invoke.mockResolvedValue({ data: saved, error: null });
    await expect(api.grade(event)).resolves.toBeUndefined();
    expect(mocks.invoke).toHaveBeenCalledWith("recall-grade", { body: event });
  });
  it.each([null, {}, { ...saved, review_id: "other" }, { ...saved, card_id: "other" },
    { ...saved, revision: 2 }, { ...saved, due_at: "invalid" }, { ...saved, due_at: event.reviewed_at }])
  ("keeps an unverified HTTP success retryable", async data => {
    mocks.invoke.mockResolvedValue({ data, error: null });
    await expect(api.grade(event)).rejects.toMatchObject({ status: undefined });
  });
  it("preserves server conflict status", async () => {
    mocks.invoke.mockResolvedValue({ data: null, error: { context: new Response("", { status: 409 }) } });
    await expect(api.grade(event)).rejects.toMatchObject({ status: 409 });
  });
});

describe("safe optional opportunities and required recall API", () => {
  it("never falls back to the legacy mixed-card RPC", async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: { code: "PGRST202" } });
    await expect(api.due()).rejects.toThrow("Habit Practice needs its database update before reviews can begin.");
    expect(mocks.rpc).toHaveBeenCalledExactlyOnceWith("recall_due", { p_limit: 100 });
  });
  it("permits an absent optional opportunity capability", async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: { code: "PGRST202" } });
    await expect(api.opportunities!()).resolves.toEqual([]);
  });
  it("does not hide opportunity authorization or server failures", async () => {
    for (const code of ["42501", "50000"]) {
      mocks.rpc.mockResolvedValue({ data: null, error: { code } });
      await expect(api.opportunities!()).rejects.toThrow("Unable to load");
    }
  });
  it("rejects duplicate due cards and malformed opportunities", async () => {
    const card = { card_id: "card", revision: 0, front: "Synthetic question", back: "Synthetic answer" };
    mocks.rpc.mockResolvedValue({ data: [card, card], error: null });
    await expect(api.due()).rejects.toThrow("Invalid due-card");
    mocks.rpc.mockResolvedValue({ data: [{ ...action, prompt: "", cue: null }], error: null });
    await expect(api.opportunities!()).rejects.toThrow("Invalid opportunity");
  });
});

describe("verified action saves", () => {
  it("accepts the exact response with equivalent PostgreSQL timestamp formatting", async () => {
    mocks.rpc.mockResolvedValue({ data: { ...action, answered_at: "2026-11-22T00:00:00+00:00" }, error: null });
    await expect(api.action!(action)).resolves.toBeUndefined();
    expect(mocks.rpc).toHaveBeenCalledWith("recall_record_action", {
      p_action_id: action.action_id, p_opportunity_id: action.opportunity_id, p_card_id: action.card_id,
      p_revision: action.revision, p_outcome: action.outcome, p_answered_at: action.answered_at
    });
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
  it.each([null, {}, { ...action, action_id: "other" }, { ...action, opportunity_id: "other" },
    { ...action, card_id: "other" }, { ...action, revision: 1 }, { ...action, outcome: "yes" },
    { ...action, answered_at: "invalid" }])("rejects an unrelated or malformed receipt", async data => {
    mocks.rpc.mockResolvedValue({ data, error: null });
    await expect(api.action!(action)).rejects.toMatchObject({ status: undefined });
  });
});
