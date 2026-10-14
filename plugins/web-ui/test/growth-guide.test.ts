import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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
  getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
};
for (const [key, value] of Object.entries(globals))
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 10));
  await new Promise((resolve) => setImmediate(resolve));
}

async function withGuide(): Promise<{
  vite: ViteDevServer;
  guide: typeof import("../src/guide.ts");
  growth: typeof import("../src/growth.ts");
}> {
  const vite = await createServer({
    server: { middlewareMode: true, hmr: false, ws: false },
    optimizeDeps: { noDiscovery: true },
    appType: "custom",
  });
  const guide = (await vite.ssrLoadModule(
    `/src/guide.ts?preferences=${Date.now()}`,
  )) as typeof import("../src/guide.ts");
  const growth = (await vite.ssrLoadModule("/src/growth.ts")) as typeof import("../src/growth.ts");
  return { vite, guide, growth };
}

test("preference edits survive a growth refresh until they are saved", async () => {
  const originalFetch = globalThis.fetch;
  const snapshot = {
    points: 100,
    level: "上手达人",
    nextLevelAt: 150,
    badges: [],
    onboarding: {
      key: "onboarding-v1",
      kind: "onboarding",
      title: "首关",
      description: "完成一项真实工作",
      prompt: "请处理这项工作",
      revisionPrompt: "请修改成果",
      steps: ["目标", "材料", "生成", "修改", "验收"],
      firstPoints: 30,
      revisionPoints: 20,
      participation: null,
      sessionId: null,
      evidence: null,
      status: "available",
    },
    daily: null,
    preferences: { enabled: false, time: "09:30", timeZone: "Asia/Shanghai" },
    reminder: null,
    history: [],
    date: "2026-09-05",
  };
  globalThis.fetch = (async () => Response.json(snapshot)) as typeof fetch;
  const { vite, guide, growth } = await withGuide();
  try {
    const config = {
      welcome: { headline: "今天要办什么？", subline: "", roles: [] },
      composerPlaceholder: "",
      tips: [],
      nav: { advancedGroup: [] },
      opener: { enabled: false },
    };
    const mount = document.createElement("main");
    document.body.appendChild(mount);
    guide.renderGuidePage(config, mount, {});
    await settle();
    const time = mount.querySelector<HTMLInputElement>('input[name="time"]');
    const enabled = mount.querySelector<HTMLInputElement>('input[name="enabled"]');
    assert.ok(time);
    assert.ok(enabled);
    const progress = mount.querySelector<HTMLElement>('[role="progressbar"]');
    assert.ok(progress);
    assert.equal(progress.getAttribute("aria-label"), "Growth points progress");
    assert.equal(progress.getAttribute("aria-valuemin"), "50");
    assert.equal(progress.getAttribute("aria-valuemax"), "150");
    time.value = "10:45";
    time.dispatchEvent(new Event("input", { bubbles: true }));
    enabled.checked = true;
    enabled.dispatchEvent(new Event("change", { bubbles: true }));
    await growth.refreshGrowthSnapshot();
    await settle();
    assert.equal(time.value, "10:45");
    assert.equal(enabled.checked, true);
    assert.match(mount.querySelector(".growth-preferences summary")?.textContent ?? "", /Unsaved/);
  } finally {
    globalThis.fetch = originalFetch;
    await vite.close();
  }
});

