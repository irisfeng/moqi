import assert from "node:assert/strict";
import { after, test } from "node:test";
import { JSDOM } from "jsdom";
import { createServer, type ViteDevServer } from "vite";

const dom = new JSDOM('<!doctype html><div id="app"></div>', {
  url: "http://localhost/web-ui/?view=guide",
});
Object.defineProperty(dom.window, "matchMedia", {
  value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
});
Object.defineProperty(dom.window, "setTimeout", { value: () => 0 });
Object.defineProperty(dom.window, "clearTimeout", { value: () => {} });
Object.defineProperty(dom.window, "setInterval", { value: () => 0 });
const globals: Record<string, unknown> = {
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
  ResizeObserver: class {
    observe() {}
    unobserve() {}
    disconnect() {}
  },
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

test("delayed growth navigation stops after the user leaves the chat view", async () => {
  const originalFetch = globalThis.fetch;
  let releaseSessions!: (response: Response) => void;
  let sessionsStarted!: () => void;
  const sessionsGate = new Promise<Response>((resolve) => (releaseSessions = resolve));
  const started = new Promise<void>((resolve) => (sessionsStarted = resolve));
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    if (String(input).endsWith("/api/sessions")) {
      sessionsStarted();
      return sessionsGate;
    }
    return Response.json({}, { status: 404 });
  }) as typeof fetch;
  const { vite, shell, appState } = await withShell();
  try {
    appState.me = { user: "u@t", org: "o" };
    appState.currentView = "guide" as typeof appState.currentView;
    appState.viewRenderSeq = 10;
    appState.mainEl = document.createElement("main");
    appState.topEl = document.createElement("div");
    appState.listEl = null;
    const task = {
      key: "onboarding-v1",
      kind: "onboarding",
      title: "首关",
      description: "完成一项工作",
      prompt: "请处理这项工作",
      revisionPrompt: "请修改成果",
      steps: ["目标", "材料", "生成", "修改", "验收"],
      firstPoints: 30,
      revisionPoints: 20,
      participation: {
        task: {} as never,
        threadRef: "web:u@t:growth",
        startedAt: Date.now(),
        prepared: true,
        firstRunId: null,
        firstHash: null,
        firstAcceptedAt: null,
        completedAt: null,
      },
      sessionId: "session-growth",
      evidence: null,
      status: "working",
    } as never;
    const opening = shell.openGrowthChat(task);
    await started;
    appState.currentView = "docs" as typeof appState.currentView;
    appState.viewRenderSeq = 11;
    releaseSessions(Response.json({ sessions: [] }));
    await opening;
    assert.equal(appState.currentView, "docs");
    assert.equal(appState.viewRenderSeq, 11);
  } finally {
    globalThis.fetch = originalFetch;
    await vite.close();
  }
});

test("delayed growth transcript cannot mount after leaving the chat view", async () => {
  const originalFetch = globalThis.fetch;
  let releaseTranscript!: (response: Response) => void;
  let transcriptStarted!: () => void;
  const transcriptGate = new Promise<Response>((resolve) => (releaseTranscript = resolve));
  const transcriptStartedPromise = new Promise<void>((resolve) => (transcriptStarted = resolve));
  const session = {
    id: "session-growth",
    type: "dm",
    scopeId: "personal:u@t",
    threadRef: "web:u@t:growth",
    createdAt: Date.now(),
    title: "成长专用会话",
    channelName: null,
    archived: false,
  };
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith("/api/sessions")) return Response.json({ sessions: [session] });
    if (url.includes("/api/sessions/session-growth/approvals")) return Response.json({ approvals: [] });
    if (url.includes("/api/sessions/session-growth")) {
      transcriptStarted();
      return transcriptGate;
    }
    return Response.json({}, { status: 404 });
  }) as typeof fetch;
  const { vite, shell, appState } = await withShell();
  try {
    appState.me = { user: "u@t", org: "o", destinations: ["docs"] };
    appState.currentView = "guide" as typeof appState.currentView;
    appState.viewRenderSeq = 10;
    appState.mainEl = document.createElement("main");
    appState.topEl = document.createElement("div");
    appState.listEl = null;
    const task = {
      key: "onboarding-v1",
      kind: "onboarding",
      title: "首关",
      description: "完成一项工作",
      prompt: "请处理这项工作",
      revisionPrompt: "请修改成果",
      steps: ["目标", "材料", "生成", "修改", "验收"],
      firstPoints: 30,
      revisionPoints: 20,
      participation: {
        task: {} as never,
        threadRef: "web:u@t:growth",
        startedAt: Date.now(),
        prepared: true,
        firstRunId: null,
        firstHash: null,
        firstAcceptedAt: null,
        completedAt: null,
      },
      sessionId: "session-growth",
      evidence: null,
      status: "working",
    } as never;
    const opening = shell.openGrowthChat(task);
    await transcriptStartedPromise;
    shell.switchView("docs");
    releaseTranscript(Response.json({ entries: [] }));
    await opening;
    assert.equal(appState.currentView, "docs");
    assert.equal(appState.viewRenderSeq, 12);
    assert.equal(appState.mainEl.querySelector(".custom-chat"), null);
  } finally {
    globalThis.fetch = originalFetch;
    await vite.close();
  }
});

