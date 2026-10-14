import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { JSDOM } from "jsdom";
import { createServer, type ViteDevServer } from "vite";
import type { ScenarioCategoryFilter } from "../src/scenario-cards.ts";
import type { HomeTip, WebuiHomeConfig } from "../src/home-config.ts";

const dom = new JSDOM('<!doctype html><div id="app"></div>');
const dialogPrototype = dom.window.HTMLDialogElement.prototype;
Object.defineProperty(dialogPrototype, "showModal", {
  configurable: true,
  value(this: HTMLDialogElement) {
    this.setAttribute("open", "");
  },
});
Object.defineProperty(dialogPrototype, "close", {
  configurable: true,
  value(this: HTMLDialogElement) {
    this.removeAttribute("open");
  },
});

const globals: Record<string, unknown> = {
  window: dom.window,
  document: dom.window.document,
  HTMLElement: dom.window.HTMLElement,
  HTMLDialogElement: dom.window.HTMLDialogElement,
  HTMLFormElement: dom.window.HTMLFormElement,
  HTMLTextAreaElement: dom.window.HTMLTextAreaElement,
  Node: dom.window.Node,
  Element: dom.window.Element,
  SVGElement: dom.window.SVGElement,
  Text: dom.window.Text,
  Comment: dom.window.Comment,
  DocumentFragment: dom.window.DocumentFragment,
  Event: dom.window.Event,
  CustomEvent: dom.window.CustomEvent,
  MutationObserver: dom.window.MutationObserver,
  queueMicrotask,
};
for (const [key, value] of Object.entries(globals))
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });

let vite: ViteDevServer;
let scenarioCardsModule: typeof import("../src/scenario-cards.ts");
let litModule: typeof import("lit");
before(async () => {
  litModule = await import("lit");
  vite = await createServer({ server: { middlewareMode: true, hmr: false, ws: false }, appType: "custom" });
  scenarioCardsModule = (await vite.ssrLoadModule(
    "/src/scenario-cards.ts",
  )) as typeof import("../src/scenario-cards.ts");
});
after(async () => {
  await vite.close();
});

function tip(
  id: string,
  title: string,
  capability: string,
  layer: HomeTip["layer"] = "task",
  status: HomeTip["status"] = "active",
  oneLiner = `说明 ${id}`,
): HomeTip {
  return {
    id,
    layer,
    title,
    oneLiner,
    prompt: `提示词 ${id}`,
    capability,
    depts: [],
    status,
  };
}

const config: WebuiHomeConfig = {
  welcome: { headline: "", subline: "", roles: [] },
  composerPlaceholder: "",
  nav: { advancedGroup: [] },
  opener: { enabled: false },
  tips: [
    tip("doc", "会议纪要", "office-docs"),
    tip("sheet", "表格变图表", "office-docs"),
    tip("formula", "Excel 公式", "通用"),
    tip("ppt", "周报 PPT", "ppt-master", "task", "active", "表格数据整理成汇报页面"),
    tip("flow", "画一张流程图", "drawio"),
    tip("project", "项目小组", "项目", "collab"),
    tip("mention", "同事协作", "@提及", "collab"),
    tip("extra", "随手问问", "通用", "icebreak"),
    tip("hidden", "不显示", "通用", "task", "deferred"),
  ],
};

test("scenario categories are office oriented and visual kinds stay abstract", () => {
  assert.equal(scenarioCardsModule.scenarioCategory(config.tips[0]!), "document");
  assert.equal(scenarioCardsModule.scenarioCategory(config.tips[1]!), "data");
  assert.equal(scenarioCardsModule.scenarioCategory(config.tips[3]!), "presentation");
  assert.equal(scenarioCardsModule.scenarioCategory(config.tips[4]!), "collaboration");
  assert.equal(scenarioCardsModule.scenarioCategory(config.tips[5]!), "collaboration");
  assert.equal(scenarioCardsModule.scenarioVisualKind(config.tips[5]!), "flow");
  assert.equal(scenarioCardsModule.scenarioCategory(config.tips[7]!), "more");
  assert.equal(scenarioCardsModule.scenarioCategoryLabel("document"), "Documents");
  assert.equal(scenarioCardsModule.scenarioVisualKind(config.tips[0]!), "paper");
  assert.equal(scenarioCardsModule.scenarioVisualKind(config.tips[1]!), "table");
  assert.equal(scenarioCardsModule.scenarioVisualKind(config.tips[4]!), "flow");
  assert.equal(scenarioCardsModule.scenarioVisualKind(config.tips[3]!), "slides");
  assert.equal(scenarioCardsModule.scenarioVisualKind(config.tips[6]!), "chat");
  assert.equal(scenarioCardsModule.scenarioVisualKind(tip("files", "部门文档库", "部门文档", "collab")), "paper");
});

test("scenario page rotates three active cards and filters by clickable categories", () => {
  const first = scenarioCardsModule.scenarioCardPage(config, "u@t", "2026-09-05", 3, 0);
  const second = scenarioCardsModule.scenarioCardPage(config, "u@t", "2026-09-05", 3, 1);
  assert.equal(first.length, 3);
  assert.equal(second.length, 3);
  assert.ok(first.every((item) => item.status === "active"));
  assert.notDeepEqual(
    first.map((item) => item.id),
    second.map((item) => item.id),
    "换一批应改变精选卡片",
  );
  assert.equal(scenarioCardsModule.scenarioCardPageHasMore(config, 3), true);
  const data = scenarioCardsModule.scenarioCardPage(config, "u@t", "2026-09-05", 3, 0, "data");
  assert.ok(data.length > 0);
  assert.ok(data.every((item) => scenarioCardsModule.scenarioCategory(item) === "data"));
  assert.equal(scenarioCardsModule.nextScenarioCardOffset(0, config), 3);

  const root = document.createElement("div");
  let selected: ScenarioCategoryFilter = "all";
  litModule.render(
    scenarioCardsModule.scenarioCategoryChips(config.tips, selected, (filter) => (selected = filter)),
    root,
  );
  const dataChip = [...root.querySelectorAll<HTMLButtonElement>(".scenario-chip")].find(
    (button) => button.textContent?.trim() === "Spreadsheets",
  );
  assert.ok(dataChip);
  dataChip!.click();
  assert.equal(selected, "data");
});

