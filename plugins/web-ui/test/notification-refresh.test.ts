import assert from "node:assert/strict";
import { after, test } from "node:test";
import { JSDOM } from "jsdom";
import { createServer, type ViteDevServer } from "vite";

const dom = new JSDOM('<!doctype html><div id="app"></div>', {
  url: "http://localhost/web-ui/?view=guide",
  pretendToBeVisual: true,
});
Object.defineProperty(dom.window, "matchMedia", {
  value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
});
Object.defineProperty(dom.window, "setTimeout", { value: () => 0 });
Object.defineProperty(dom.window, "clearTimeout", { value: () => {} });
Object.defineProperty(dom.window, "setInterval", { value: () => 0 });
const streams: Array<Map<string, (event: { data: string }) => void>> = [];
const globals: Record<string, unknown> = {
  ResizeObserver: class {
    observe() {}
    unobserve() {}
    disconnect() {}
  },
  EventSource: class {
    handlers = new Map<string, (event: { data: string }) => void>();
    constructor() {
      streams.push(this.handlers);
    }
    addEventListener(name: string, callback: (event: { data: string }) => void) {
      this.handlers.set(name, callback);
    }
    close() {}
  },
  window: dom.window,
  document: dom.window.document,
  location: dom.window.location,
  history: dom.window.history,
  localStorage: dom.window.localStorage,
  navigator: dom.window.navigator,
  HTMLElement: dom.window.HTMLElement,
  HTMLDialogElement: dom.window.HTMLDialogElement,
  HTMLTextAreaElement: dom.window.HTMLTextAreaElement,
  customElements: dom.window.customElements,
  Node: dom.window.Node,
  Element: dom.window.Element,
  SVGElement: dom.window.SVGElement,
  Text: dom.window.Text,
  Comment: dom.window.Comment,
  DocumentFragment: dom.window.DocumentFragment,
  Event: dom.window.Event,
  CustomEvent: dom.window.CustomEvent,
  KeyboardEvent: dom.window.KeyboardEvent,
  MouseEvent: dom.window.MouseEvent,
  SubmitEvent: dom.window.SubmitEvent,
  InputEvent: dom.window.InputEvent,
  MutationObserver: dom.window.MutationObserver,
  DOMRect: dom.window.DOMRect,
  DOMMatrix: class {
    a = 1;
    b = 0;
    c = 0;
    d = 1;
    e = 0;
    multiplySelf() {
      return this;
    }
    scaleSelf() {
      return this;
    }
    translateSelf() {
      return this;
    }
  },
  requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(Date.now()), 0),
  cancelAnimationFrame: clearTimeout,
  setInterval: () => 0,
  alert: () => {},
  getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
};
for (const [key, value] of Object.entries(globals))
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });

async function withShell(): Promise<{
  vite: ViteDevServer;
  shell: typeof import("../src/shell.ts");
  appState: typeof import("../src/shell-state.ts").appState;
  sessions: typeof import("../src/sessions.ts");
  conversations: typeof import("../src/conversations.ts");
  split: typeof import("../src/split.ts");
}> {
  const vite = await createServer({
    server: { middlewareMode: true, hmr: false, ws: false },
    optimizeDeps: { noDiscovery: true },
    appType: "custom",
  });
  const shell = (await vite.ssrLoadModule(
    `/src/shell.ts?navigation=${Date.now()}`,
  )) as typeof import("../src/shell.ts");
  const { appState } = (await vite.ssrLoadModule("/src/shell-state.ts")) as typeof import("../src/shell-state.ts");
  const sessions = (await vite.ssrLoadModule("/src/sessions.ts")) as typeof import("../src/sessions.ts");
  const conversations = (await vite.ssrLoadModule("/src/conversations.ts")) as typeof import("../src/conversations.ts");
  const split = (await vite.ssrLoadModule("/src/split.ts")) as typeof import("../src/split.ts");
  return { vite, shell, appState, sessions, conversations, split };
}

after(() => dom.window.close());