test("new chat wins while a growth session transcript is opening", async () => {
  const originalFetch = globalThis.fetch;
  let releaseTranscript!: (response: Response) => void;
  let transcriptStarted!: () => void;
  const transcriptGate = new Promise<Response>((resolve) => (releaseTranscript = resolve));
  const transcriptStartedPromise = new Promise<void>((resolve) => (transcriptStarted = resolve));
  const session = {
    id: "session-growth-new-chat",
    type: "dm",
    scopeId: "personal:u@t",
    threadRef: "web:u@t:growth-new-chat",
    createdAt: Date.now(),
    title: "成长专用会话",
    channelName: null,
    archived: false,
  };
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith("/api/sessions")) return Response.json({ sessions: [session] });
    if (url.includes("/api/sessions/session-growth-new-chat/approvals")) return Response.json({ approvals: [] });
    if (url.includes("/api/sessions/session-growth-new-chat")) {
      transcriptStarted();
      return transcriptGate;
    }
    return Response.json({}, { status: 404 });
  }) as typeof fetch;
  const { vite, shell, appState, sessions, conversations } = await withShell();
  try {
    appState.me = { user: "u@t", org: "o" };
    appState.currentView = "guide" as typeof appState.currentView;
    appState.viewRenderSeq = 20;
    appState.mainEl = document.createElement("main");
    appState.topEl = document.createElement("div");
    appState.listEl = null;
    const task = {
      key: "onboarding-v1",
      kind: "onboarding",
      title: "首关",
      description: "完成一项工作",
      prompt: "请处理这项工作",
      revisionPrompt: "请修改成果",
      steps: ["目标", "材料", "生成", "修改", "验收"],
      firstPoints: 30,
      revisionPoints: 20,
      participation: {
        task: {} as never,
        threadRef: session.threadRef,
        startedAt: Date.now(),
        prepared: true,
        firstRunId: null,
        firstHash: null,
        firstAcceptedAt: null,
        completedAt: null,
      },
      sessionId: session.id,
      evidence: null,
      status: "working",
    } as never;
    const opening = shell.openGrowthChat(task);
    await transcriptStartedPromise;
    const newThreadRef = conversations.mainConversation().newChat();
    releaseTranscript(Response.json({ entries: [] }));
    await opening;
    assert.notEqual(conversations.mainConversation().state.threadRef, session.threadRef);
    assert.equal(conversations.mainConversation().state.threadRef, newThreadRef);
    assert.equal(sessions.sessionsState.openingKey, null);
  } finally {
    globalThis.fetch = originalFetch;
    await vite.close();
  }
});

