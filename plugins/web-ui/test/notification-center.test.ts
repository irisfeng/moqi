import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { createNotificationCenter, type MessageNotification } from "../src/notification-center.ts";

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
test("notification center preserves unread on failed navigation and acknowledges only successful opens", async () => {
  const dom = new JSDOM("<!doctype html><body><div id='slot'></div></body>", { pretendToBeVisual: true });
  const originals = ["window", "document"].map(
    (key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const,
  );
  Object.defineProperty(globalThis, "window", { configurable: true, value: dom.window });
  Object.defineProperty(globalThis, "document", { configurable: true, value: dom.window.document });
  const item: MessageNotification = {
    id: "entry:one:1",
    sessionId: "one",
    threadRef: "thread",
    title: "测试项目",
    at: Date.now(),
    kind: "message",
    unreadCount: 1,
    seq: 1,
  };
  let unread = true;
  let succeeds = false;
  const reads: string[] = [];
  const center = createNotificationCenter({
    async load() {
      return { items: unread ? [item] : [], unreadCount: Number(unread), unreadThreads: Number(unread) };
    },
    preferences: {
      async load() {
        return { muteCompletions: false };
      },
      async save() {},
    },
    async readAll() {},
    async read(id) {
      reads.push(id);
      unread = false;
    },
    async navigate() {
      return succeeds;
    },
    visible() {
      return false;
    },
  });
  try {
    center.mount(dom.window.document.querySelector<HTMLElement>("#slot")!);
    await center.refresh();
    const trigger = dom.window.document.querySelector<HTMLButtonElement>(".notification-trigger")!;
    assert.match(trigger.getAttribute("aria-label")!, /1 unread/);
    trigger.click();
    await flush();
    dom.window.document.querySelector<HTMLButtonElement>(".notification-open")!.click();
    await flush();
    assert.deepEqual(reads, []);
    assert.equal(dom.window.document.querySelector<HTMLElement>(".notification-center")!.hidden, false);
    succeeds = true;
    dom.window.document.querySelector<HTMLButtonElement>(".notification-open")!.click();
    await flush();
    assert.deepEqual(reads, [item.id]);
    assert.match(trigger.getAttribute("aria-label")!, /0 unread/);
    assert.equal(dom.window.document.querySelector<HTMLElement>(".notification-center")!.hidden, true);
  } finally {
    center.dispose();
    dom.window.close();
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});

test("queued newer notifications retry after an older toast is dismissed", async () => {
  const dom = new JSDOM("<!doctype html><body></body>", { pretendToBeVisual: true });
  const originals = ["window", "document"].map(
    (key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const,
  );
  Object.defineProperty(globalThis, "window", { configurable: true, value: dom.window });
  Object.defineProperty(globalThis, "document", { configurable: true, value: dom.window.document });
  let item: MessageNotification = {
    id: "entry:one:1",
    sessionId: "one",
    threadRef: "thread",
    title: "项目",
    at: Date.now(),
    kind: "message",
    unreadCount: 1,
    runId: "first",
  };
  const opened: unknown[] = [];
  const center = createNotificationCenter({
    async load() {
      return { items: [item], unreadCount: 1, unreadThreads: 1 };
    },
    preferences: {
      async load() {
        return { muteCompletions: false };
      },
      async save() {},
    },
    async readAll() {},
    async read() {},
    async navigate(_thread, target) {
      opened.push(target.runId);
      return true;
    },
    visible() {
      return false;
    },
  });
  try {
    await center.refresh();
    item = { ...item, id: "entry:one:2", runId: "second" };
    await center.refresh();
    dom.window.document.querySelector<HTMLButtonElement>(".mention-toast-dismiss")!.click();
    await center.refresh();
    dom.window.document.querySelector<HTMLButtonElement>(".mention-toast-action")!.click();
    await flush();
    assert.deepEqual(opened, ["second"]);
  } finally {
    center.dispose();
    dom.window.close();
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});

test("pagination survives refresh and disposing during navigation never acknowledges another login", async () => {
  const dom = new JSDOM("<!doctype html><body><div id='slot'></div></body>", { pretendToBeVisual: true });
  const originals = ["window", "document"].map(
    (key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const,
  );
  Object.defineProperty(globalThis, "window", { configurable: true, value: dom.window });
  Object.defineProperty(globalThis, "document", { configurable: true, value: dom.window.document });
  const items: MessageNotification[] = ["one", "two"].map((id) => ({
    id,
    sessionId: id,
    threadRef: id,
    title: id,
    at: Date.now(),
    kind: "message",
    unreadCount: 1,
    runId: id,
  }));
  let finish: (opened: boolean) => void = () => {};
  let reads = 0;
  const center = createNotificationCenter({
    async load(cursor) {
      return {
        items: [items[cursor ? 1 : 0]!],
        unreadCount: 2,
        unreadThreads: 2,
        ...(cursor ? {} : { nextCursor: "next" }),
      };
    },
    preferences: {
      async load() {
        return { muteCompletions: false };
      },
      async save() {},
    },
    async readAll() {},
    async read() {
      reads++;
    },
    navigate() {
      return new Promise((resolve) => {
        finish = resolve;
      });
    },
    visible() {
      return false;
    },
  });
  try {
    center.mount(dom.window.document.querySelector<HTMLElement>("#slot")!);
    await center.refresh();
    dom.window.document.querySelector<HTMLButtonElement>(".notification-trigger")!.click();
    await flush();
    [...dom.window.document.querySelectorAll<HTMLButtonElement>("footer button")]
      .find((button) => button.textContent === "Load more")!
      .click();
    await flush();
    const first = dom.window.document.querySelector<HTMLButtonElement>(".notification-open")!;
    assert.equal(dom.window.document.querySelectorAll(".notification-item").length, 2);
    await center.refresh();
    assert.equal(dom.window.document.querySelectorAll(".notification-item").length, 2);
    assert.equal(dom.window.document.querySelector(".notification-open"), first);
    first.click();
    center.dispose();
    finish(true);
    await flush();
    assert.equal(reads, 0);
    assert.equal(dom.window.document.querySelector(".notification-center"), null);
    assert.equal(dom.window.document.querySelector(".mention-toast"), null);
  } finally {
    center.dispose();
    dom.window.close();
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});

test("the conversations with unread items are published to the list whenever they change", async () => {
  const dom = new JSDOM("<!doctype html><body><div id='slot'></div></body>", { pretendToBeVisual: true });
  const originals = ["window", "document"].map(
    (key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const,
  );
  Object.defineProperty(globalThis, "window", { configurable: true, value: dom.window });
  Object.defineProperty(globalThis, "document", { configurable: true, value: dom.window.document });
  const item: MessageNotification = {
    id: "entry:one:1",
    sessionId: "one",
    threadRef: "thread",
    title: "Project",
    at: Date.now(),
    kind: "message",
    unreadCount: 1,
    seq: 1,
  };
  let unread = true;
  let changes = 0;
  const center = createNotificationCenter({
    async load() {
      return { items: unread ? [item] : [], unreadCount: Number(unread), unreadThreads: Number(unread) };
    },
    preferences: {
      async load() {
        return { muteCompletions: false };
      },
      async save() {},
    },
    async readAll() {},
    async read() {
      unread = false;
    },
    async navigate() {
      return true;
    },
    visible() {
      return false;
    },
    changed() {
      changes += 1;
    },
  });
  try {
    center.mount(dom.window.document.querySelector<HTMLElement>("#slot")!);
    assert.deepEqual([...center.unreadThreads()], []);
    await center.refresh();
    assert.deepEqual([...center.unreadThreads()], ["thread"]);
    const afterFirst = changes;
    assert.ok(afterFirst > 0);
    await center.refresh();
    assert.equal(changes, afterFirst, "an unchanged page does not redraw the list");
    unread = false;
    await center.refresh();
    assert.deepEqual([...center.unreadThreads()], []);
    assert.ok(changes > afterFirst);
  } finally {
    center.dispose();
    dom.window.close();
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});

test("read rows stay in the list without counting, and mark all as read clears the rest", async () => {
  const dom = new JSDOM("<!doctype html><body><div id='slot'></div></body>", { pretendToBeVisual: true });
  const originals = ["window", "document"].map(
    (key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const,
  );
  Object.defineProperty(globalThis, "window", { configurable: true, value: dom.window });
  Object.defineProperty(globalThis, "document", { configurable: true, value: dom.window.document });
  const row = (id: string, kind: MessageNotification["kind"], unread: boolean): MessageNotification => ({
    id,
    sessionId: id,
    threadRef: `thread-${id}`,
    title: `Conversation ${id}`,
    at: Date.now(),
    kind,
    unread,
    unreadCount: Number(unread),
    seq: 1,
  });
  let cleared = false;
  let readAllCalls = 0;
  const center = createNotificationCenter({
    async load() {
      const items = [row("new", "done", !cleared), row("old", "mention", false)];
      return { items, unreadCount: cleared ? 0 : 1, unreadThreads: cleared ? 0 : 1 };
    },
    preferences: {
      async load() {
        return { muteCompletions: false };
      },
      async save() {},
    },
    async readAll() {
      readAllCalls += 1;
      cleared = true;
    },
    async read() {},
    async navigate() {
      return true;
    },
    visible() {
      return false;
    },
  });
  try {
    center.mount(dom.window.document.querySelector<HTMLElement>("#slot")!);
    await center.refresh();
    const trigger = dom.window.document.querySelector<HTMLButtonElement>(".notification-trigger")!;
    assert.match(trigger.getAttribute("aria-label")!, /1 unread/);
    assert.deepEqual([...center.unreadThreads()], ["thread-new"]);
    const rows = [...dom.window.document.querySelectorAll<HTMLElement>(".notification-item")];
    assert.deepEqual(
      rows.map((item) => item.classList.contains("read")),
      [false, true],
    );
    assert.equal(rows[0]!.querySelector(".notification-meta")!.textContent, "Task finished · 1 unread");
    assert.equal(rows[1]!.querySelector(".notification-meta")!.textContent, "Mentioned you");
    const readAll = dom.window.document.querySelector<HTMLButtonElement>(".notification-read-all")!;
    assert.equal(readAll.hidden, false);
    readAll.click();
    await flush();
    await center.refresh();
    assert.equal(readAllCalls, 1);
    assert.match(trigger.getAttribute("aria-label")!, /0 unread/);
    assert.equal(readAll.hidden, true);
    assert.deepEqual([...center.unreadThreads()], []);
    assert.equal(dom.window.document.querySelectorAll(".notification-item.read").length, 2);
  } finally {
    center.dispose();
    dom.window.close();
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});

test("muting task alerts stops their pop-ups, keeps them in the list and leaves mentions alone", async () => {
  const dom = new JSDOM("<!doctype html><body><div id='slot'></div></body>", { pretendToBeVisual: true });
  const originals = ["window", "document"].map(
    (key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const,
  );
  Object.defineProperty(globalThis, "window", { configurable: true, value: dom.window });
  Object.defineProperty(globalThis, "document", { configurable: true, value: dom.window.document });
  const row = (id: string, kind: MessageNotification["kind"]): MessageNotification => ({
    id,
    sessionId: id,
    threadRef: `thread-${id}`,
    title: `Conversation ${id}`,
    at: Date.now(),
    kind,
    unread: true,
    unreadCount: 1,
    seq: 1,
  });
  const saved: boolean[] = [];
  const center = createNotificationCenter({
    async load() {
      return { items: [row("task", "done"), row("named", "mention")], unreadCount: 2, unreadThreads: 2 };
    },
    preferences: {
      async load() {
        return { muteCompletions: false };
      },
      async save(preferences) {
        saved.push(preferences.muteCompletions);
      },
    },
    async readAll() {},
    async read() {},
    async navigate() {
      return true;
    },
    visible() {
      return false;
    },
  });
  try {
    center.mount(dom.window.document.querySelector<HTMLElement>("#slot")!);
    await center.refresh();
    const status = () => dom.window.document.querySelector<HTMLElement>(".mention-toast-status")!.textContent;
    const title = () => dom.window.document.querySelector<HTMLElement>(".mention-toast-title")!.textContent;
    assert.equal(status(), "1 more conversations");
    const mute = dom.window.document.querySelector<HTMLButtonElement>(".notification-mute")!;
    assert.equal(mute.getAttribute("aria-pressed"), "false");
    mute.click();
    await flush();
    assert.deepEqual(saved, [true]);
    assert.equal(mute.getAttribute("aria-pressed"), "true");
    assert.equal(title(), "Conversation named");
    assert.equal(status(), "");
    await center.refresh();
    assert.equal(title(), "Conversation named");
    assert.equal(status(), "", "a muted task does not come back as a pop-up");
    assert.equal(dom.window.document.querySelectorAll(".notification-item").length, 2, "history keeps both");
  } finally {
    center.dispose();
    dom.window.close();
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});

test("an announcement is listed without a pop-up, is never read just by being on screen, and is read when opened", async () => {
  const dom = new JSDOM("<!doctype html><body><div id='slot'></div></body>", { pretendToBeVisual: true });
  const originals = ["window", "document"].map(
    (key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const,
  );
  Object.defineProperty(globalThis, "window", { configurable: true, value: dom.window });
  Object.defineProperty(globalThis, "document", { configurable: true, value: dom.window.document });
  const notice: MessageNotification = {
    id: "announcement:a1",
    sessionId: "announcement:a1",
    threadRef: "announcement:a1",
    title: "Office closed Friday",
    at: Date.now(),
    kind: "announcement",
    unread: true,
    unreadCount: 1,
  };
  let unread = true;
  const reads: string[] = [];
  const opened: string[] = [];
  const center = createNotificationCenter({
    async load() {
      return { items: [{ ...notice, unread }], unreadCount: Number(unread), unreadThreads: Number(unread) };
    },
    preferences: {
      async load() {
        return { muteCompletions: false };
      },
      async save() {},
    },
    async readAll() {},
    async read(id) {
      reads.push(id);
      unread = false;
    },
    async navigate(threadRef) {
      opened.push(threadRef);
      return true;
    },
    visible() {
      return true;
    },
  });
  try {
    center.mount(dom.window.document.querySelector<HTMLElement>("#slot")!);
    await center.refresh();
    assert.deepEqual(reads, [], "being on screen never dismisses an announcement");
    assert.equal(dom.window.document.querySelector<HTMLElement>(".mention-toast")!.hidden, true);
    const trigger = dom.window.document.querySelector<HTMLButtonElement>(".notification-trigger")!;
    assert.match(trigger.getAttribute("aria-label")!, /1 unread/);
    trigger.click();
    await flush();
    const row = dom.window.document.querySelector<HTMLElement>(".notification-item")!;
    assert.equal(row.querySelector(".notification-meta")!.textContent, "Notice · 1 unread");
    row.querySelector<HTMLButtonElement>(".notification-open")!.click();
    await flush();
    await center.refresh();
    assert.deepEqual(opened, ["announcement:a1"]);
    assert.deepEqual(reads, ["announcement:a1"]);
    assert.match(trigger.getAttribute("aria-label")!, /0 unread/);
  } finally {
    center.dispose();
    dom.window.close();
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});

test("being added to a project raises a pop-up and a row, and opening it goes to the project and marks it read", async () => {
  const dom = new JSDOM("<!doctype html><body><div id='slot'></div></body>", { pretendToBeVisual: true });
  const originals = ["window", "document"].map(
    (key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const,
  );
  Object.defineProperty(globalThis, "window", { configurable: true, value: dom.window });
  Object.defineProperty(globalThis, "document", { configurable: true, value: dom.window.document });
  const added: MessageNotification = {
    id: "project-join:p1",
    sessionId: "project-join:p1",
    threadRef: "project-join:p1",
    title: "Launch",
    at: Date.now(),
    kind: "added",
    unread: true,
    unreadCount: 1,
    scopeId: "group:web-project-p1",
  };
  let unread = true;
  const reads: string[] = [];
  const opened: Array<[string, unknown]> = [];
  const center = createNotificationCenter({
    async load() {
      return { items: [{ ...added, unread }], unreadCount: Number(unread), unreadThreads: Number(unread) };
    },
    preferences: {
      async load() {
        return { muteCompletions: true };
      },
      async save() {},
    },
    async readAll() {},
    async read(id) {
      reads.push(id);
      unread = false;
    },
    async navigate(threadRef, target) {
      opened.push([threadRef, (target as { scopeId?: string }).scopeId]);
      return true;
    },
    visible() {
      return false;
    },
  });
  try {
    center.mount(dom.window.document.querySelector<HTMLElement>("#slot")!);
    await flush();
    await center.refresh();
    const toast = dom.window.document.querySelector<HTMLElement>(".mention-toast")!;
    assert.equal(toast.hidden, false, "muting task alerts does not mute being added to a project");
    assert.equal(toast.querySelector(".mention-toast-eyebrow")!.textContent, "Added to a project");
    const trigger = dom.window.document.querySelector<HTMLButtonElement>(".notification-trigger")!;
    trigger.click();
    await flush();
    const row = dom.window.document.querySelector<HTMLElement>(".notification-item")!;
    assert.equal(row.querySelector(".notification-meta")!.textContent, "Added to a project · 1 unread");
    row.querySelector<HTMLButtonElement>(".notification-open")!.click();
    await flush();
    await center.refresh();
    assert.deepEqual(opened, [["project-join:p1", "group:web-project-p1"]]);
    assert.deepEqual(reads, ["project-join:p1"]);
  } finally {
    center.dispose();
    dom.window.close();
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
