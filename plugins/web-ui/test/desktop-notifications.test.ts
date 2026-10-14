import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { createNotificationCenter, type MessageNotification } from "../src/notification-center.ts";

test("background reminders require opt-in, deduplicate across tabs and accounts, and never mark unread by dismissal", async () => {
  const dom = new JSDOM("<!doctype html><title>Moqi</title><body></body>", {
    url: "https://fixture.test",
    pretendToBeVisual: true,
  });
  let visibility = "visible";
  Object.defineProperty(dom.window.document, "visibilityState", { configurable: true, get: () => visibility });
  let requested = 0;
  let reads = 0;
  let unread = true;
  let navigation = false;
  let held = Promise.resolve();
  const deliveries: FakeNotification[] = [];
  class FakeNotification {
    static permission = "default";
    static async requestPermission() {
      requested++;
      return (this.permission = "granted");
    }
    onclick?: () => void;
    onclose?: () => void;
    closed = false;
    title: string;
    options: NotificationOptions;
    constructor(title: string, options: NotificationOptions) {
      this.title = title;
      this.options = options;
      deliveries.push(this);
    }
    close() {
      this.closed = true;
      this.onclose?.();
    }
  }
  const values = {
    window: dom.window,
    document: dom.window.document,
    localStorage: dom.window.localStorage,
    Notification: FakeNotification,
    navigator: {
      locks: {
        request(_key: string, callback: () => Promise<void>) {
          const next = held.then(callback);
          held = next.catch(() => {});
          return next;
        },
      },
    },
  };
  Object.defineProperty(dom.window, "Notification", { value: FakeNotification });
  Object.defineProperty(dom.window, "focus", { value: () => {} });
  const original = Object.keys(values).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  for (const [key, value] of Object.entries(values))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const item: MessageNotification = {
    id: "one",
    sessionId: "s",
    threadRef: "thread",
    title: "Private project title",
    at: Date.now(),
    kind: "message",
    unreadCount: 1,
    runId: "run",
  };
  const actions = {
    scope: "alice",
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
      reads++;
      unread = false;
    },
    async navigate() {
      return navigation;
    },
    visible() {
      return false;
    },
  };
  const first = createNotificationCenter(actions);
  let second: ReturnType<typeof createNotificationCenter> | undefined;
  let other: ReturnType<typeof createNotificationCenter> | undefined;
  try {
    await first.refresh();
    assert.match(document.title, /1 unread/);
    assert.equal(requested, 0);
    document.querySelector<HTMLButtonElement>(".mention-toast-dismiss")!.click();
    assert.equal(reads, 0);
    assert.match(document.title, /1 unread/);
    document.querySelector<HTMLButtonElement>(".notification-desktop")!.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(requested, 1);
    assert.equal(deliveries.length, 0);
    second = createNotificationCenter(actions);
    visibility = "hidden";
    await Promise.all([first.refresh(), second.refresh()]);
    assert.equal(deliveries.length, 1);
    assert.ok(!JSON.stringify(deliveries[0]!.options).includes(item.title));
    deliveries[0]!.close();
    await first.refresh();
    assert.equal(deliveries.length, 1);
    assert.equal(reads, 0);
    localStorage.setItem("coworker:desktop:bob", "1");
    other = createNotificationCenter({ ...actions, scope: "bob" });
    await other.refresh();
    assert.equal(deliveries.length, 2);
    deliveries[1]!.onclick!();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(reads, 0);
    navigation = true;
    deliveries[1]!.onclick!();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(reads, 1);
    unread = true;
    item.id = "without-locks";
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: {} });
    localStorage.setItem("coworker:desktop:alice:seen", "invalid-json");
    await first.refresh();
    assert.equal(deliveries.length, 3);
    await first.refresh();
    assert.equal(deliveries.length, 3);
    const workingStorage = localStorage;
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: {
        getItem: (key: string) => workingStorage.getItem(key),
        setItem: () => {
          throw new Error("quota fixture");
        },
      },
    });
    item.id = "storage-failure";
    await first.refresh();
    assert.match(
      document.querySelector<HTMLButtonElement>(".notification-desktop")!.textContent!,
      /unavailable.*retry/,
    );
    assert.equal(reads, 1);
    const deliveryCount = deliveries.length;
    assert.equal(deliveries.at(-1)!.closed, true);
    await first.refresh();
    assert.equal(deliveries.length, deliveryCount);
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: workingStorage });
    FakeNotification.permission = "denied";
    await first.refresh();
    assert.equal(document.querySelector<HTMLButtonElement>(".notification-desktop")!.disabled, true);
  } finally {
    other?.dispose();
    second?.dispose();
    first.dispose();
    assert.ok(deliveries.every((notification) => notification.closed));
    assert.equal(document.title, "Moqi");
    dom.window.close();
    for (const [key, descriptor] of original) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