test("opening another chat wins while the growth transcript is delayed", async () => {
  const originalFetch = globalThis.fetch;
  let releaseGrowth!: (response: Response) => void;
  let growthStarted!: () => void;
  const growthGate = new Promise<Response>((resolve) => (releaseGrowth = resolve));
  const growthStartedPromise = new Promise<void>((resolve) => (growthStarted = resolve));
  const growth = {
    id: "session-growth-other-chat",
    type: "dm",
    scopeId: "personal:u@t",
    threadRef: "web:u@t:growth-other-chat",
    createdAt: Date.now(),
    title: "成长专用会话",
    channelName: null,
    archived: false,
  };
  const other = {
    id: "session-other-chat",
    type: "dm",
    scopeId: "personal:u@t",
    threadRef: "web:u@t:other-chat",
    createdAt: Date.now(),
    title: "另一个会话",
    channelName: null,
    archived: false,
  };
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith("/api/sessions")) return Response.json({ sessions: [growth, other] });
    if (url.includes("/api/sessions/session-growth-other-chat/approvals")) return Response.json({ approvals: [] });
    if (url.includes("/api/sessions/session-other-chat/approvals")) return Response.json({ approvals: [] });
    if (url.includes("/api/sessions/session-growth-other-chat")) {
      growthStarted();
      return growthGate;
    }
    if (url.includes("/api/sessions/session-other-chat")) return Response.json({ entries: [] });
    return Response.json({}, { status: 404 });
  }) as typeof fetch;
  const { vite, shell, appState, sessions, conversations } = await withShell();
  try {
    appState.me = { user: "u@t", org: "o" };
    appState.currentView = "guide" as typeof appState.currentView;
    appState.viewRenderSeq = 30;
    appState.mainEl = document.createElement("main");
    appState.topEl = document.createElement("div");
    appState.listEl = null;
    sessions.sessionsState.list = [growth, other] as never;
    const task = {
      key: "onboarding-v1",
      kind: "onboarding",
      title: "首关",
      description: "完成一项工作",
      prompt: "请处理这项工作",
      revisionPrompt: "请修改成果",
      steps: ["目标", "材料", "生成", "修改", "验收"],
      firstPoints: 30,
      revisionPoints: 20,
      participation: {
        task: {} as never,
        threadRef: growth.threadRef,
        startedAt: Date.now(),
        prepared: true,
        firstRunId: null,
        firstHash: null,
        firstAcceptedAt: null,
        completedAt: null,
      },
      sessionId: growth.id,
      evidence: null,
      status: "working",
    } as never;
    const growthOpening = shell.openGrowthChat(task);
    await growthStartedPromise;
    await sessions.openSession(other as never);
    releaseGrowth(Response.json({ entries: [] }));
    await growthOpening;
    const mounted = conversations.allConversations().map((conversation) => conversation.mountedThreadRef());
    assert.ok(mounted.includes(other.threadRef));
    assert.ok(!mounted.includes(growth.threadRef));
    assert.equal(sessions.sessionsState.openingKey, null);
  } finally {
    globalThis.fetch = originalFetch;
    await vite.close();
  }
});

test("leaving the guide for a sidebar session cancels pending growth actions", async () => {
  const originalFetch = globalThis.fetch;
  let releaseStart!: (response: Response) => void;
  let startStarted!: () => void;
  let releaseOther!: (response: Response) => void;
  let otherStarted!: () => void;
  let postCount = 0;
  const startGate = new Promise<Response>((resolve) => (releaseStart = resolve));
  const startBegan = new Promise<void>((resolve) => (startStarted = resolve));
  const otherGate = new Promise<Response>((resolve) => (releaseOther = resolve));
  const otherBegan = new Promise<void>((resolve) => (otherStarted = resolve));
  const baseTask = {
    key: "onboarding-v1",
    kind: "onboarding",
    title: "首关",
    description: "完成一项工作",
    prompt: "请处理这项工作",
    revisionPrompt: "请修改成果",
    steps: ["目标", "材料", "生成", "修改", "验收"],
    firstPoints: 30,
    revisionPoints: 20,
  };
  const available = {
    points: 0,
    level: "新手上路",
    nextLevelAt: 50,
    badges: [],
    onboarding: { ...baseTask, participation: null, sessionId: null, evidence: null, status: "available" },
    daily: null,
    preferences: { enabled: false, time: "09:30", timeZone: "Asia/Shanghai" },
    reminder: null,
    history: [],
    date: "2026-09-05",
  };
  const startedSnapshot = {
    ...available,
    onboarding: {
      ...baseTask,
      participation: {
        task: baseTask,
        threadRef: "web:u@t:growth",
        startedAt: Date.now(),
        prepared: false,
        firstRunId: null,
        firstHash: null,
        firstAcceptedAt: null,
        completedAt: null,
      },
      sessionId: null,
      evidence: null,
      status: "working",
    },
  };
  const other = {
    id: "session-other-sidebar",
    type: "dm",
    scopeId: "personal:u@t",
    threadRef: "web:u@t:other-sidebar",
    createdAt: Date.now(),
    title: "另一个会话",
    channelName: null,
    archived: false,
  };
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/api/growth/action")) {
      postCount += 1;
      const body = JSON.parse(String(init?.body ?? "{}")) as { action?: string };
      if (body.action === "start") {
        startStarted();
        return startGate;
      }
      return Response.json(startedSnapshot);
    }
    if (url.endsWith("/api/growth")) return Response.json(available);
    if (url.endsWith("/api/sessions")) return Response.json({ sessions: [other] });
    if (url.includes("/api/sessions/session-other-sidebar/approvals")) return Response.json({ approvals: [] });
    if (url.includes("/api/sessions/session-other-sidebar")) {
      otherStarted();
      return otherGate;
    }
    return Response.json({}, { status: 404 });
  }) as typeof fetch;
  const { vite, shell, appState, sessions, conversations } = await withShell();
  try {
    appState.me = { user: "u@t", org: "o" };
    shell.mountShell();
    shell.switchView("guide");
    await new Promise((resolve) => setTimeout(resolve, 30));
    const startButton = appState.mainEl?.querySelector<HTMLButtonElement>(".growth-task-stage .growth-button.primary");
    assert.ok(startButton);
    sessions.sessionsState.list = [other] as never;
    startButton.click();
    await startBegan;
    const userOpening = sessions.openSession(other as never);
    await otherBegan;
    releaseStart(Response.json(startedSnapshot));
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(postCount, 1);
    const mountedThreads = () =>
      conversations.allConversations().map((conversation) => conversation.mountedThreadRef());
    assert.ok(!mountedThreads().includes("web:u@t:growth"));
    releaseOther(Response.json({ entries: [] }));
    await userOpening;
    assert.ok(mountedThreads().includes(other.threadRef));
    assert.ok(!mountedThreads().includes("web:u@t:growth"));
  } finally {
    globalThis.fetch = originalFetch;
    await vite.close();
  }
});