test("a preference edit made during save remains an unsaved draft", async () => {
  const originalFetch = globalThis.fetch;
  let releaseSave!: (response: Response) => void;
  let saveStarted!: () => void;
  let postCount = 0;
  const saveGate = new Promise<Response>((resolve) => (releaseSave = resolve));
  const started = new Promise<void>((resolve) => (saveStarted = resolve));
  const snapshot = {
    points: 100,
    level: "上手达人",
    nextLevelAt: 150,
    badges: [],
    onboarding: {
      key: "onboarding-v1",
      kind: "onboarding",
      title: "首关",
      description: "完成一项真实工作",
      prompt: "请处理这项工作",
      revisionPrompt: "请修改成果",
      steps: ["目标", "材料", "生成", "修改", "验收"],
      firstPoints: 30,
      revisionPoints: 20,
      participation: null,
      sessionId: null,
      evidence: null,
      status: "available",
    },
    daily: null,
    preferences: { enabled: false, time: "09:30", timeZone: "Asia/Shanghai" },
    reminder: null,
    history: [],
    date: "2026-09-05",
  };
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === "POST") {
      postCount += 1;
      saveStarted();
      return saveGate;
    }
    return Response.json(snapshot);
  }) as typeof fetch;
  const { vite, guide } = await withGuide();
  try {
    const config = {
      welcome: { headline: "今天要办什么？", subline: "", roles: [] },
      composerPlaceholder: "",
      tips: [],
      nav: { advancedGroup: [] },
      opener: { enabled: false },
    };
    const mount = document.createElement("main");
    document.body.appendChild(mount);
    guide.renderGuidePage(config, mount, {});
    await settle();
    const form = mount.querySelector<HTMLFormElement>(".growth-preferences form");
    const time = mount.querySelector<HTMLInputElement>('input[name="time"]');
    const enabled = mount.querySelector<HTMLInputElement>('input[name="enabled"]');
    assert.ok(form);
    assert.ok(time);
    assert.ok(enabled);
    time.value = "10:45";
    time.dispatchEvent(new Event("input", { bubbles: true }));
    enabled.checked = true;
    enabled.dispatchEvent(new Event("change", { bubbles: true }));
    form.dispatchEvent(new SubmitEvent("submit", { bubbles: true, cancelable: true }));
    await started;
    const editedDuringSave = mount.querySelector<HTMLInputElement>('input[name="time"]');
    assert.ok(editedDuringSave);
    editedDuringSave.value = "11:00";
    editedDuringSave.dispatchEvent(new Event("input", { bubbles: true }));
    releaseSave(
      Response.json({ ...snapshot, preferences: { enabled: true, time: "10:45", timeZone: "Asia/Shanghai" } }),
    );
    await settle();
    assert.equal(postCount, 1);
    assert.equal(mount.querySelector<HTMLInputElement>('input[name="time"]')?.value, "11:00");
    assert.match(mount.querySelector(".growth-preferences summary")?.textContent ?? "", /Unsaved/);
  } finally {
    globalThis.fetch = originalFetch;
    await vite.close();
  }
});

test("completed evidence has no claim-points action", async () => {
  const originalFetch = globalThis.fetch;
  const snapshot = {
    points: 50,
    level: "上手达人",
    nextLevelAt: 150,
    badges: ["首份成果"],
    onboarding: {
      key: "onboarding-v1",
      kind: "onboarding",
      title: "首关",
      description: "完成一项真实工作",
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
        firstRunId: "run-first",
        firstHash: "hash-first",
        firstAcceptedAt: Date.now() - 1000,
        completedAt: Date.now(),
      },
      sessionId: "session-growth",
      evidence: {
        runId: "run-final",
        text: '<img src=x onerror="window.__growthPwned=1"><script>window.__growthPwned=1</script>',
        hash: "hash-final",
        finishedAt: Date.now(),
      },
      status: "complete",
    },
    daily: null,
    preferences: { enabled: false, time: "09:30", timeZone: "Asia/Shanghai" },
    reminder: null,
    history: [],
    date: "2026-09-05",
  };
  globalThis.fetch = (async () => Response.json(snapshot)) as typeof fetch;
  const { vite, guide } = await withGuide();
  try {
    const config = {
      welcome: { headline: "今天要办什么？", subline: "", roles: [] },
      composerPlaceholder: "",
      tips: [],
      nav: { advancedGroup: [] },
      opener: { enabled: false },
    };
    const mount = document.createElement("main");
    document.body.appendChild(mount);
    guide.renderGuidePage(config, mount, {});
    await settle();
    assert.equal(mount.querySelector(".growth-evidence .growth-button.primary"), null);
    assert.doesNotMatch(mount.querySelector(".growth-evidence")?.textContent ?? "", /claim your points/);
    assert.equal(mount.querySelector(".growth-evidence-body script"), null);
    assert.equal(mount.querySelector(".growth-evidence-body [onerror]"), null);
  } finally {
    globalThis.fetch = originalFetch;
    await vite.close();
  }
});

test("growth CSS keeps touch targets usable and removes the retired run id", () => {
  const css = readFileSync(new URL("../src/growth.css", import.meta.url), "utf8");
  assert.doesNotMatch(css, /growth-run-id/);
  assert.match(css, /\.growth-button,\n\s+\.growth-skip[\s\S]*?min-height: 44px/);
  assert.match(css, /\.growth-refresh[\s\S]*?width: 44px;[\s\S]*?height: 44px;/);
});

