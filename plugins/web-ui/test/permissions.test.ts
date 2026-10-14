import { test } from "node:test";
import assert from "node:assert/strict";
import { appState, can, canView, hasDestination } from "../src/shell-state.ts";

test("can(key) is false before /me loads", () => {
  appState.me = null;
  assert.equal(can("admin"), false);
});

test("can(key) gates on the permission being present", () => {
  appState.me = { user: "alice", org: "acme", permissions: ["admin"] };
  assert.equal(can("admin"), true);
  assert.equal(can("nope"), false);
});

test("a user without the permission cannot — drives hiding the admin session-log link", () => {
  appState.me = { user: "bob", org: "acme", permissions: [] };
  assert.equal(can("admin"), false);

  appState.me = { user: "carol", org: "acme" };
  assert.equal(can("admin"), false);
});

test("loops view requires the loops permission", () => {
  appState.me = { user: "alice", org: "acme", permissions: [] };
  assert.equal(canView("loops"), false);
  assert.equal(canView("chats"), true);

  appState.me.permissions = ["loops"];
  assert.equal(canView("loops"), true);
});

test("a deployment names which of Docs, Project management and Apps exist", () => {
  appState.me = { user: "alice", org: "acme" };
  assert.equal(hasDestination("apps"), true);
  assert.equal(canView("deploys"), true);
  assert.equal(canView("docs"), false);
  assert.equal(canView("pm"), false);

  appState.me = { user: "alice", org: "acme", destinations: ["docs", "pm"] };
  assert.equal(canView("docs"), true);
  assert.equal(canView("pm"), true);
  assert.equal(canView("deploys"), false);
  assert.equal(hasDestination("apps"), false);
});
