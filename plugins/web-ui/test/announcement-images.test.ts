import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";

test("announcement rendering preserves managed images and excludes remote, data, injected attributes and arbitrary internal requests", async () => {
  const dom = new JSDOM("<!doctype html><body></body>", { url: "https://fixture.test" });
  Object.defineProperty(globalThis, "window", { configurable: true, value: dom.window });
  Object.defineProperty(globalThis, "document", { configurable: true, value: dom.window.document });
  const { announcementMarkup, renderAnnouncementBody } = await import("../src/announcement-reader.ts");
  const valid = "/api/announcement-images/" + "a".repeat(32);
  const content = `## 标题\n\n![说明](${valid})\n\n![外部](https://example.com/tracker.png)\n\n<img src="${valid}" onerror="alert(1)" srcset="https://evil.test/x 2x">\n\n<img src="data:image/png;base64,AA==">\n\n<img src="/api/files/private">`;
  const mount = dom.window.document.createElement("article");
  mount.innerHTML = announcementMarkup(content);
  assert.equal(mount.querySelectorAll("img").length, 2);
  for (const image of mount.querySelectorAll("img")) {
    assert.equal(image.getAttribute("src"), valid);
    assert.equal(image.hasAttribute("onerror"), false);
    assert.equal(image.hasAttribute("srcset"), false);
  }
  const preview = dom.window.document.createElement("article");
  renderAnnouncementBody(preview, content);
  assert.equal(preview.innerHTML, mount.innerHTML);
  assert.equal(preview.querySelector("h2")?.textContent, "标题");
  renderAnnouncementBody(preview, content, "/admin");
  assert.equal(preview.querySelector("img")?.getAttribute("src"), "/admin" + valid);
  dom.window.close();
});
