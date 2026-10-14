import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { createTranscriptNavigation } from "../src/transcript-navigation.ts";

const dom = new JSDOM("<!doctype html><body></body>");
const observers: Array<{ callback: () => void; stopped: boolean }> = [];
Object.assign(globalThis, {
  ResizeObserver: class {
    item: { callback: () => void; stopped: boolean };
    constructor(callback: () => void) {
      this.item = { callback, stopped: false };
      observers.push(this.item);
    }
    observe() {}
    disconnect() {
      this.item.stopped = true;
    }
  },
  requestAnimationFrame: () => 1,
  cancelAnimationFrame() {},
});
function fixture() {
  const host = dom.window.document.createElement("div");
  host.innerHTML =
    '<div class="custom-chat-shell"><section class="chat-scroll"><div class="message-stack"></div></section><button class="chat-latest-button" hidden></button></div>';
  const scroller = host.querySelector<HTMLElement>(".chat-scroll")!;
  const button = host.querySelector<HTMLButtonElement>("button")!;
  Object.defineProperties(scroller, {
    scrollHeight: { value: 1200, configurable: true },
    clientHeight: { value: 400, configurable: true },
  });
  const scroll = (top: number) => {
    scroller.scrollTop = top;
    scroller.dispatchEvent(new dom.window.Event("scroll"));
  };
  return { host, scroller, button, scroll };
}
test("upward reading shows control; click reaches latest and restores follow", () => {
  const f = fixture();
  let follows = 0;
  const nav = createTranscriptNavigation(() => follows++);
  nav.sync(f.host);
  f.scroll(800);
  assert.equal(f.button.hidden, true);
  f.scroll(200);
  assert.equal(f.button.hidden, false);
  assert.equal(f.scroller.scrollTop, 200);
  f.button.click();
  assert.equal(f.scroller.scrollTop, 1200);
  assert.equal(f.button.hidden, true);
  assert.equal(follows, 1);
  nav.disconnect();
});
test("streaming growth and resizing update visibility without moving reader", () => {
  const f = fixture();
  const nav = createTranscriptNavigation(() => {});
  nav.sync(f.host);
  f.scroll(800);
  Object.defineProperty(f.scroller, "scrollHeight", { value: 1600 });
  observers.at(-1)!.callback();
  assert.equal(f.button.hidden, false);
  assert.equal(f.scroller.scrollTop, 800);
  Object.defineProperty(f.scroller, "clientHeight", { value: 800 });
  observers.at(-1)!.callback();
  assert.equal(f.button.hidden, true);
  nav.disconnect();
});
test("short conversation and bottom threshold stay hidden", () => {
  const f = fixture();
  const nav = createTranscriptNavigation(() => {});
  nav.sync(f.host);
  f.scroll(680);
  assert.equal(f.button.hidden, true);
  f.scroll(679);
  assert.equal(f.button.hidden, false);
  Object.defineProperty(f.scroller, "scrollHeight", { value: 200 });
  f.scroll(0);
  assert.equal(f.button.hidden, true);
  nav.disconnect();
});
test("switching and leaving conversations detach listeners and observers", () => {
  const a = fixture(),
    b = fixture();
  let calls = 0;
  const nav = createTranscriptNavigation(() => calls++);
  nav.sync(a.host);
  const old = observers.at(-1)!;
  nav.sync(b.host);
  assert.equal(old.stopped, true);
  a.button.click();
  assert.equal(calls, 0);
  b.button.click();
  assert.equal(calls, 1);
  const last = observers.at(-1)!;
  nav.disconnect();
  assert.equal(last.stopped, true);
  b.button.click();
  assert.equal(calls, 1);
});
test("repeated render does not duplicate listeners; empty host clears control", () => {
  const f = fixture();
  let calls = 0;
  const nav = createTranscriptNavigation(() => calls++);
  nav.sync(f.host);
  nav.sync(f.host);
  nav.sync(f.host);
  f.button.click();
  assert.equal(calls, 1);
  nav.sync(dom.window.document.createElement("div"));
  f.button.click();
  assert.equal(calls, 1);
});
