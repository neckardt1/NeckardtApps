import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { SiteRoot } from "../src/shell/SiteRoot.tsx";
import { MemoryRouter } from "react-router";
import type { SessionApi, SessionUser } from "../src/shell/session.tsx";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let target: HTMLDivElement;
let root: Root;
let network: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  target = document.createElement("div");
  document.body.append(target);
  root = createRoot(target);
  network = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Network forbidden in shell UI tests"));
});
afterEach(async () => {
  await act(async () => root.unmount());
  target.remove();
  expect(network).not.toHaveBeenCalled();
  vi.restoreAllMocks();
});

function session(initial?: SessionUser | null) {
  let change: (user: SessionUser | null) => void = () => {};
  let failure: (error: unknown) => void = () => {};
  const api: SessionApi = {
    observe(next, error) { change = next; failure = error ?? (() => {}); if (initial !== undefined) next(initial); return () => {}; },
    signIn: vi.fn(async () => {}),
    signOut: vi.fn(async () => {})
  };
  return { api, emit: (user: SessionUser | null) => change(user), fail: (error: unknown) => failure(error) };
}
async function mount(api: SessionApi | null, base = "/") {
  await act(async () => root.render(<MemoryRouter key={base} basename={base} initialEntries={[base]}>
    <SiteRoot api={api} practice={null} />
  </MemoryRouter>));
}
function button(name: string) {
  const result = [...target.querySelectorAll("button")].find(element => element.textContent === name);
  expect(result, `button ${name}`).toBeDefined();
  return result!;
}
async function tap(name: string) { await act(async () => button(name).click()); }
async function navigate(name: string) {
  const link = [...target.querySelectorAll("a")].find(el => el.textContent === name);
  expect(link, name).toBeDefined();
  await act(async () => link!.click());
}
async function escape() {
  const event = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
  await act(async () => document.activeElement?.dispatchEvent(event));
  expect(event.defaultPrevented).toBe(true);
}
function assertPublicLauncher() {
  expect(target.querySelector("h1")?.textContent).toBe("All apps");
  expect(target.querySelector(".app-name")?.textContent).toBe("Habit Practice");
  expect(target.querySelector(".app-status")?.textContent).toBe("Open");
  expect(target.querySelector(".app-card")?.getAttribute("href")).toBe("/recall/");
}

test("the launcher remains public while account loading, signed out, failed, or unavailable", async () => {
  const controller = session();
  await mount(controller.api);
  await navigate("All apps");
  assertPublicLauncher();
  expect(target.querySelector("form")).toBeNull();
  await navigate("Account");
  expect(target.textContent).toContain("Checking your session");
  expect(target.querySelector("h1")?.textContent).toBe("Profile");
  await act(async () => controller.emit(null));
  expect(target.querySelector("form")).not.toBeNull();
  await navigate("Home");
  await navigate("All apps");
  assertPublicLauncher();
  await act(async () => controller.fail(new Error("Synthetic session failure")));
  assertPublicLauncher();
  await navigate("Account");
  expect(target.textContent).toContain("You can still open apps.");
  expect(controller.api.signIn).not.toHaveBeenCalled();
  expect(controller.api.signOut).not.toHaveBeenCalled();
  await mount(null);
  await navigate("Home");
  await navigate("All apps");
  assertPublicLauncher();
});

test("Apps manages focus and dismissal when navigating to Profile or interacting outside", async () => {
  await mount(session(null).api);
  const header = target.querySelector("header")!;
  expect([...header.querySelectorAll(":scope > div > button")].map(element => element.textContent)).toEqual(["Apps"]);
  expect(header.querySelector("h1")).toBeNull();
  await tap("Apps");
  expect(button("Apps").getAttribute("aria-expanded")).toBe("true");
  expect(document.activeElement?.textContent).toBe("Habit Practice");
  expect(target.querySelectorAll('[role="dialog"]')).toHaveLength(1);
  await escape();
  expect(document.activeElement).toBe(button("Apps"));
  expect(target.querySelector("[data-popover-open]")).toBeNull();

  await tap("Apps"); await navigate("Account");
  expect(target.querySelector("h1")?.textContent).toBe("Profile");
  expect(document.activeElement).toBe(target.querySelector("main"));
  expect(target.querySelector(".account-link")?.getAttribute("aria-current")).toBe("page");
  expect(target.querySelector('[role="dialog"]')).toBeNull();
  expect(button("Apps").getAttribute("aria-expanded")).toBe("false");
  await tap("Apps");
  await act(async () => target.querySelector("h1")!.dispatchEvent(new Event("pointerdown", { bubbles: true })));
  expect(target.querySelector("[data-popover-open]")).toBeNull();
  await tap("Apps");
  await act(async () => target.querySelector<HTMLElement>("main")!.focus());
  expect(target.querySelector("[data-popover-open]")).toBeNull();
  expect(document.activeElement).toBe(target.querySelector("main"));
});