test("attachment navigation guard scans every conversation surface", async () => {
  const { vite, shell, split, conversations } = await withShell();
  try {
    assert.equal(
      shell.attachmentNavigationMessage([
        { composer: { state: { attachments: [], processingFiles: false } } },
        { composer: { state: { attachments: [{}], processingFiles: false } } },
      ]),
      "You have attachments that were not sent. Send or remove them before leaving this chat.",
    );
    assert.equal(
      shell.attachmentNavigationMessage([
        { composer: { state: { attachments: [{}], processingFiles: false } } },
        { composer: { state: { attachments: [], processingFiles: true } } },
      ]),
      "Files are still being processed. Wait for them to finish before leaving this chat.",
    );
    assert.equal(
      shell.attachmentNavigationMessage([{ composer: { state: { attachments: [], processingFiles: false } } }]),
      "",
    );
    const main = conversations.mainConversation();
    main.composer.state.attachments = [{}] as never;
    split.splitState.active = true;
    assert.equal(split.exitSplitIfActive(), false);
    assert.equal(split.splitState.active, true);
    main.composer.state.attachments = [];
    split.splitState.active = false;
  } finally {
    await vite.close();
  }
});

test("a new pane can initialize without clearing attachments in another conversation", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => Response.json({}, { status: 404 })) as typeof fetch;
  const { vite, appState, conversations } = await withShell();
  let pane: ReturnType<typeof conversations.createConversation> | null = null;
  try {
    appState.me = { user: "u@t", org: "o" };
    appState.currentView = "chats";
    appState.mainEl = document.createElement("main");
    appState.topEl = document.createElement("div");
    appState.listEl = null;
    const main = conversations.mainConversation();
    main.composer.state.attachments = [{}] as never;
    const container = document.createElement("div");
    pane = conversations.createConversation({
      pane: true,
      ownsUrl: false,
      container: () => container,
      claimContainer: () => container,
      visible: () => true,
      density: () => "full",
      onDensityChange() {},
      ensureDeliveryStream() {},
    });
    const thread = pane.newChat();
    assert.match(thread, /^web:u@t:/);
    assert.equal(pane.state.threadRef, thread);
    assert.equal(main.composer.state.attachments.length, 1);
    main.composer.state.attachments = [];
  } finally {
    if (pane) conversations.disposeConversation(pane);
    globalThis.fetch = originalFetch;
    await vite.close();
  }
});

after(() => dom.window.close());
