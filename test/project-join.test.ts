import "./support/auto-fake-sprites.ts";

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { personKey } from "../src/directory/person.ts";
import { withProjectJoins } from "../src/notifications/notification-store.ts";
import { createMemoryMap } from "../src/persistence/durable-map.ts";
import { createProjectJoinStore, type ProjectJoinRecord } from "../src/projects/project-join-store.ts";
import { buildApp } from "../src/wiring.ts";
import { testConfig } from "./support/test-config.ts";

const joined = (name: string, addedAt: number) => ({ name, scopeId: `group:${name}`, addedBy: "owner", addedAt });

test("a join is unseen until read, one at a time or all at once, and goes when the person leaves", async () => {
  const store = createProjectJoinStore(createMemoryMap<ProjectJoinRecord>());
  await store.record("ann", "p1", joined("Launch", 10));
  await store.record("ann", "p2", joined("Audit", 20));
  await store.record("bo", "p1", joined("Launch", 30));
  assert.deepEqual(
    (await store.list("ann")).map((row) => [row.projectId, row.seenAt]),
    [
      ["p2", null],
      ["p1", null],
    ],
  );
  assert.equal(await store.markSeen("ann", "p1", 99), true);
  assert.equal(await store.markSeen("ann", "unknown", 99), false);
  assert.equal(await store.markAllSeen("ann", 100), 1);
  assert.equal(await store.markAllSeen("ann", 101), 0);
  assert.deepEqual(
    (await store.list("ann")).map((row) => row.seenAt),
    [100, 99],
  );
  assert.equal((await store.list("bo"))[0]!.seenAt, null, "another person's joins are untouched");
  await store.remove("ann", "p1");
  assert.deepEqual(
    (await store.list("ann")).map((row) => row.projectId),
    ["p2"],
  );
  await store.record("ann", "p2", joined("Audit", 200));
  assert.equal((await store.list("ann"))[0]!.seenAt, null, "being added again is news again");
});

test("joins become rows in the bell that open the project", () => {
  const page = { items: [], unreadCount: 0, unreadThreads: 0 };
  const rows = [
    { projectId: "p1", name: "Launch", scopeId: "group:web-project-p1", addedAt: 50, seenAt: null },
    { projectId: "p2", name: "Audit", scopeId: "group:web-project-p2", addedAt: 40, seenAt: 45 },
  ];
  const merged = withProjectJoins(page, rows, true);
  assert.deepEqual(
    merged.items.map((item) => [item.id, item.kind, item.title, item.unread, item.scopeId]),
    [
      ["project-join:p1", "added", "Launch", true, "group:web-project-p1"],
      ["project-join:p2", "added", "Audit", false, "group:web-project-p2"],
    ],
  );
  assert.equal(merged.unreadThreads, 1);
  assert.deepEqual(withProjectJoins(page, rows, false).items, []);
});

test("being added by someone else is recorded, and a member can leave but cannot remove anyone else", async () => {
  const built = buildApp(testConfig({ dataDir: mkdtempSync(join(tmpdir(), "project-join-")) }));
  await built.app.upsertDirectory(
    ["owner", "ann", "bo"].map((principalId) => ({
      principalId,
      displayName: principalId.toUpperCase(),
      type: "internal" as const,
    })),
  );
  const project = await built.app.createProject("owner", "Launch");
  assert.ok(project);
  assert.deepEqual(await built.projectJoins.list(personKey("owner")), [], "creating a project is not being added");
  assert.equal((await built.app.addProjectMember(project.id, "owner", "ann")).status, "ok");
  assert.equal((await built.app.addProjectMember(project.id, "owner", "bo")).status, "ok");
  const [row] = await built.projectJoins.list(personKey("ann"));
  assert.equal(row?.projectId, project.id);
  assert.equal(row?.name, "Launch");
  assert.equal(row?.scopeId, project.scopeId);
  assert.equal(row?.seenAt, null);

  assert.equal((await built.app.removeProjectMember(project.id, "ann", "bo")).status, "forbidden");
  assert.equal((await built.app.removeProjectMember(project.id, "owner", "owner")).status, "invalid_member");
  const left = await built.app.removeProjectMember(project.id, "ann", "ann");
  assert.equal(left.status, "ok");
  assert.deepEqual(await built.projectJoins.list(personKey("ann")), [], "the notice goes with the membership");
  const members = (await built.app.listProjects("owner"))[0]!.members.map((member) => member.principalId).sort();
  assert.deepEqual(members, ["bo", "owner"]);
  assert.deepEqual(await built.app.listProjects("ann"), []);

  await built.identity.deactivate("owner");
  assert.equal(
    (await built.app.removeProjectMember(project.id, "bo", "bo")).status,
    "ok",
    "a member can still leave when the owner has been deactivated",
  );
});
