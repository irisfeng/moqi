import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { splitProjectFiles } from "../src/project-files.ts";

const files = [
  { name: "Q3 report.pdf", delivered: true, session: { id: "s1", title: "Quarterly review" } },
  { name: "raw-data.csv", delivered: false },
  { name: "draft.md", session: { id: "s2", title: "Budget planning" } },
  { name: "Budget.xlsx", delivered: true },
];
const names = (rows: Array<{ name: string }>) => rows.map((row) => row.name);

test("a project's files are split into what was delivered and what was made along the way", () => {
  const all = splitProjectFiles(files, "");
  assert.deepEqual(names(all.deliverables), ["Q3 report.pdf", "Budget.xlsx"]);
  assert.deepEqual(names(all.working), ["raw-data.csv", "draft.md"]);
});

test("search covers both groups, by file name or by the conversation a file came from", () => {
  const budget = splitProjectFiles(files, "  BUDGET ");
  assert.deepEqual(names(budget.deliverables), ["Budget.xlsx"]);
  assert.deepEqual(names(budget.working), ["draft.md"]);
  const none = splitProjectFiles(files, "nothing-like-this");
  assert.deepEqual([none.deliverables, none.working], [[], []]);
});

test("a person can move their own project file to the recycle bin, and archiving a conversation reads as the recycle bin", () => {
  const contexts = readFileSync(new URL("../src/contexts.ts", import.meta.url), "utf8");
  assert.match(contexts, /f\.canTrash\s+\? html`<button/);
  assert.match(contexts, /await api\(`\/api\/files\/\$\{encodeURIComponent\(f\.id\)\}`, \{ method: "DELETE" \}\);/);
  const catalog = JSON.parse(readFileSync(new URL("../../../i18n/zh-CN.json", import.meta.url), "utf8")) as Record<
    string,
    Record<string, string>
  >;
  const sessions = catalog["plugins/web-ui/src/sessions.ts"]!;
  assert.equal(sessions["<span>Archived</span>"], "<span>回收站</span>");
  const wording = Object.entries(sessions).filter(([english]) => /rchive/.test(english));
  assert.ok(wording.length >= 8);
  for (const [english, chinese] of wording) assert.doesNotMatch(chinese, /归档/, english);
});
