import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (path: string): string => readFileSync(new URL(path, import.meta.url), "utf8");

test("reading an alert is refused while an admin views as someone else, on the server and in the browser", () => {
  const server = read("../server/index.ts");
  const route = server.slice(server.indexOf('path: "/api/notifications/:id/read"'));
  assert.match(
    route.slice(0, 260),
    /impersonator !== null\) return json\(res, 403, \{ error: "impersonation_forbidden" \}\)/,
  );
  const conversations = read("../src/conversations.ts");
  assert.match(conversations, /async read\(id\) \{\n\s+if \(appState\.me\?\.impersonatedBy\) return;/);
});

test("reading an announcement in the bell refreshes the banner, and opening it shows the reader", () => {
  const conversations = read("../src/conversations.ts");
  assert.match(conversations, /if \(id\.startsWith\(ANNOUNCEMENT_PREFIX\)\) void refreshAnnouncements\(\);/);
  assert.match(
    conversations,
    /if \(threadRef\.startsWith\(ANNOUNCEMENT_PREFIX\)\)\n\s+return openAnnouncementById\(threadRef\.slice\(ANNOUNCEMENT_PREFIX\.length\)\);/,
  );
  const banner = read("../src/banner.ts");
  assert.match(
    banner,
    /export async function openAnnouncementById[\s\S]{0,260}openAnnouncementReader\(announcement\);/,
  );
});
