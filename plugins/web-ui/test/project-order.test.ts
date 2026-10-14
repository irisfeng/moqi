import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { compareProjects } from "../src/session-list.ts";

const read = (path: string): string => readFileSync(new URL(path, import.meta.url), "utf8");

test("projects are ordered pinned first, then important or urgent, then most recent", () => {
  const projects = [
    { name: "old", lastActivityAt: 1 },
    { name: "recent", lastActivityAt: 9 },
    { name: "urgent", urgent: true, lastActivityAt: 2 },
    { name: "important", important: true, lastActivityAt: 5 },
    { name: "pinned", pinned: true, lastActivityAt: 0 },
    { name: "pinned-and-urgent", pinned: true, urgent: true, lastActivityAt: 3 },
    { name: "never-active", lastActivityAt: null },
  ];
  assert.deepEqual(
    projects.sort(compareProjects).map((project) => project.name),
    ["pinned-and-urgent", "pinned", "important", "urgent", "recent", "old", "never-active"],
  );
});

test("in the sidebar the arrow expands a project and the name opens it, as two buttons", () => {
  const sessions = read("../src/sessions.ts");
  const head = sessions.slice(
    sessions.indexOf('<div class="recent-project-head">'),
    sessions.indexOf("recent-project-menu"),
  );
  assert.match(head, /@click=\$\{\(\) => toggleRecentProject\(item\.scopeId\)\}/);
  assert.match(head, /class="recent-project-open"\s+type="button"/);
  assert.match(head, /@click=\$\{\(\) => openRecentProject\(item\.scopeId\)\}/);
  assert.equal(head.match(/<button/g)?.length, 2);
  assert.match(sessions, /function openRecentProject[\s\S]{0,200}openProjectDetail\(scopeId\);/);
});

test("the project list shows urgent, important and category on each row", () => {
  const contexts = read("../src/contexts.ts");
  assert.match(contexts, /sort\(\(a, b\) => compareProjects\(standing\(a\), standing\(b\)\)\)/);
  assert.match(contexts, /class="context-flag urgent"/);
  assert.match(contexts, /class="context-flag important"/);
  assert.match(contexts, /class="context-tag"/);
});
