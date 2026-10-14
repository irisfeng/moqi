import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { createServer } from "vite";
import type { CoreContext } from "../src/core-bridge.ts";

test("project scope combines ownership, search, refresh and account reset", async () => {
  const dom = new JSDOM('<!doctype html><div id="app"></div><main id="main"></main>', {
    url: "http://localhost/web-ui/?view=contexts",
  });
  Object.defineProperty(dom.window, "matchMedia", {
    value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  });
  Object.defineProperty(dom.window.HTMLDialogElement.prototype, "showModal", {
    value(this: HTMLDialogElement) {
      this.open = true;
    },
  });
  const globals = {
    window: dom.window,
    document: dom.window.document,
    location: dom.window.location,
    history: dom.window.history,
    localStorage: dom.window.localStorage,
    navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement,
    HTMLDialogElement: dom.window.HTMLDialogElement,
    customElements: dom.window.customElements,
    Node: dom.window.Node,
    Event: dom.window.Event,
    MouseEvent: dom.window.MouseEvent,
    SubmitEvent: dom.window.SubmitEvent,
    InputEvent: dom.window.InputEvent,
    requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(Date.now()), 0),
    cancelAnimationFrame: clearTimeout,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
  };
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });

  const project = (id: string, name: string, ownerId: string): CoreContext => ({
    scopeId: `project:${id}`,
    kind: "group",
    name,
    sessionCount: 0,
    lastActivityAt: null,
    project: { id, name, ownerId, memberIds: ["owner", "colleague"], members: [], scopeId: `project:${id}` },
  });
  let rows: CoreContext[] = [
    project("mine", "Launch mine", "owner"),
    project("joined", "Launch joined", "colleague"),
    { scopeId: "personal:owner", kind: "personal", name: "Personal", sessionCount: 0, lastActivityAt: null },
    { scopeId: "slack:channel", kind: "channel", name: "Channel", sessionCount: 1, lastActivityAt: null },
  ];
  globalThis.fetch = async (input) => {
    if (String(input) === "/api/contexts") return Response.json({ contexts: rows });
    if (String(input) === "/api/sessions") return Response.json({ sessions: [] });
    throw new Error(`Unexpected request: ${input}`);
  };
  const vite = await createServer({ server: { middlewareMode: true, hmr: false }, appType: "custom" });
  try {
    const { appState } = await vite.ssrLoadModule("/src/shell-state.ts");
    const { renderContexts, resetContextsState } = await vite.ssrLoadModule("/src/contexts.ts");
    appState.me = { user: "owner", org: "acme" };
    appState.currentView = "contexts";
    appState.mainEl = document.querySelector("#main");
    const titles = () => Array.from(document.querySelectorAll(".context-row-title"), (el) => el.textContent?.trim());
    const select = (value: string) => {
      const control = document.querySelector<HTMLSelectElement>('select[aria-label="Project scope"]')!;
      control.focus();
      control.value = value;
      control.dispatchEvent(new Event("change", { bubbles: true }));
    };
    const search = (value: string) => {
      const control = document.querySelector<HTMLInputElement>('input[aria-label="Search projects"]')!;
      control.value = value;
      control.dispatchEvent(new InputEvent("input", { bubbles: true }));
    };
    await renderContexts();
    assert.ok(titles().includes("Launch mine"));
    assert.ok(titles().includes("Launch joined"));
    select("mine");
    assert.deepEqual(titles(), ["Launch mine"]);
    assert.equal(document.querySelector<HTMLSelectElement>('select[aria-label="Project scope"]')!.value, "mine");
    assert.equal(document.activeElement?.getAttribute("aria-label"), "Project scope");
    search("joined");
    assert.deepEqual(titles(), []);
    assert.match(document.querySelector(".project-empty")!.textContent!, /No projects match/);
    search("Launch");
    assert.deepEqual(titles(), ["Launch mine"]);
    rows = [...rows, project("new", "Launch new", "owner")];
    await renderContexts();
    assert.deepEqual(titles().sort(), ["Launch mine", "Launch new"]);
    select("all");
    assert.deepEqual(titles().sort(), ["Launch joined", "Launch mine", "Launch new"]);
    search("");
    select("mine");
    appState.me = null;
    await renderContexts();
    assert.deepEqual(titles(), []);
    resetContextsState();
    appState.me = { user: "colleague", org: "acme" };
    await renderContexts();
    assert.equal(document.querySelector<HTMLSelectElement>('select[aria-label="Project scope"]')!.value, "all");
    select("mine");
    assert.deepEqual(titles(), ["Launch joined"]);
  } finally {
    await vite.close();
    dom.window.close();
  }
});
