import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { observeMobileViewport } from "../src/mobile-viewport.ts";

test("keyboard resize follows the visual viewport and restores desktop and zoom layout", () => {
  const dom = new JSDOM("<!doctype html><html></html>");
  const viewport = Object.assign(new EventTarget(), { height: 844, offsetTop: 0, scale: 1 });
  const narrow = Object.assign(new EventTarget(), { matches: true });
  Object.defineProperty(dom.window, "visualViewport", { configurable: true, value: viewport });
  Object.defineProperty(dom.window, "matchMedia", { value: () => narrow });
  const oldWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const oldDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
  Object.defineProperty(globalThis, "window", { configurable: true, value: dom.window });
  Object.defineProperty(globalThis, "document", { configurable: true, value: dom.window.document });
  const style = dom.window.document.documentElement.style;
  try {
    const stop = observeMobileViewport();
    assert.equal(style.getPropertyValue("--mobile-viewport-height"), "844px");
    viewport.height = 412;
    viewport.offsetTop = 24;
    viewport.dispatchEvent(new Event("resize"));
    assert.equal(style.getPropertyValue("--mobile-viewport-height"), "412px");
    assert.equal(style.getPropertyValue("--mobile-viewport-top"), "24px");
    viewport.offsetTop = 0;
    viewport.dispatchEvent(new Event("scroll"));
    assert.equal(style.getPropertyValue("--mobile-viewport-top"), "0px");
    viewport.scale = 2;
    viewport.dispatchEvent(new Event("resize"));
    assert.equal(style.getPropertyValue("--mobile-viewport-height"), "");
    viewport.scale = 1;
    viewport.dispatchEvent(new Event("resize"));
    narrow.matches = false;
    narrow.dispatchEvent(new Event("change"));
    assert.equal(style.getPropertyValue("--mobile-viewport-height"), "");
    narrow.matches = true;
    narrow.dispatchEvent(new Event("change"));
    stop();
    viewport.dispatchEvent(new Event("resize"));
    assert.equal(style.getPropertyValue("--mobile-viewport-height"), "");
    Object.defineProperty(dom.window, "visualViewport", { value: null });
    observeMobileViewport()();
    assert.equal(style.getPropertyValue("--mobile-viewport-top"), "");
  } finally {
    if (oldWindow) Object.defineProperty(globalThis, "window", oldWindow);
    else Reflect.deleteProperty(globalThis, "window");
    if (oldDocument) Object.defineProperty(globalThis, "document", oldDocument);
    else Reflect.deleteProperty(globalThis, "document");
    dom.window.close();
  }
});
