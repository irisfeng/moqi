import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { createServer, type ViteDevServer } from "vite";
import { dateKeyOf, pickDaily, scenarioCards, type HomeTip } from "../src/home-config.ts";
import { FEATURED_SCENES } from "../src/featured-scenes.ts";

type HomeFixture = () => Response | Promise<Response>;

const dom = new JSDOM('<!doctype html><div id="app"></div><main id="main"></main>', {
  url: "http://localhost/web-ui/?view=chats",
});
Object.defineProperty(dom.window, "matchMedia", {
  value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
});
Object.defineProperty(dom.window.HTMLDialogElement.prototype, "showModal", {
  value(this: HTMLDialogElement) {
    this.setAttribute("open", "");
  },
});
Object.defineProperty(dom.window.HTMLDialogElement.prototype, "close", {
  value(this: HTMLDialogElement) {
    this.removeAttribute("open");
  },
});
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
    f = 0;
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
  getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
};
for (const [key, value] of Object.entries(globals))
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });

function tipFixture(id: string, title: string, status = "active"): HomeTip {
  return {
    id,
    layer: "task",
    title,
    oneLiner: `副行 ${id}`,
    prompt: `提示词 ${id}`,
    capability: "",
    depts: [],
    status: status as HomeTip["status"],
  };
}

function sceneTip(id: string): HomeTip {
  const scene = FEATURED_SCENES.find((item) => item.id === id)!;
  return { ...tipFixture(id, scene.title), prompt: scene.prompt };
}

function homeConfigFixture(openerEnabled: boolean) {
  return {
    welcome: {
      headline: "今天要办什么？",
      subline: "把任务交代给我。",
      roles: [
        { id: "r1", label: "业务人员", tips: ["W01", "W11", "W25", "W09", "unsupported", "deferred"] },
        { id: "r2", label: "团队负责人", tips: ["W05", "W13"] },
      ],
    },
    composerPlaceholder: "",
    tips: [
      sceneTip("W01"),
      sceneTip("W11"),
      sceneTip("W25"),
      sceneTip("W05"),
      sceneTip("W09"),
      sceneTip("W13"),
      tipFixture("unsupported", "未收录卡"),
      tipFixture("deferred", "停用卡", "deferred"),
    ],
    nav: { advancedGroup: [] },
    opener: { enabled: openerEnabled },
  };
}

function activeTipsOf(config: ReturnType<typeof homeConfigFixture>): HomeTip[] {
  return config.tips.filter((t) => t.status === "active" && t.id !== "unsupported");
}

function roleOneTipsOf(config: ReturnType<typeof homeConfigFixture>): HomeTip[] {
  const ids = new Set(config.welcome.roles[0]!.tips);
  return config.tips.filter((t) => ids.has(t.id) && t.status === "active" && t.id !== "unsupported");
}

interface BootOptions {
  home: HomeFixture;
  sessions?: Array<{ id?: string; threadRef?: string }>;
  pane?: boolean;
}

interface Boot {
  vite: ViteDevServer;
  container: HTMLElement;
  surface: {
    state: { agent: { state: { messages: unknown[]; errorMessage?: string } } | null };
    mountContinuable(threadRef: string, sessionId: string | null, scopeId: string | null, messages: never[]): void;
    redraw(): void;
  };
  suppressProactiveOpener: (threadRef: string) => void;
  composerState: { draft: string; error: string };
  events: Array<{ type: string; ref: string }>;
  openerTurns: unknown[];
  focusCount: () => number;
  storedDraft: (key: string) => string;
}

async function settle(rounds = 8): Promise<void> {
  for (let i = 0; i < rounds; i++) await new Promise((resolve) => setTimeout(resolve, 5));
}

