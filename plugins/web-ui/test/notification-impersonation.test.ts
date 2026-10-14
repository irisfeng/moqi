import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (path: string): string => readFileSync(new URL(path, import.meta.url), "utf8");

test("an alert is never marked read on someone's behalf while an admin views as them", () => {
  const server = read("../server/index.ts");
  const route = server.slice(server.indexOf('path: "/api/notifications/:id/read"'));
  assert.match(
    route.slice(0, 260),
    /impersonator !== null\) return json\(res, 403, \{ error: "impersonation_forbidden" \}\)/,
  );
  const conversations = read("../src/conversations.ts");
  assert.match(conversations, /async read\(id\) \{\n\s+if \(appState\.me\?\.impersonatedBy\) return;/);
});
