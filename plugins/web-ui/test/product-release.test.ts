import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { productRelease } from "../src/product-release.ts";

function page(version: string | null, notes: string | null) {
  return {
    querySelector: (selector: string) =>
      selector === 'meta[name="coworker-product-version"]' && version !== null
        ? { getAttribute: (name: string) => (name === "content" ? version : null) }
        : null,
    getElementById: (id: string) => (id === "coworker-release-notes" && notes !== null ? { textContent: notes } : null),
  } as unknown as Pick<Document, "querySelector" | "getElementById">;
}

test("the stamped version and its notes are read from the page", () => {
  assert.deepEqual(productRelease(page("0.4.0", JSON.stringify({ version: "0.4.0", notes: "### 新功能\n\n- 一项" }))), {
    version: "0.4.0",
    notes: "### 新功能\n\n- 一项",
    history: [],
  });
});

test("earlier versions are read in order, and broken entries are dropped", () => {
  const notes = JSON.stringify({
    version: "0.4.1",
    notes: "- 新",
    history: [
      { version: "0.4.0", notes: "- 旧" },
      { version: "0.3.9", notes: " " },
      { version: 3, notes: "- 坏" },
      null,
      { version: "0.3.x", notes: "- 更旧" },
    ],
  });
  assert.deepEqual(productRelease(page("0.4.1", notes))?.history, [
    { version: "0.4.0", notes: "- 旧" },
    { version: "0.3.x", notes: "- 更旧" },
  ]);
  assert.deepEqual(
    productRelease(page("0.4.1", JSON.stringify({ version: "0.4.1", notes: "- 新", history: "x" })))?.history,
    [],
  );
});

test("an unstamped page, mismatched notes or broken notes show no version row", () => {
  assert.equal(productRelease(page(null, null)), null);
  assert.equal(productRelease(page("0.4.0", null)), null);
  assert.equal(productRelease(page("0.4.0", JSON.stringify({ version: "0.3.0", notes: "old" }))), null);
  assert.equal(productRelease(page("0.4.0", JSON.stringify({ version: "0.4.0", notes: "  " }))), null);
  assert.equal(productRelease(page("0.4.0", "{not json")), null);
});

test("settings shows the contact and version rows after the account row", () => {
  const settings = readFileSync(new URL("../src/settings.ts", import.meta.url), "utf8");
  assert.match(settings, /\$\{accountRow\(\)\}\s+<qm-contact-row [^>]*><\/qm-contact-row> \$\{versionRow\(\)\}/);
});