async function boot(options: BootOptions): Promise<Boot> {
  localStorage.clear();
  const events: Array<{ type: string; ref: string }> = [];
  const openerTurns: unknown[] = [];
  let focusCount = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const path = String(input);
    if (path.endsWith("/api/home-config")) return options.home();
    if (path.endsWith("/api/home-event")) {
      events.push(JSON.parse(String(init?.body ?? "{}")) as { type: string; ref: string });
      return Response.json({});
    }
    const turnRoute = ["/api/turn", "/api/turn/v2", "/api/proactive-opener"].find((route) => path.endsWith(route));
    if (turnRoute && init?.method === "POST") {
      openerTurns.push({ route: turnRoute, ...(JSON.parse(String(init?.body ?? "{}")) as object) });
      return Response.json({}, { status: 503 });
    }
    if (path.endsWith("/api/sessions")) return await new Promise<Response>(() => {});
    return Response.json({}, { status: 404 });
  }) as typeof fetch;

  const composerState = {
    draft: "",
    attachments: [],
    error: "",
    processingFiles: false,
    dragging: false,
    openMenu: null,
    slashDismissed: false,
    effortLevel: "medium",
    fastMode: undefined,
    pasteView: null,
  };
  const composerInput = document.createElement("textarea");
  composerInput.className = "composer-input";
  const composer = {
    state: composerState,
    composerForm: () => {
      composerInput.value = composerState.draft;
      return composerInput;
    },
    quoteMessage: () => {},
    queuedStrip: () => "",
    composerApprovalPanel: () => "",
    fillSuggestedPrompt: () => {},
    sendSuggestedPrompt: async () => {},
    restageAttachments: () => {},
    queuedRunsFor: () => [],
    setQueuedRuns: () => {},
    resetComposer() {
      composerState.draft = "";
      composerState.error = "";
    },
    focusComposerEnd() {
      focusCount++;
      composerInput.focus();
      composerInput.setSelectionRange(composerInput.value.length, composerInput.value.length);
    },
    resizeComposer: () => {},
    currentModelOption: () => ({ model: "test-model", harnessId: "test" }),
    carryModelPick: () => {},
    refreshRuntimeSelection: async () => {},
    onDragEnter: () => {},
    onDragOver: () => {},
    onDragLeave: () => {},
    onDrop: async () => {},
    closeMenus: () => false,
    dispose: () => {},
  };
  const containerEl = document.createElement("div");
  document.body.appendChild(containerEl);
  const ctx = {
    pane: options.pane ?? false,
    ownsUrl: false,
    container: () => containerEl,
    claimContainer: () => containerEl,
    visible: () => true,
    density: () => (options.pane ? "compact" : "full"),
    onDensityChange: () => {},
    ensureDeliveryStream: () => {},
    chat: {},
    composer,
  };

  const vite = await createServer({ server: { middlewareMode: true, hmr: false }, appType: "custom" });
  try {
    const { appState } = (await vite.ssrLoadModule("/src/shell-state.ts")) as {
      appState: { me: unknown; currentView: string };
    };
    appState.me = { user: "u@t", org: "o", verifiedSends: true };
    appState.currentView = "chats";
    const { sessionsState } = (await vite.ssrLoadModule("/src/sessions.ts")) as {
      sessionsState: { loaded: boolean; list: Array<{ id?: string; threadRef?: string }> };
    };
    sessionsState.loaded = true;
    sessionsState.list = options.sessions ?? [];
    const { storedDraft } = (await vite.ssrLoadModule("/src/drafts.ts")) as { storedDraft: (key: string) => string };
    const { createChatSurface, suppressProactiveOpener } = (await vite.ssrLoadModule("/src/chat.ts")) as {
      createChatSurface: (ctx: unknown) => Boot["surface"];
      suppressProactiveOpener: (threadRef: string) => void;
    };
    const surface = createChatSurface(ctx);
    return {
      vite,
      container: containerEl,
      surface,
      suppressProactiveOpener,
      composerState,
      events,
      openerTurns,
      focusCount: () => focusCount,
      storedDraft,
    };
  } catch (err) {
    await vite.close();
    throw err;
  }
}

function cardTitles(root: ParentNode): string[] {
  return [...root.querySelectorAll(".home-card-title")].map((el) => el.textContent ?? "");
}

