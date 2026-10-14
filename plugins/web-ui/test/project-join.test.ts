import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (path: string): string => readFileSync(new URL(path, import.meta.url), "utf8");

test("a member is offered Leave project on their own row, never the owner and never someone in through a channel", () => {
  const contexts = read("../src/contexts.ts");
  assert.match(
    contexts,
    /principalId === appState\.me\?\.user &&\s+principalId !== project\.ownerId &&\s+!viaChannel &&\s+!appState\.me\?\.impersonatedBy\s+\? html`<button\s+class="btn compact project-leave"/,
  );
  assert.match(
    contexts,
    /async function leaveProject[\s\S]{0,700}\/members\/\$\{encodeURIComponent\(self\)\}`, \{\s+method: "DELETE",/,
  );
  assert.match(
    contexts,
    /async function leaveProject[\s\S]{0,900}selectContext\(null\);\s+await ensureContexts\(true\);/,
  );
});

test("a project-join row in the bell opens that project", () => {
  const conversations = read("../src/conversations.ts");
  assert.match(
    conversations,
    /if \(threadRef\.startsWith\(PROJECT_JOIN_PREFIX\)\) \{\s+const scopeId = \(target as \{ scopeId\?: string \}\)\.scopeId;[\s\S]{0,160}openProjectDetail\(scopeId\);\s+return true;/,
  );
});