test("leaving the guide while start is pending prevents prepare and chat navigation", async () => {
  const originalFetch = globalThis.fetch;
  let releaseStart!: (response: Response) => void;
  let startStarted!: () => void;
  let postCalls = 0;
  const startGate = new Promise<Response>((resolve) => (releaseStart = resolve));
  const started = new Promise<void>((resolve) => (startStarted = resolve));
  const snapshot = {
    points: 0,
    level: "新手上路",
    nextLevelAt: 50,
    badges: [],
    onboarding: {
      key: "onboarding-v1",
      kind: "onboarding",
      title: "首关",
      description: "完成一项真实工作",
      prompt: "请处理这项工作",
      revisionPrompt: "请修改成果",
      steps: ["目标", "材料", "生成", "修改", "验收"],
      firstPoints: 30,
      revisionPoints: 20,
      participation: null,
      sessionId: null,
      evidence: null,
      status: "available",
    },
    daily: null,
    preferences: { enabled: false, time: "09:30", timeZone: "Asia/Shanghai" },
    reminder: null,
    history: [],
    date: "2026-09-05",
  };
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === "POST") {
      postCalls += 1;
      if (postCalls === 1) {
        startStarted();
        return startGate;
      }
      return Response.json(snapshot);
    }
    return Response.json(snapshot);
  }) as typeof fetch;
  const { vite, guide } = await withGuide();
  try {
    const config = {
      welcome: { headline: "今天要办什么？", subline: "", roles: [] },
      composerPlaceholder: "",
      tips: [],
      nav: { advancedGroup: [] },
      opener: { enabled: false },
    };
    const mount = document.createElement("main");
    document.body.appendChild(mount);
    let opened = 0;
    guide.renderGuidePage(config, mount, { openGrowthChat: () => void opened++ });
    await settle();
    const startButton = mount.querySelector<HTMLButtonElement>(".growth-task-stage .growth-button.primary");
    assert.ok(startButton);
    startButton.click();
    await started;
    mount.replaceChildren();
    releaseStart(Response.json(snapshot));
    await settle();
    assert.equal(postCalls, 1);
    assert.equal(opened, 0);
  } finally {
    globalThis.fetch = originalFetch;
    await vite.close();
  }
});

test("leaving the guide while prepare is pending prevents chat navigation", async () => {
  const originalFetch = globalThis.fetch;
  let releasePrepare!: (response: Response) => void;
  let prepareStarted!: () => void;
  let postCalls = 0;
  const prepareGate = new Promise<Response>((resolve) => (releasePrepare = resolve));
  const started = new Promise<void>((resolve) => (prepareStarted = resolve));
  const snapshot = {
    points: 0,
    level: "新手上路",
    nextLevelAt: 50,
    badges: [],
    onboarding: {
      key: "onboarding-v1",
      kind: "onboarding",
      title: "首关",
      description: "完成一项真实工作",
      prompt: "请处理这项工作",
      revisionPrompt: "请修改成果",
      steps: ["目标", "材料", "生成", "修改", "验收"],
      firstPoints: 30,
      revisionPoints: 20,
      participation: {
        task: {} as never,
        threadRef: "web:u@t:growth-prepare",
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
    daily: null,
    preferences: { enabled: false, time: "09:30", timeZone: "Asia/Shanghai" },
    reminder: null,
    history: [],
    date: "2026-09-05",
  };
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === "POST") {
      postCalls += 1;
      prepareStarted();
      return prepareGate;
    }
    return Response.json(snapshot);
  }) as typeof fetch;
  const { vite, guide } = await withGuide();
  try {
    const config = {
      welcome: { headline: "今天要办什么？", subline: "", roles: [] },
      composerPlaceholder: "",
      tips: [],
      nav: { advancedGroup: [] },
      opener: { enabled: false },
    };
    const mount = document.createElement("main");
    document.body.appendChild(mount);
    let opened = 0;
    guide.renderGuidePage(config, mount, { openGrowthChat: () => void opened++ });
    await settle();
    const prepareButton = mount.querySelector<HTMLButtonElement>(".growth-materials .growth-button.primary");
    assert.ok(prepareButton);
    prepareButton.click();
    await started;
    mount.replaceChildren();
    releasePrepare(Response.json(snapshot));
    await settle();
    assert.equal(postCalls, 1);
    assert.equal(opened, 0);
  } finally {
    globalThis.fetch = originalFetch;
    await vite.close();
  }
});

after(() => dom.window.close());