test("welcome area renders from config; cards fill without sending; shuffle rotates", async () => {
  const config = homeConfigFixture(false);
  const harness = await boot({
    home: () => Response.json(config),
  });
  try {
    harness.surface.mountContinuable("web:u@t:a1", null, null, []);
    await settle();
    assert.equal(harness.surface.state.agent?.state.messages.length, 0);
    assert.equal(harness.openerTurns.length, 0, "disabled opener never submits a turn");

    const host = harness.container.querySelector(".custom-chat")!;
    assert.ok(host.querySelector(".home-welcome"), "welcome area renders");
    assert.equal(host.querySelector(".home-headline")?.textContent, "今天要办什么？");
    assert.ok(host.querySelector(".home-subline"));

    const tabs = [...host.querySelectorAll<HTMLButtonElement>(".home-tab")];
    assert.deepEqual(
      tabs.map((t) => t.textContent?.trim()),
      ["业务人员", "团队负责人"],
    );
    assert.equal(tabs.filter((t) => t.classList.contains("on")).length, 1);

    const dateKey = dateKeyOf(new Date());
    const pool = roleOneTipsOf(config);
    const firstPage = pickDaily(pool, "u@t", dateKey, 3, 0).map((t) => t.title);
    assert.deepEqual(cardTitles(host), firstPage);
    assert.ok(!firstPage.includes("停用卡"), "deferred tips never render");
    assert.ok(!firstPage.includes("未收录卡"), "unsupported tips never render");

    host.querySelector<HTMLButtonElement>(".home-shuffle")!.click();
    await settle(2);
    assert.deepEqual(
      cardTitles(host),
      pickDaily(pool, "u@t", dateKey, 3, 3).map((t) => t.title),
    );
    assert.notDeepEqual(cardTitles(host), firstPage);

    tabs[1]!.click();
    await settle(2);
    const roleTwo = config.tips.filter((t) => t.id === "W05" || t.id === "W13");
    assert.deepEqual(
      cardTitles(host),
      pickDaily(roleTwo, "u@t", dateKey, 3).map((t) => t.title),
    );
    assert.ok(!host.querySelector(".home-shuffle"));
    tabs[0]!.click();
    await settle(2);
    assert.deepEqual(cardTitles(host), firstPage, "role switch resets rotation deterministically");

    const card = host.querySelector<HTMLButtonElement>(".home-card")!;
    const expectedTip = pickDaily(pool, "u@t", dateKey, 3, 0)[0]!;
    card.click();
    await settle(2);
    assert.equal(harness.composerState.draft, "", "preview leaves the composer untouched");
    assert.equal(harness.openerTurns.length, 0);
    const dialog = host.querySelector<HTMLDialogElement>(".scenario-card-dialog")!;
    assert.equal(dialog.open, true);
    dialog.querySelector("form")!.dispatchEvent(new SubmitEvent("submit", { bubbles: true, cancelable: true }));
    await settle(2);
    assert.equal(harness.composerState.draft, expectedTip.prompt);
    assert.equal(host.querySelector<HTMLTextAreaElement>(".composer-input")?.value, expectedTip.prompt);
    assert.ok(harness.focusCount() > 0, "composer focused after confirming a scene");
    assert.deepEqual(harness.events, [{ type: "example_card_click", ref: expectedTip.id }]);
    assert.equal(harness.openerTurns.length, 0, "card click must never send");
    assert.equal(harness.storedDraft("web:u@t:a1"), expectedTip.prompt);
    assert.ok(!host.querySelector(".home-trio"), "the legacy trio is retired");
  } finally {
    harness.container.remove();
    await harness.vite.close();
  }
});

test("returning users with an empty new chat get the daily scenario cards", async () => {
  const config = homeConfigFixture(false);
  const harness = await boot({
    home: () => Response.json(config),
    sessions: [{ id: "s1", threadRef: "web:u@t:old" }],
  });
  try {
    harness.surface.mountContinuable("web:u@t:b1", null, null, []);
    await settle();
    const host = harness.container.querySelector(".custom-chat")!;
    assert.ok(!host.querySelector(".home-welcome"), "returning user does not get the first-run welcome");
    assert.ok(!host.querySelector(".welcome-greeting"));
    const grid = host.querySelector(".home-cards.scenario");
    assert.ok(grid, "scenario card grid renders");
    const expected = scenarioCards({ ...config, tips: activeTipsOf(config) }, "u@t", dateKeyOf(new Date()), 3).map(
      (t) => t.title,
    );
    assert.deepEqual(cardTitles(host), expected);

    const card = grid!.querySelector<HTMLButtonElement>(".home-card")!;
    const expectedTip = scenarioCards({ ...config, tips: activeTipsOf(config) }, "u@t", dateKeyOf(new Date()), 3)[0]!;
    card.click();
    await settle(2);
    assert.equal(harness.composerState.draft, "", "preview leaves the composer untouched");
    assert.equal(harness.openerTurns.length, 0);
    const dialog = host.querySelector<HTMLDialogElement>(".scenario-card-dialog")!;
    assert.equal(dialog.open, true);
    dialog.querySelector("form")!.dispatchEvent(new SubmitEvent("submit", { bubbles: true, cancelable: true }));
    await settle(2);
    assert.equal(harness.composerState.draft, expectedTip.prompt);
    assert.deepEqual(harness.events, [{ type: "example_card_click", ref: expectedTip.id }]);
    assert.equal(harness.openerTurns.length, 0);
  } finally {
    harness.container.remove();
    await harness.vite.close();
  }
});

test("opener still starts when config enables it", async () => {
  const config = homeConfigFixture(true);
  const harness = await boot({ home: () => Response.json(config) });
  try {
    harness.surface.mountContinuable("web:u@t:c1", null, null, []);
    await settle();
    assert.equal(harness.openerTurns.length, 1, "upstream default opener submits its turn");
    assert.deepEqual(
      (({ route, threadRef }) => ({ route, threadRef }))(
        harness.openerTurns[0] as { route: string; threadRef: string },
      ),
      { route: "/api/proactive-opener", threadRef: "web:u@t:c1" },
    );
  } finally {
    harness.container.remove();
    await harness.vite.close();
  }
});