test("notification refresh loads latest read-only messages and reports network failures", async () => {
  const originalFetch = globalThis.fetch;
  let fail = false;
  let targetMode = false;
  let delayedReads = 0;
  let onApprovalRead: (() => void) | undefined;
  let notifications: Array<Record<string, unknown>> = [];
  const transcriptCalls: string[] = [];
  const scrolled: string[] = [];
  Object.defineProperty(dom.window.HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value(this: HTMLElement) {
      scrolled.push(this.dataset.messageLocation ?? "");
    },
  });
  const rows = ["s", "t"].map((id) => ({
    id,
    threadRef: `slack:c:${id}`,
    scopeId: "channel:c",
    type: "channel",
    createdAt: 1,
    title: id,
  }));
  globalThis.fetch = (async (input) => {
    if (fail) throw new Error("offline");
    const url = String(input);
    if (url.endsWith("/api/notifications"))
      return Response.json({
        items: notifications,
        unreadCount: notifications.length,
        unreadThreads: notifications.length,
      });
    if (/\/api\/notifications\/[^/]+\/read$/.test(url)) {
      notifications = [];
      return Response.json({ ok: true });
    }
    if (url.endsWith("/approvals")) {
      const callback = onApprovalRead;
      onApprovalRead = undefined;
      callback?.();
      return Response.json({ approvals: [] });
    }
    if (url.includes("/api/runtime-config")) return Response.json({}, { status: 503 });
    if (url.endsWith("/api/sessions")) return Response.json({ sessions: rows });
    if (targetMode && /\/api\/sessions\/[st](?:\?|$)/.test(url)) {
      transcriptCalls.push(url);
      if (delayedReads-- > 0) return Response.json({ entries: [], earlierEntries: 0 });
      if (url.includes("beforeSeq=100") || url.includes("sinceSeq=0"))
        return Response.json({
          entries: [
            {
              type: "user",
              seq: 0,
              createdAt: new Date(2025, 8, 8, 8, 5).getTime(),
              payload: { text: "原始提醒", runId: "original-run" },
            },
            {
              type: "tool_call",
              seq: 1,
              createdAt: 2,
              payload: { action: "post", callId: "post-a", text: "原始交付" },
            },
            {
              type: "tool_result",
              seq: 2,
              createdAt: 3,
              payload: { callId: "post-a", ok: true, deliveryId: "original-delivery" },
            },
          ],
          earlierEntries: 0,
        });
      return Response.json({
        entries: [
          { type: "user", seq: 100, createdAt: 100, payload: { text: "稍后的问题", runId: "later-run" } },
          { type: "assistant", seq: 101, createdAt: 101, payload: { text: "最新的回复" } },
        ],
        earlierEntries: 3,
      });
    }
    return Response.json({ entries: [], earlierEntries: 0, contexts: [] });
  }) as typeof fetch;
  const { vite, shell, appState, conversations, sessions, split } = await withShell();
  try {
    appState.me = { user: "u@t", org: "o" };
    appState.currentView = "chats";
    appState.mainEl = document.createElement("main");
    document.body.append(appState.mainEl);
    Object.defineProperty(dom.window.HTMLElement.prototype, "getClientRects", {
      configurable: true,
      value: () => [new dom.window.DOMRect(0, 0, 600, 600)],
    });
    const conv = conversations.createConversation({
      pane: true,
      ownsUrl: false,
      container: () => appState.mainEl,
      claimContainer: () => appState.mainEl,
      visible: () => appState.currentView === "chats",
      density: () => "full",
      onDensityChange() {},
      ensureDeliveryStream() {},
    });
    const session = {
      id: "s",
      threadRef: "slack:c:t",
      scopeId: "channel:c",
      type: "channel",
      createdAt: 1,
      title: "Example",
    } as never;
    conv.mountReadOnly(session, []);
    assert.equal(conv.state.threadRef, null);
    assert.equal(conv.mountedThreadRef(), "slack:c:t");
    assert.equal(await conv.showLatestMessages(), true);
    targetMode = true;
    assert.equal(await conv.showLatestMessages({ deliveryId: "original-delivery" }), true);
    assert.equal(scrolled.at(-1), "delivery:original-delivery");
    assert.equal(document.querySelector(".message-notification-target")?.textContent?.includes("原始交付"), true);
    assert.equal(document.querySelector(".message-notification-target")?.textContent?.includes("最新的回复"), false);
    assert.ok(transcriptCalls.some((url) => url.includes("beforeSeq=100")));
    assert.equal(await conv.showLatestMessages({ runId: "original-run" }), true);
    assert.equal(scrolled.at(-1), "run:original-run");
    delayedReads = 2;
    assert.equal(await conv.showLatestMessages({ runId: "original-run" }), true);
    conv.mountContinuable("slack:c:t", "s", "channel:c", [], null, session);
    const activeAgent = conv.state.agent!;
    const liveMessages = activeAgent.state.messages;
    Object.assign(activeAgent.state, { isStreaming: true });
    const waiting = conv.showLatestMessages({ deliveryId: "original-delivery" });
    await new Promise((resolve) => setTimeout(resolve, 350));
    assert.equal(activeAgent.state.messages, liveMessages, "notification wait must not replace an active stream");
    Object.assign(activeAgent.state, { isStreaming: false });
    assert.equal(await waiting, true);
    assert.equal(scrolled.at(-1), "delivery:original-delivery");
    conv.mountContinuable("slack:c:t", "s", "channel:c", [], null, session);
    onApprovalRead = () => conv.onDelivery("slack:c:t");
    assert.equal(
      await conv.showLatestMessages({ deliveryId: "original-delivery" }),
      true,
      "concurrent delivery refresh must not cancel notification positioning",
    );
    assert.equal(scrolled.at(-1), "delivery:original-delivery");
    const cancelled = conv.showLatestMessages({ deliveryId: "missing" });
    await new Promise((resolve) => setTimeout(resolve, 25));
    sessions.sessionsState.openGeneration++;
    assert.equal(await cancelled, false);
    targetMode = false;
    fail = true;
    await assert.rejects(() => conv.showLatestMessages(), /offline/);
    fail = false;
    appState.currentView = "docs" as typeof appState.currentView;
    assert.equal(await conv.showLatestMessages(), false);
    conversations.disposeConversation(conv);
    appState.currentView = "chats";
    sessions.sessionsState.list = rows as never;
    const backgroundMain = conversations.mainConversation();
    backgroundMain.mountReadOnly(rows[1] as never, []);
    localStorage.setItem(
      "web-ui:split-canvas:v1",
      JSON.stringify({
        v: 2,
        active: true,
        layout: {
          grid: {
            root: {
              type: "branch",
              data: [{ type: "leaf", data: { views: ["p1", "p2"], activeView: "p1", id: "g" }, size: 600 }],
            },
            width: 1000,
            height: 600,
            orientation: "HORIZONTAL",
          },
          panels: Object.fromEntries(
            rows.map((row, i) => [
              `p${i + 1}`,
              {
                id: `p${i + 1}`,
                contentComponent: "pane",
                tabComponent: "pane",
                params: { sessionId: row.id, threadRef: row.threadRef },
              },
            ]),
          ),
          activeGroup: "g",
        },
      }),
    );
    split.loadPersistedSplit();
    assert.equal(split.mountRestoredCanvas(), true);
    assert.equal(backgroundMain.state.host, null);
    assert.equal(backgroundMain.mountedThreadRef(), rows[1]!.threadRef);
    const settle = async () => {
      for (let i = 0; i < 20; i++) await new Promise((resolve) => setTimeout(resolve, 5));
    };
    await settle();
    await sessions.openSession(rows[1] as never);
    await settle();
    await sessions.openSession(rows[0] as never);
    await settle();
    targetMode = true;
    Object.defineProperty(document, "hasFocus", { configurable: true, value: () => true });
    Object.defineProperty(dom.window.HTMLElement.prototype, "getBoundingClientRect", {
      configurable: true,
      value: () => new dom.window.DOMRect(0, 0, 600, 600),
    });
    const notification = (i: number) => ({
      id: `entry:${rows[i]!.id}:0`,
      sessionId: rows[i]!.id,
      threadRef: rows[i]!.threadRef,
      title: rows[i]!.title,
      at: Date.now(),
      kind: "message",
      unreadCount: 1,
      runId: "original-run",
    });
    await conversations
      .allConversations()
      .find((item) => item.mountedThreadRef() === rows[0]!.threadRef)!
      .showLatestMessages({ runId: "original-run" });
    notifications = [notification(0)];
    const delivery = streams.find((handlers) => handlers.has("delivery"))!.get("delivery")!;
    const toast = document.querySelector<HTMLElement>(".mention-toast")!;
    delivery({ data: JSON.stringify({ threadRef: rows[0]!.threadRef }) });
    await settle();
    assert.equal(toast.hidden, true, "visible readonly conversation suppresses its own reminder");
    notifications = [notification(0)];
    const visibleConv = conversations
      .allConversations()
      .find((item) => item.mountedThreadRef() === rows[0]!.threadRef)!;
    const originalDelivery = visibleConv.onDelivery;
    let finishVisibility: (() => void) | undefined;
    visibleConv.onDelivery = async () => {
      await new Promise<void>((resolve) => {
        finishVisibility = resolve;
      });
    };
    document.dispatchEvent(new dom.window.Event("visibilitychange"));
    await settle();
    assert.equal(
      notifications.length,
      1,
      "visibility refresh must wait for the pending transcript before acknowledging",
    );
    assert.equal(toast.hidden, true);
    visibleConv.onDelivery = originalDelivery;
    finishVisibility!();
    await settle();
    assert.equal(notifications.length, 0);
    notifications = [notification(1)];
    delivery({ data: JSON.stringify({ threadRef: rows[1]!.threadRef }) });
    await settle();
    assert.equal(toast.hidden, false, "hidden Dockview tab must notify even with nonempty layout rectangles");
    toast.querySelector<HTMLButtonElement>(".mention-toast-action")!.click();
    await settle();
    assert.equal(toast.hidden, true, "real readonly toast navigation opens and refreshes the target successfully");
    assert.equal(split.splitState.focusedId, "p2");
    assert.equal(
      conversations.allConversations().find((item) => item.mountedThreadRef() === rows[1]!.threadRef)?.state.threadRef,
      null,
    );
    split.exitSplitIfActive();
    shell.renderAuthGate({ kind: "portal" });
    assert.equal(document.querySelector(".notification-center"), null);
    assert.equal(document.querySelector(".mention-toast"), null);
    assert.equal(appState.me, null);
    assert.ok(conversations.allConversations().every((conv) => conv.mountedThreadRef() === null));
    const bridge = (await vite.ssrLoadModule("/src/core-bridge.ts")) as typeof import("../src/core-bridge.ts");
    const beforeSigninFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      Response.json({ mode: "dev", reason: "unauthenticated" }, { status: 401 })) as typeof fetch;
    await bridge.webFetch("/api/me");
    globalThis.fetch = beforeSigninFetch;
    appState.me = { user: "new-login@fixture", org: "o" };
    shell.mountShell();
    const privateContent = document.createElement("div");
    privateContent.textContent = "old private transcript fixture";
    appState.mainEl!.append(privateContent);
    conversations.ensureDeliveryStream();
    const current = conversations.mainConversation();
    current.state.rememberedThreadRef = "old-login-thread";
    current.composer.state.draft = "old login draft";
    const beforeSignoutFetch = globalThis.fetch;
    let finishSignout: ((response: Response) => void) | undefined;
    globalThis.fetch = ((input, init) =>
      String(input).endsWith("/signout")
        ? new Promise<Response>((resolve) => {
            finishSignout = resolve;
          })
        : beforeSignoutFetch(input, init)) as typeof fetch;
    assert.ok(document.querySelector(".sidebar"));
    assert.equal(privateContent.isConnected, true);
    const signingOut = shell.signOut();
    assert.equal(privateContent.isConnected, false, "pending signout must immediately remove private transcript");
    assert.equal(document.querySelector(".sidebar"), null);
    assert.equal(
      document.querySelector(".notification-center"),
      null,
      "dev signout must stop notifications before its network request finishes",
    );
    assert.equal(appState.me, null);
    assert.equal(current.mountedThreadRef(), null);
    assert.equal(current.composer.state.draft, "");
    finishSignout!(Response.json({ ok: true }));
    await signingOut;
    globalThis.fetch = beforeSignoutFetch;
  } finally {
    globalThis.fetch = originalFetch;
    await vite.close();
  }
});
