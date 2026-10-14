import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyCatalog } from "../scripts/i18n/apply.ts";
import { staleEntries, translateSource, type LineCatalog } from "../scripts/i18n/translate.ts";

const table = { 'title="Refresh"': 'title="刷新"', "Saved.": "已保存。" };

test("translateSource swaps whole lines and keeps their indentation", () => {
  const source = ["<button", '    title="Refresh"', "  >", "\tSaved.", "</button>"].join("\n");
  assert.equal(
    translateSource(source, table),
    ["<button", '    title="刷新"', "  >", "\t已保存。", "</button>"].join("\n"),
  );
});

test("translateSource leaves lines that only partly match untouched", () => {
  const source = 'const label = title="Refresh" + suffix;\nSaved. Later.';
  assert.equal(translateSource(source, table), source);
});

test("translateSource without a table returns the source unchanged", () => {
  assert.equal(translateSource("Saved.", undefined), "Saved.");
});

test("staleEntries lists catalog lines the source no longer contains", () => {
  assert.deepEqual(staleEntries('  title="Refresh"\n', table), ["Saved."]);
});

test("applyCatalog rewrites an exported tree and reports files it does not hold", () => {
  const root = mkdtempSync(join(tmpdir(), "i18n-apply-"));
  try {
    mkdirSync(join(root, "plugins/admin/public"), { recursive: true });
    writeFileSync(join(root, "plugins/admin/public/index.html"), '<p>\n  title="Refresh"\n</p>\n');
    writeFileSync(join(root, "untouched.ts"), "Saved. Later.\n");
    const result = applyCatalog(root, {
      "plugins/admin/public/index.html": table,
      "untouched.ts": table,
      "gone.ts": table,
    });
    assert.deepEqual(result, { files: 1, missing: ["gone.ts"] });
    assert.equal(readFileSync(join(root, "plugins/admin/public/index.html"), "utf8"), '<p>\n  title="刷新"\n</p>\n');
    assert.equal(readFileSync(join(root, "untouched.ts"), "utf8"), "Saved. Later.\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("applyCatalog refuses to rewrite a Git checkout", () => {
  const root = mkdtempSync(join(tmpdir(), "i18n-apply-"));
  try {
    mkdirSync(join(root, ".git"));
    writeFileSync(join(root, "a.ts"), "Saved.\n");
    assert.throws(() => applyCatalog(root, { "a.ts": table }), /Git checkout/);
    assert.equal(readFileSync(join(root, "a.ts"), "utf8"), "Saved.\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("every zh-CN catalog entry matches a line of its source file", () => {
  const catalog = JSON.parse(readFileSync("i18n/zh-CN.json", "utf8")) as LineCatalog;
  const stale = Object.entries(catalog).flatMap(([file, table]) =>
    (existsSync(file) ? staleEntries(readFileSync(file, "utf8"), table) : Object.keys(table)).map(
      (line) => `${file}: ${line}`,
    ),
  );
  assert.deepEqual(stale, []);
});