test("a dedicated growth chat suppresses the home opener", async () => {
  const config = homeConfigFixture(true);
  const harness = await boot({ home: () => Response.json(config) });
  try {
    harness.suppressProactiveOpener("web:u@t:growth");
    harness.surface.mountContinuable("web:u@t:growth", null, null, []);
    await settle();
    assert.equal(harness.openerTurns.length, 0);
    assert.equal(harness.surface.state.agent?.state.messages.length, 0);
  } finally {
    harness.container.remove();
    await harness.vite.close();
  }
});

test("without a config endpoint the legacy greeting and opener stay exactly as before", async () => {
  let releaseHome!: () => void;
  const gate = new Promise<void>((resolve) => {
    releaseHome = resolve;
  });
  const harness = await boot({
    home: () => gate.then(() => Response.json({}, { status: 404 })),
  });
  try {
    harness.surface.mountContinuable("web:u@t:d1", null, null, []);
    await settle(3);
    assert.ok(harness.container.querySelector(".welcome-greeting"), "legacy greeting shows while config is in flight");
    assert.equal(harness.openerTurns.length, 0);
    releaseHome();
    await settle();
    assert.equal(harness.openerTurns.length, 1, "opener starts once the config resolves to null");
    assert.equal((harness.openerTurns[0] as { route: string }).route, "/api/proactive-opener");
    assert.ok(!harness.container.querySelector(".home-welcome"));
    assert.ok(!harness.container.querySelector(".home-cards"));
  } finally {
    harness.container.remove();
    await harness.vite.close();
  }
});

test("the retired home progress and trio surfaces are absent", async () => {
  const config = homeConfigFixture(false);
  const harness = await boot({ home: () => Response.json(config) });
  try {
    harness.surface.mountContinuable("web:u@t:e1", null, null, []);
    await settle();
    const host = harness.container.querySelector(".custom-chat")!;
    assert.ok(host.querySelector(".home-welcome"));
    assert.ok(!host.querySelector(".home-trio"));
  } finally {
    harness.container.remove();
    await harness.vite.close();
  }
});

test("the welcome area stays focused on scenarios after the trio retirement", async () => {
  const config = homeConfigFixture(false);
  const harness = await boot({ home: () => Response.json(config) });
  try {
    harness.surface.mountContinuable("web:u@t:f1", null, null, []);
    await settle();
    const host = harness.container.querySelector(".custom-chat")!;
    assert.ok(host.querySelector(".home-welcome"));
    assert.ok(host.querySelector(".home-cards"));
    assert.ok(!host.querySelector(".home-trio"));
  } finally {
    harness.container.remove();
    await harness.vite.close();
  }
});

test("home launch keeps errors visible and switches to the transcript after the first message", async () => {
  const harness = await boot({ home: () => Response.json(homeConfigFixture(false)) });
  try {
    harness.surface.mountContinuable("web:u@t:launch", null, null, []);
    await settle();
    const host = harness.container;
    assert.ok(host.querySelector(".home-launch .composer-input"));
    assert.equal(host.querySelectorAll(".home-headline").length, 1);
    assert.equal(host.querySelector(".home-subline")?.textContent, homeConfigFixture(false).welcome.subline);
    const agent = harness.surface.state.agent!;
    agent.state.errorMessage = "连接暂时中断，请重试";
    harness.surface.redraw();
    assert.equal(host.querySelector('.home-launch [role="alert"]')?.textContent, "连接暂时中断，请重试");
    agent.state.errorMessage = undefined;
    agent.state.messages = [{ role: "user", content: "整理会议记录", timestamp: Date.now() }];
    harness.composerState.draft = "补充要求";
    harness.surface.redraw();
    assert.equal(host.querySelector(".home-launch"), null);
    assert.ok(host.querySelector(".chat-scroll"));
    assert.equal(host.querySelectorAll(".composer-input").length, 1);
    assert.equal(host.querySelector<HTMLTextAreaElement>(".composer-input")!.value, "补充要求");
  } finally {
    await harness.vite.close();
  }
});

test("empty compact panes retain the transcript and bottom composer", async () => {
  const harness = await boot({ home: () => Response.json(homeConfigFixture(false)), pane: true });
  try {
    harness.surface.mountContinuable("web:u@t:pane", null, null, []);
    await settle();
    assert.equal(harness.container.querySelector(".home-launch"), null);
    assert.ok(harness.container.querySelector(".chat-scroll"));
    assert.equal(harness.container.querySelectorAll(".composer-input").length, 1);
  } finally {
    await harness.vite.close();
  }
});
