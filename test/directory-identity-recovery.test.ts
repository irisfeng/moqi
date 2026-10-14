import assert from "node:assert/strict";
import { test } from "node:test";
import { createMessagingMethods } from "../src/api/app-messaging.ts";
import type { AppDeps } from "../src/api/app-types.ts";
import type { AppHelpers } from "../src/api/app-helpers.ts";
import type { AmbientHelpers } from "../src/api/app-ambient.ts";
import { createDirectoryStore, type DirectoryMember } from "../src/directory/directory-store.ts";
import { createIdentityService, type DeactivationRecord } from "../src/identity/identity-service.ts";
import { createMemoryMap } from "../src/persistence/durable-map.ts";
import { createMemoryAdvisoryLock } from "../src/persistence/advisory-lock.ts";

const member = (principalId: string): DirectoryMember => ({ principalId, displayName: principalId, type: "internal" });
const methods = (deps: Partial<AppDeps>) =>
  createMessagingMethods({ auditLog: { record() {} }, ...deps } as AppDeps, {} as AppHelpers, {} as AmbientHelpers);

test("a failed second revocation preserves the batch and a new service resumes it after roster replacement", async () => {
  const directory = createDirectoryStore();
  const records = createMemoryMap<DeactivationRecord>();
  const directorySyncJournal = createMemoryMap<{
    members: DirectoryMember[];
    removedIds: string[];
    syncedAt?: number;
  }>();
  const advisoryLock = createMemoryAdvisoryLock();
  const revoked: string[] = [];
  const first = createIdentityService(records, {
    revokeSessions: async (id) => {
      if (id === "b@example.test") throw new Error("revocation unavailable");
      revoked.push(id);
    },
  });
  const deps = { directory, directorySyncJournal, advisoryLock };
  await methods({ ...deps, identity: first }).upsertDirectory(
    ["a@example.test", "b@example.test", "c@example.test"].map(member),
    1,
  );
  await assert.rejects(methods({ ...deps, identity: first }).upsertDirectory([], 2), /deactivation incomplete/);
  assert.deepEqual(await directory.list(), []);
  assert.equal((await records.all()).length, 3);
  assert.deepEqual(revoked, ["a@example.test", "c@example.test"]);
  assert.equal((await directorySyncJournal.all())[0]!.removedIds.length, 3);
  const restarted = createIdentityService(records, {
    revokeSessions: async (id) => {
      revoked.push(id);
    },
  });
  await methods({ ...deps, identity: restarted }).upsertDirectory([], 3);
  assert.deepEqual(await directorySyncJournal.all(), []);
  assert.ok(revoked.includes("b@example.test"));
  for (const id of ["a@example.test", "b@example.test", "c@example.test"])
    assert.equal(await restarted.isActive(id), false);
});

test("a rejected stale roster does not change identity and leaves no pending operation", async () => {
  const directory = createDirectoryStore();
  const identity = createIdentityService();
  const directorySyncJournal = createMemoryMap<{
    members: DirectoryMember[];
    removedIds: string[];
    syncedAt?: number;
  }>();
  const app = methods({ directory, identity, directorySyncJournal });
  await app.upsertDirectory([member("alice@example.test")], 20);
  await app.upsertDirectory([], 10);
  assert.equal((await directory.list()).length, 1);
  assert.equal(await identity.isActive("alice@example.test"), true);
  assert.deepEqual(await directorySyncJournal.all(), []);
});

test("failure before writing the recovery journal preserves both roster and identity", async () => {
  const directory = createDirectoryStore();
  await directory.replace([member("alice@example.test")], 1);
  const identity = createIdentityService();
  const journal = createMemoryMap<{ members: DirectoryMember[]; removedIds: string[]; syncedAt?: number }>();
  const app = methods({
    directory,
    identity,
    directorySyncJournal: {
      ...journal,
      async put() {
        throw new Error("journal unavailable");
      },
    },
  });
  await assert.rejects(app.upsertDirectory([], 2), /journal unavailable/);
  assert.equal((await directory.list()).length, 1);
  assert.equal(await identity.isActive("alice@example.test"), true);
});
