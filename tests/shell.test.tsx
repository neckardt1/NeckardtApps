import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { SiteRoot } from "../shared/SiteRoot.tsx";
import { Launcher } from "../src/Launcher.tsx";
import { apps, type AppsHref } from "../shared/apps.ts";
import type { SessionApi, SessionUser } from "../shared/session.tsx";

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
async function mount(api: SessionApi | null, appsHref: AppsHref = "./") {
  await act(async () => root.render(<SiteRoot api={api} appsHref={appsHref}><Launcher appsHref={appsHref} /></SiteRoot>));
}
function button(name: string) {
  const result = [...target.querySelectorAll("button")].find(element => element.textContent === name);
  expect(result, `button ${name}`).toBeDefined();
  return result!;
}
async function tap(name: string) { await act(async () => button(name).click()); }
async function escape() {
  const event = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
  await act(async () => document.activeElement?.dispatchEvent(event));
  expect(event.defaultPrevented).toBe(true);
}
function assertPublicLauncher() {
  expect(target.querySelector("h1")?.textContent).toBe("Your apps");
  expect(target.querySelector(".app-name")?.textContent).toBe("Habit Practice");
  expect(target.querySelector(".app-status")?.textContent).toBe("Open");
  expect(target.querySelector(".app-card")?.getAttribute("href")).toBe("./recall/");
}

test("the launcher remains public while account loading, signed out, failed, or unavailable", async () => {
  const controller = session();
  await mount(controller.api);
  assertPublicLauncher();
  expect(target.querySelector("form")).toBeNull();
  await tap("Account");
  expect(target.textContent).toContain("Checking your session");
  assertPublicLauncher();
  await act(async () => controller.emit(null));
  expect(target.querySelector("form")).not.toBeNull();
  assertPublicLauncher();
  await act(async () => controller.fail(new Error("Synthetic session failure")));
  expect(target.textContent).toContain("You can still open apps.");
  assertPublicLauncher();
  expect(controller.api.signIn).not.toHaveBeenCalled();
  expect(controller.api.signOut).not.toHaveBeenCalled();
  await mount(null);
  assertPublicLauncher();
});

test("Apps and Account manage focus, Escape, switching, outside clicks, and focus leaving", async () => {
  await mount(session(null).api);
  const header = target.querySelector("header")!;
  expect([...header.querySelectorAll(":scope > div > button")].map(element => element.textContent)).toEqual(["Apps", "Account"]);
  expect(header.querySelector("h1")).toBeNull();
  await tap("Apps");
  expect(button("Apps").getAttribute("aria-expanded")).toBe("true");
  expect(document.activeElement?.textContent).toBe("All apps");
  expect(target.querySelectorAll('[role="dialog"]')).toHaveLength(1);
  await escape();
  expect(document.activeElement).toBe(button("Apps"));
  expect(target.querySelector("[data-popover-open]")).toBeNull();

  await tap("Account");
  expect(document.activeElement).toBe(target.querySelector('input[name="email"]'));
  await escape();
  expect(document.activeElement).toBe(button("Account"));
  await tap("Apps"); await tap("Account");
  expect(target.querySelectorAll('[role="dialog"]')).toHaveLength(1);
  expect(button("Apps").getAttribute("aria-expanded")).toBe("false");
  await act(async () => target.querySelector("h1")!.dispatchEvent(new Event("pointerdown", { bubbles: true })));
  expect(target.querySelector("[data-popover-open]")).toBeNull();
  await tap("Apps");
  await act(async () => target.querySelector<HTMLElement>("main")!.focus());
  expect(target.querySelector("[data-popover-open]")).toBeNull();
  expect(document.activeElement).toBe(target.querySelector("main"));
});

test("optional Account sign-in and sign-out close only after authoritative session changes", async () => {
  const controller = session(null);
  await mount(controller.api);
  await tap("Account");
  const form = target.querySelector("form")!;
  const email = form.querySelector<HTMLInputElement>('[name="email"]')!;
  const password = form.querySelector<HTMLInputElement>('[name="password"]')!;
  email.value = "fixture@example.invalid";
  password.value = "synthetic-password";
  await act(async () => form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  expect(controller.api.signIn).toHaveBeenCalledExactlyOnceWith("fixture@example.invalid", "synthetic-password");
  expect(password.value).toBe("");
  expect(target.querySelector("form")).not.toBeNull();
  assertPublicLauncher();
  await act(async () => controller.emit({ id: "synthetic-user" }));
  expect(target.querySelector("[data-popover-open]")).toBeNull();
  expect(document.activeElement).toBe(button("Account"));
  await tap("Account"); await tap("Sign out");
  expect(controller.api.signOut).toHaveBeenCalledTimes(1);
  expect(target.textContent).toContain("Signed in");
  await act(async () => controller.emit(null));
  expect(target.querySelector("[data-popover-open]")).toBeNull();
  expect(document.activeElement).toBe(button("Account"));
  assertPublicLauncher();
});

test("sign-in failure stays inside Account and never blocks the launcher", async () => {
  const controller = session(null);
  vi.mocked(controller.api.signIn).mockRejectedValue(new Error("Synthetic credentials rejected"));
  await mount(controller.api);
  await tap("Account");
  const form = target.querySelector("form")!;
  form.querySelector<HTMLInputElement>('[name="email"]')!.value = "fixture@example.invalid";
  form.querySelector<HTMLInputElement>('[name="password"]')!.value = "synthetic-password";
  await act(async () => form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  expect(target.querySelector('[role="alert"]')?.textContent).toBeTruthy();
  expect(target.querySelector("form")).not.toBeNull();
  expect(target.textContent).not.toContain("Synthetic credentials rejected");
  expect(target.textContent).not.toMatch(/sign up|create account/i);
  assertPublicLauncher();
});

test("the shared registry and explicit relative app base support both ordinary page depths", async () => {
  expect(apps).toEqual([{ id: "recall", name: "Habit Practice", path: "recall/", description: "A little practice, every day." }]);
  for (const appsHref of ["./", "../"] as const) {
    await mount(null, appsHref);
    await tap("Apps");
    const all = target.querySelector<HTMLAnchorElement>(".popover-link")!;
    const item = target.querySelector<HTMLAnchorElement>(".app-menu-link")!;
    for (const prefix of ["/", "/NeckardtApps/"]) {
      const location = `https://example.invalid${prefix}${appsHref === "../" ? "future/" : ""}index.html`;
      expect(new URL(all.getAttribute("href")!, location).pathname).toBe(prefix);
      expect(new URL(item.getAttribute("href")!, location).pathname).toBe(prefix + "recall/");
    }
    await escape();
  }
});
