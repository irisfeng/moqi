import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { createMentionToast } from "../src/mention-toast.ts";

test("queued notifications preserve the first unread target and keep messages arriving during navigation", async () => {
  const dom = new JSDOM("<!doctype html><body></body>");
  const original = Object.getOwnPropertyDescriptor(globalThis, "document");
  Object.defineProperty(globalThis, "document", { configurable: true, value: dom.window.document });
  let finish: (value: boolean) => void = () => {};
  const opened: unknown[] = [];
  const toast = createMentionToast((threadRef, target) => {
    opened.push({ threadRef, target });
    return new Promise<boolean>((resolve) => {
      finish = resolve;
    });
  });
  const click = () => dom.window.document.querySelector<HTMLButtonElement>(".mention-toast-action")!.click();
  try {
    toast.notify("project-a", "项目甲", { deliveryId: "first" });
    toast.notify("project-a", "项目甲", { deliveryId: "second" });
    click();
    toast.notify("project-a", "项目甲", { deliveryId: "during-open" });
    toast.notify("project-b", "项目乙", { runId: "mention" });
    finish(true);
    await Promise.resolve();
    click();
    assert.deepEqual(opened, [
      { threadRef: "project-a", target: { deliveryId: "first" } },
      { threadRef: "project-a", target: { deliveryId: "during-open" } },
    ]);
    finish(false);
    await Promise.resolve();
    assert.equal(dom.window.document.querySelector<HTMLElement>(".mention-toast")!.dataset.state, "error");
    click();
    assert.deepEqual(opened.at(-1), { threadRef: "project-a", target: { deliveryId: "during-open" } });
    finish(true);
    await Promise.resolve();
    click();
    assert.deepEqual(opened.at(-1), { threadRef: "project-b", target: { runId: "mention" } });
    finish(true);
    await Promise.resolve();
    assert.equal(dom.window.document.querySelector<HTMLElement>(".mention-toast")!.hidden, true);
  } finally {
    toast.dispose();
    dom.window.close();
    if (original) Object.defineProperty(globalThis, "document", original);
    else Reflect.deleteProperty(globalThis, "document");
  }
});

test("dismiss aborts pending navigation without marking unread or corrupting the next toast", async () => {
  const dom = new JSDOM("<!doctype html><body></body>");
  const original = Object.getOwnPropertyDescriptor(globalThis, "document");
  Object.defineProperty(globalThis, "document", { configurable: true, value: dom.window.document });
  const requests: { signal?: AbortSignal; finish: (value: boolean) => void }[] = [];
  let reads = 0;
  const toast = createMentionToast(
    (_thread, _target, signal) => new Promise((finish) => requests.push({ signal, finish })),
  );
  const action = () => dom.window.document.querySelector<HTMLButtonElement>(".mention-toast-action")!.click();
  try {
    toast.notify("a", "first", {}, async () => {
      reads++;
    });
    toast.notify("b", "next", {}, async () => {
      reads++;
    });
    action();
    const close = dom.window.document.querySelector<HTMLButtonElement>(".mention-toast-dismiss")!;
    assert.equal(close.disabled, false);
    close.click();
    assert.equal(requests[0]!.signal?.aborted, true);
    action();
    requests[0]!.finish(true);
    await Promise.resolve();
    assert.equal(reads, 0);
    assert.equal(dom.window.document.querySelector<HTMLElement>(".mention-toast")!.dataset.state, "loading");
    requests[1]!.finish(true);
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(reads, 1);
    assert.equal(dom.window.document.querySelector<HTMLElement>(".mention-toast")!.hidden, true);
  } finally {
    toast.dispose();
    dom.window.close();
    if (original) Object.defineProperty(globalThis, "document", original);
    else Reflect.deleteProperty(globalThis, "document");
  }
});

test("a mention alert has no way out but opening it, and a finished task can be closed", () => {
  const dom = new JSDOM("<!doctype html><body></body>");
  const originals = ["window", "document"].map(
    (key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const,
  );
  Object.defineProperty(globalThis, "window", { configurable: true, value: dom.window });
  Object.defineProperty(globalThis, "document", { configurable: true, value: dom.window.document });
  const toast = createMentionToast(async () => true);
  try {
    toast.notify("a", "Project A", {}, undefined, "mention");
    toast.notify("b", "Project B", {}, undefined, "done");
    const root = dom.window.document.querySelector<HTMLElement>(".mention-toast")!;
    const dismiss = root.querySelector<HTMLButtonElement>(".mention-toast-dismiss")!;
    const title = root.querySelector<HTMLElement>(".mention-toast-title")!;
    assert.equal(root.classList.contains("mention"), true);
    assert.equal(root.querySelector(".mention-toast-eyebrow")!.textContent, "Mentioned you");
    assert.equal(dismiss.hidden, true);
    dismiss.click();
    assert.equal(title.textContent, "Project A", "a mention stays until it is opened");
    toast.retain(new Set(["b"]));
    assert.equal(title.textContent, "Project B");
    assert.equal(root.classList.contains("mention"), false);
    assert.equal(root.classList.contains("completion"), true);
    assert.equal(root.querySelector(".mention-toast-eyebrow")!.textContent, "Task finished");
    assert.equal(dismiss.hidden, false);
    dismiss.click();
    assert.equal(root.hidden, true);
  } finally {
    toast.dispose();
    dom.window.close();
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});

test("a mention that cannot be opened can be closed, and a mention upgrades a waiting plain alert", async () => {
  const dom = new JSDOM("<!doctype html><body></body>");
  const originals = ["window", "document"].map(
    (key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const,
  );
  Object.defineProperty(globalThis, "window", { configurable: true, value: dom.window });
  Object.defineProperty(globalThis, "document", { configurable: true, value: dom.window.document });
  const toast = createMentionToast(async () => false);
  try {
    toast.notify("a", "Project A", {}, undefined, "message");
    assert.equal(toast.notify("a", "Project A", {}, undefined, "mention"), true);
    const root = dom.window.document.querySelector<HTMLElement>(".mention-toast")!;
    assert.equal(root.classList.contains("mention"), true, "the waiting alert became a mention");
    assert.equal(toast.notify("a", "Project A", {}, undefined, "message"), false);
    const dismiss = root.querySelector<HTMLButtonElement>(".mention-toast-dismiss")!;
    assert.equal(dismiss.hidden, true);
    root.querySelector<HTMLButtonElement>(".mention-toast-action")!.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(dismiss.hidden, false, "after a failed open the alert can be closed");
    dismiss.click();
    assert.equal(root.hidden, true);
  } finally {
    toast.dispose();
    dom.window.close();
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