test("Profile updates sign-in and sign-out controls only after authoritative session changes", async () => {
  const controller = session(null);
  await mount(controller.api);
  await navigate("Account");
  const form = target.querySelector("form")!;
  const email = form.querySelector<HTMLInputElement>('[name="email"]')!;
  const password = form.querySelector<HTMLInputElement>('[name="password"]')!;
  email.value = "fixture@example.invalid";
  password.value = "synthetic-password";
  await act(async () => form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  expect(controller.api.signIn).toHaveBeenCalledExactlyOnceWith("fixture@example.invalid", "synthetic-password");
  expect(password.value).toBe("");
  expect(target.querySelector("form")).not.toBeNull();
  expect(target.textContent).not.toContain("Manage connections");
  await act(async () => controller.emit({ id: "synthetic-user" }));
  expect(target.querySelector('a[href="/oauth/consent/?manage"]')?.textContent).toBe("Manage connections");
  await tap("Sign out");
  expect(controller.api.signOut).toHaveBeenCalledTimes(1);
  expect(target.textContent).toContain("Signed in");
  await act(async () => controller.emit(null));
  expect(target.querySelector("[data-popover-open]")).toBeNull();
  expect(target.textContent).not.toContain("Manage connections");
  expect(target.querySelector("form")).not.toBeNull();
  await navigate("Home");
  await navigate("All apps");
  assertPublicLauncher();
});

test("sign-in failure stays inside Account and never blocks the launcher", async () => {
  const controller = session(null);
  vi.mocked(controller.api.signIn).mockRejectedValue(new Error("Synthetic credentials rejected"));
  await mount(controller.api);
  await navigate("Account");
  const form = target.querySelector("form")!;
  form.querySelector<HTMLInputElement>('[name="email"]')!.value = "fixture@example.invalid";
  form.querySelector<HTMLInputElement>('[name="password"]')!.value = "synthetic-password";
  await act(async () => form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  expect(target.querySelector('[role="alert"]')?.textContent).toBeTruthy();
  expect(target.querySelector("form")).not.toBeNull();
  expect(target.textContent).not.toContain("Synthetic credentials rejected");
  expect(target.textContent).not.toMatch(/sign up|create account/i);
  await navigate("Home");
  await navigate("All apps");
  assertPublicLauncher();
});

test.each(["/", "/NeckardtApps/"])("the Apps menu links stay inside the site at %s", async base => {
  await mount(null, base);
  await tap("Apps");
  const links = target.querySelectorAll<HTMLAnchorElement>('nav[aria-label="Apps"] a');
  expect([...links].map(link => [link.textContent, link.getAttribute("href")])).toEqual([
    ["Habit Practice", base + "recall/"], ["Private sites", base + "sites"],
    ["Tasks", base + "tasks/"], ["All apps", base + "apps/"]
  ]);
});

test("profile reads finishing after an account switch cannot replace the current header", async () => {
  const controller = session({ id: "first" });
  let finish!: (profile: {display_name: string; picture: null}) => void;
  controller.api.profiles = {
    load: id => id === "first" ? new Promise(resolve => { finish = resolve; })
      : Promise.resolve({ display_name: "Second", picture: null }),
    save: vi.fn()
  };
  await mount(controller.api);
  await act(async () => controller.emit({ id: "second" }));
  await act(async () => finish({ display_name: "First", picture: null }));
  expect(target.querySelector(".account-name")?.textContent).toBe("Second");
  await act(async () => controller.emit(null));
  expect(target.querySelector(".account-name")?.textContent).toBe("Account");
});