test("scenario card opens one native dialog and appends an edited prompt after confirmation", async () => {
  const root = document.createElement("div");
  document.body.append(root);
  let usedItemId: string | null = null;
  let usedPrompt: string | null = null;
  const controller = scenarioCardsModule.createScenarioCardController({
    existingDraft: () => "已有草稿",
    onUse: (item, prompt) => {
      usedItemId = item.id;
      usedPrompt = prompt;
    },
  });
  const item = config.tips[0]!;
  litModule.render(litModule.html`<article>${controller.card(item)}${controller.dialog()}</article>`, root);

  const card = root.querySelector<HTMLButtonElement>(".scenario-card")!;
  const dialog = root.querySelector<HTMLDialogElement>(".scenario-card-dialog")!;
  card.click();
  await Promise.resolve();
  assert.equal(dialog.open, true);
  assert.equal(root.querySelector(".scenario-dialog-title")?.textContent, item.title);
  assert.equal(root.querySelector<HTMLTextAreaElement>(".scenario-dialog-prompt")?.value, item.prompt);
  assert.equal(usedItemId, null, "打开卡片不能自动使用或发送");

  const textarea = root.querySelector<HTMLTextAreaElement>(".scenario-dialog-prompt")!;
  textarea.value = "补充范围";
  root
    .querySelector<HTMLFormElement>(".scenario-dialog-form")!
    .dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));
  assert.equal(usedItemId, item.id);
  assert.equal(usedPrompt, "已有草稿\n\n补充范围");
  assert.equal(dialog.open, false);
  root.remove();
});

test("scenario dialog ids are unique for separate conversation controllers", () => {
  const firstRoot = document.createElement("div");
  const secondRoot = document.createElement("div");
  const first = scenarioCardsModule.createScenarioCardController({ existingDraft: () => "", onUse: () => {} });
  const second = scenarioCardsModule.createScenarioCardController({ existingDraft: () => "", onUse: () => {} });
  litModule.render(litModule.html`<article>${first.dialog()}</article>`, firstRoot);
  litModule.render(litModule.html`<article>${second.dialog()}</article>`, secondRoot);
  assert.notEqual(firstRoot.querySelector("dialog")?.id, secondRoot.querySelector("dialog")?.id);
});

test("scenario dialog survives a redraw and resets its prompt when reopened", async () => {
  const root = document.createElement("div");
  document.body.append(root);
  const controller = scenarioCardsModule.createScenarioCardController({ existingDraft: () => "", onUse: () => {} });
  const item = config.tips[0]!;
  const renderView = () =>
    litModule.render(litModule.html`<article>${controller.card(item)}${controller.dialog()}</article>`, root);

  try {
    renderView();
    const card = root.querySelector<HTMLButtonElement>(".scenario-card")!;
    card.click();
    await Promise.resolve();
    const dialog = root.querySelector<HTMLDialogElement>(".scenario-card-dialog")!;
    const textarea = root.querySelector<HTMLTextAreaElement>(".scenario-dialog-prompt")!;
    textarea.value = "编辑后的内容";

    renderView();
    await Promise.resolve();
    assert.equal(dialog.open, true);
    assert.equal(textarea.value, "编辑后的内容");

    root.querySelector<HTMLButtonElement>(".scenario-dialog-close")!.click();
    card.click();
    await Promise.resolve();
    assert.equal(dialog.open, true);
    assert.equal(textarea.value, item.prompt);
  } finally {
    root.remove();
  }
});

test("featured artwork stays bound to scene IDs and six cards cycle in complete pages", () => {
  const ids = ["W01", "W11", "W25", "W05", "W09", "W13"];
  const artwork: Record<string, string> = {
    W01: "presentation",
    W11: "tender",
    W25: "product",
    W05: "progress",
    W09: "review",
    W13: "acceptance",
  };
  const source = { ...config, tips: [...config.tips, ...ids.map((id) => tip(id, id, "通用"))] };
  const featured = scenarioCardsModule.featuredHomeConfig(source);
  assert.deepEqual(
    featured.tips.map((item) => item.id),
    ids,
  );
  assert.equal(source.tips.length, config.tips.length + 6);
  const first = scenarioCardsModule.scenarioCardPage(featured, "u", "2026-09-12");
  const offset = scenarioCardsModule.nextScenarioCardOffset(0, featured);
  const second = scenarioCardsModule.scenarioCardPage(featured, "u", "2026-09-12", 3, offset);
  assert.equal(new Set([...first, ...second].map((item) => item.id)).size, 6);
  assert.equal(scenarioCardsModule.nextScenarioCardOffset(offset, featured), 0);
  const controller = scenarioCardsModule.createScenarioCardController({ existingDraft: () => "", onUse: () => {} });
  for (const item of featured.tips) {
    const root = document.createElement("div");
    litModule.render(controller.card(item), root);
    assert.ok(root.querySelector("img")?.getAttribute("src")?.includes(`${artwork[item.id]}.webp`));
  }
});
