import { test } from "node:test";
import assert from "node:assert/strict";
import { pinnedProjectScopes } from "../src/session-list.ts";

test("a project is pinned when one of its conversations is, and an empty project when its summary says so", () => {
  const projects = [
    { scopeId: "group:project:a", pinned: false },
    { scopeId: "group:project:b", pinned: true },
    { scopeId: "group:project:c", pinned: true },
    { scopeId: "group:project:d", pinned: false },
  ];
  const sessions = [
    { scopeId: "group:project:a", pinned: true },
    { scopeId: "group:project:a", pinned: false },
    { scopeId: "group:project:b", pinned: false },
    { scopeId: "personal:u", pinned: true },
  ];
  assert.deepEqual([...pinnedProjectScopes(sessions, projects)].sort(), ["group:project:a", "group:project:c"]);
});
