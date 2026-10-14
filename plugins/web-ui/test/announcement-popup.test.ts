import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";

test("important announcements queue, persist acknowledgement, retry failures and isolate account changes", async () => {
  const dom = new JSDOM("<!doctype html><body><main></main></body>", {
    url: "https://fixture.test",
    pretendToBeVisual: true,
  });
  const values = {
    window: dom.window,
    document: dom.window.document,
    HTMLElement: dom.window.HTMLElement,
    Document: dom.window.Document,
    customElements: dom.window.customElements,
    MutationObserver: dom.window.MutationObserver,
    localStorage: dom.window.localStorage,
    CSSStyleSheet: dom.window.CSSStyleSheet,
  };
  for (const [key, value] of Object.entries(values))
    Object.defineProperty(globalThis, key, { configurable: true, value });
  dom.window.HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  dom.window.HTMLDialogElement.prototype.close = function () {
    if (!this.open) return;
    this.open = false;
    setTimeout(() => this.dispatchEvent(new dom.window.Event("close")), 0);
  };
  const { mountAnnouncementBanner, refreshAnnouncements, unmountAnnouncementBanner, currentArchiveList } =
    await import("../src/banner.ts");
  const flush = async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  };
  const item = (id: string, popup = true) => ({
    id,
    popup,
    level: "notice",
    title: id,
    body: "**内容**",
    startsAt: "2026-01-01",
    endsAt: null,
  });
  let announcements = [item("ordinary", false)];
  const dismissed: string[] = [];
  let succeeds = false;
  let calls = 0;
  let pending: (() => void) | undefined;
  let hold = false;
  const fetchImpl = async (url: string, init?: { method?: string }) => {
    if (init?.method === "POST") {
      calls++;
      if (hold)
        await new Promise<void>((resolve) => {
          pending = resolve;
        });
      if (succeeds) dismissed.push(decodeURIComponent(url.split("/")[3]!));
      return { ok: succeeds, status: succeeds ? 200 : 503, json: async () => ({}) };
    }
    return { ok: true, status: 200, json: async () => ({ announcements, dismissed: [...dismissed] }) };
  };
  const mount = dom.window.document.querySelector("main")!;
  const dialog = () => dom.window.document.querySelector<HTMLDialogElement>(".announcement-reader[open]");
  const done = () => dialog()!.querySelector<HTMLButtonElement>("footer button")!.click();
  try {
    mountAnnouncementBanner({ userKey: "a", mount, fetchImpl });
    await flush();
    assert.equal(dialog(), null);
    const blocker = dom.window.document.createElement("dialog");
    dom.window.document.body.append(blocker);
    blocker.showModal();
    announcements = [item("one"), item("two"), item("future"), item("expired")];
    announcements[2]!.startsAt = "2099-01-01";
    Object.assign(announcements[3]!, { endsAt: "2020-01-01" });
    await refreshAnnouncements();
    assert.equal(dialog(), null);
    blocker.close();
    await flush();
    assert.equal(dialog()?.querySelector("h1")?.textContent, "one");
    await refreshAnnouncements();
    assert.equal(dom.window.document.querySelectorAll(".announcement-reader").length, 1);
    done();
    await flush();
    assert.match(dialog()!.textContent!, /Could not save/);
    assert.equal(calls, 1);
    succeeds = true;
    dialog()!.dispatchEvent(new dom.window.Event("cancel", { cancelable: true }));
    await flush();
    assert.equal(dialog()?.querySelector("h1")?.textContent, "two");
    assert.ok(currentArchiveList().some((a) => a.id === "one"));
    assert.doesNotMatch(mount.textContent ?? "", /one/);
    done();
    await flush();
    assert.equal(dialog(), null);
    assert.equal(mount.hidden, true);
    await refreshAnnouncements();
    assert.equal(dialog(), null);
    mountAnnouncementBanner({ userKey: "a", mount, fetchImpl });
    await flush();
    assert.equal(dialog(), null);
    announcements = [item("three")];
    await refreshAnnouncements();
    hold = true;
    done();
    await flush();
    unmountAnnouncementBanner();
    mountAnnouncementBanner({
      userKey: "b",
      mount,
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        json: async () => ({ announcements: [item("three")], dismissed: [] }),
      }),
    });
    await flush();
    pending!();
    await flush();
    assert.equal(dialog()?.querySelector("h1")?.textContent, "three");
    assert.deepEqual(currentArchiveList(), []);
  } finally {
    unmountAnnouncementBanner();
    await flush();
    dom.window.close();
  }
});
