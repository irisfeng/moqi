import "./support/auto-fake-sprites.ts";

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createServer } from "../src/api/server.ts";
import { departmentMembers, departmentNames, type RosterEntry } from "../src/projects/department-roster.ts";
import { buildApp } from "../src/wiring.ts";
import { mintPortalIdentity } from "../plugins/chassis/src/portal-identity.ts";
import { signedHeaders } from "../plugins/chassis/src/core-client.ts";
import { testConfig } from "./support/test-config.ts";

const sourceSecret = "department-source-test-secret".repeat(3);
const portalSecret = "department-portal-test-secret".repeat(3);
const capabilitySecret = "department-capability-test-secret".repeat(3);
const NOW = Date.now();
const HOUR = 3_600_000;

function entry(principalId: string, department: string | null, patch: Partial<RosterEntry> = {}): RosterEntry {
  return {
    principalId,
    displayName: principalId.toUpperCase(),
    department,
    eligibleFrom: null,
    eligibleTo: null,
    isTest: false,
    ...patch,
  };
}

const roster: RosterEntry[] = [
  entry("ann", "Sales"),
  entry("bo", "Sales"),
  entry("cy", "Sales"),
  entry("dee", "Sales"),
  entry("tess", "Sales", { isTest: true }),
  entry("left", "Sales", { eligibleTo: NOW - HOUR }),
  entry("soon", "Sales", { eligibleFrom: NOW + HOUR }),
  entry("fay", "Finance"),
  entry("nobody", null),
  entry("gone", "Closed", { eligibleTo: NOW - HOUR }),
];

test("a department is the people on the roster now, without test accounts or people outside their dates", () => {
  assert.deepEqual(departmentNames(roster, NOW), ["Finance", "Sales"]);
  assert.deepEqual(
    departmentMembers(roster, "Sales", NOW).map((member) => member.principalId),
    ["ann", "bo", "cy", "dee"],
  );
  assert.deepEqual(departmentMembers(roster, "Closed", NOW), []);
  assert.deepEqual(departmentMembers(roster, "sales", NOW), [], "the department name is matched exactly");
});

async function projectWithDirectory() {
  const built = buildApp(testConfig({ dataDir: mkdtempSync(join(tmpdir(), "project-department-")) }));
  await built.app.upsertDirectory(
    ["owner", "ann", "bo", "cy", "dee", "fay"].map((principalId) => ({
      principalId,
      displayName: principalId.toUpperCase(),
      type: "internal" as const,
    })),
  );
  const project = await built.app.createProject("owner", "Launch");
  assert.ok(project);
  assert.equal((await built.app.addProjectMember(project.id, "owner", "dee")).status, "ok");
  await built.identity.deactivate("cy");
  return { built, project };
}

test("the preview leaves out existing members, deactivated people and anyone not in the directory, for the owner only", async () => {
  const { built, project } = await projectWithDirectory();
  const candidates = ["ann", "bo", "cy", "dee", "ghost", "owner"].map((principalId) => ({
    principalId,
    displayName: principalId,
  }));
  const preview = await built.app.previewProjectMembers(project.id, "owner", candidates);
  assert.equal(preview.status, "ok");
  if (preview.status !== "ok") return;
  assert.deepEqual(
    preview.members.map((member) => member.principalId),
    ["ann", "bo"],
  );
  assert.equal(preview.alreadyIn, 2);
  assert.equal((await built.app.previewProjectMembers(project.id, "dee", candidates)).status, "forbidden");
  assert.equal((await built.app.previewProjectMembers("no-such-project", "owner", candidates)).status, "not_found");
});

test("confirming adds only the people who were previewed and are still valid, once", async () => {
  const { built, project } = await projectWithDirectory();
  const adoption = { roster: async () => ({ revision: 1, source: "test", recordedAt: NOW, members: roster }) };
  const server = createServer(built.app, {
    adoption: adoption as never,
    signingSecret: sourceSecret,
    portalIdentitySecret: portalSecret,
    capabilitySecret,
    requireSignedPortalIdentity: true,
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  let count = 0;
  async function request(path: string, method: string, viewer: string, body?: string) {
    const target = `${path}${path.includes("?") ? "&" : "?"}_sourceAuthNonce=${++count}`;
    const headers = signedHeaders(sourceSecret, method, target, body);
    headers["x-portal-identity"] = mintPortalIdentity({ p: viewer, exp: Date.now() + 60000 }, portalSecret);
    return fetch(base + target, { method, headers, ...(body ? { body } : {}) });
  }
  const departments = `/v1/projects/${project.id}/departments`;
  try {
    const names = await request(`${departments}?principalId=owner`, "GET", "owner");
    assert.equal(names.status, 200);
    assert.deepEqual(await names.json(), { departments: ["Finance", "Sales"] });
    const preview = await request(`${departments}?principalId=owner&department=Sales`, "GET", "owner");
    const previewed = (await preview.json()) as { members: Array<{ principalId: string }>; alreadyIn: number };
    assert.deepEqual(
      previewed.members.map((member) => member.principalId),
      ["ann", "bo"],
    );
    assert.equal(previewed.alreadyIn, 1);
    assert.equal((await request(`${departments}?principalId=dee`, "GET", "dee")).status, 403);
    assert.equal((await request(`${departments}?principalId=owner`, "GET", "dee")).status, 403);

    const add = `/v1/projects/${project.id}/members/department`;
    const confirm = (viewer: string, memberIds: unknown) =>
      request(add, "POST", viewer, JSON.stringify({ principalId: viewer, department: "Sales", memberIds }));
    assert.equal((await confirm("dee", ["ann"])).status, 403);
    assert.equal((await confirm("owner", "ann")).status, 400);
    const added = await confirm("owner", ["ann", "fay", "cy"]);
    assert.equal(added.status, 200);
    assert.deepEqual(await added.json(), { added: 1, skipped: 2 });
    const members = (await built.app.listProjects("owner"))[0]!.members.map((member) => member.principalId).sort();
    assert.deepEqual(
      members,
      ["ann", "dee", "owner"],
      "bo was previewed but not confirmed, fay is in another department",
    );
    assert.deepEqual(await (await confirm("owner", ["ann"])).json(), { added: 0, skipped: 1 });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
