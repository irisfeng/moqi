import "./support/auto-fake-sprites.ts";

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createServer } from "../src/api/server.ts";
import { departmentByPerson, type RosterEntry } from "../src/projects/department-roster.ts";
import { buildApp } from "../src/wiring.ts";
import type { PersonContact } from "../src/directory/person-contact.ts";
import { createMemoryMap } from "../src/persistence/durable-map.ts";
import { mintPortalIdentity } from "../plugins/chassis/src/portal-identity.ts";
import { signedHeaders } from "../plugins/chassis/src/core-client.ts";
import { testConfig } from "./support/test-config.ts";

const sourceSecret = "directory-source-test-secret".repeat(3);
const portalSecret = "directory-portal-test-secret".repeat(3);
const capabilitySecret = "directory-capability-test-secret".repeat(3);
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
  entry("bo", "Finance"),
  entry("cy", "Sales"),
  entry("fay", "Finance"),
  entry("old", "Sales", { eligibleTo: NOW - HOUR }),
  entry("tess", "Sales", { isTest: true }),
];

test("a person's department is the one on the roster now", () => {
  assert.deepEqual(
    [...departmentByPerson(roster, NOW)],
    [
      ["ann", "Sales"],
      ["bo", "Finance"],
      ["cy", "Sales"],
      ["fay", "Finance"],
    ],
  );
});

test("the directory lists active staff with their department, to staff only", async () => {
  const built = buildApp(testConfig({ dataDir: mkdtempSync(join(tmpdir(), "directory-people-")) }));
  await built.app.upsertDirectory([
    ...["ann", "bo", "cy", "dee@example.test", "admin-alice"].map((principalId) => ({
      principalId,
      displayName: principalId.toUpperCase(),
      type: "internal" as const,
    })),
    { principalId: "guest", displayName: "GUEST", type: "guest" as const },
  ]);
  await built.identity.deactivate("cy");
  const adoption = { roster: async () => ({ revision: 1, source: "test", recordedAt: NOW, members: roster }) };
  const personContacts = createMemoryMap<PersonContact>();
  await personContacts.put("bo", { phone: "0123-0123 4567 转 806" });
  await personContacts.put("cy", { phone: "0123-0765 4321" });
  const server = createServer(built.app, {
    admin: built.admin,
    adoption: adoption as never,
    personContacts,
    identity: built.identity,
    signingSecret: sourceSecret,
    portalIdentitySecret: portalSecret,
    capabilitySecret,
    requireSignedPortalIdentity: true,
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  let count = 0;
  async function request(principalId: string, viewer: string) {
    const target = `/v1/directory/people?principalId=${principalId}&_sourceAuthNonce=${++count}`;
    const headers = signedHeaders(sourceSecret, "GET", target);
    headers["x-portal-identity"] = mintPortalIdentity({ p: viewer, exp: Date.now() + 60000 }, portalSecret);
    return fetch(base + target, { method: "GET", headers });
  }
  try {
    const listed = await request("ann", "ann");
    assert.equal(listed.status, 200);
    const body = (await listed.json()) as {
      people: Array<{
        principalId: string;
        displayName: string;
        department: string | null;
        email: string | null;
        phone: string | null;
      }>;
    };
    assert.deepEqual(
      body.people.map((person) => [person.principalId, person.department]).sort(),
      [
        ["ann", "Sales"],
        ["bo", "Finance"],
      ],
      "deactivated people, outside guests, people only on the roster and people with no department are left out",
    );
    assert.deepEqual(
      body.people.map((person) => [person.principalId, person.email, person.phone]).sort(),
      [
        ["ann", null, null],
        ["bo", null, "0123-0123 4567 转 806"],
      ],
      "the phone is the one an administrator saved",
    );
    const asAdmin = (await (await request("admin-alice", "admin-alice")).json()) as {
      people: Array<{ principalId: string; department: string | null; email: string | null }>;
    };
    assert.deepEqual(
      asAdmin.people.map((person) => [person.principalId, person.department, person.email]).sort(),
      [
        ["admin-alice", null, null],
        ["ann", "Sales", null],
        ["bo", "Finance", null],
        ["dee@example.test", null, "dee@example.test"],
      ],
      "an administrator also sees people with no department, and an email-shaped sign-in is the email",
    );
    assert.equal((await request("bo", "ann")).status, 403, "one person cannot ask as another");
    assert.equal((await request("cy", "cy")).status, 401, "a deactivated person's identity is refused outright");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
