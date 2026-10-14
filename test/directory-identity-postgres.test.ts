import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { createMessagingMethods } from "../src/api/app-messaging.ts";
import type { AppDeps } from "../src/api/app-types.ts";
import type { AppHelpers } from "../src/api/app-helpers.ts";
import type { AmbientHelpers } from "../src/api/app-ambient.ts";
import type { DirectoryMember } from "../src/directory/directory-store.ts";
import { createPostgresDirectoryStore } from "../src/directory/postgres-directory-store.ts";
import { createIdentityService, type DeactivationRecord } from "../src/identity/identity-service.ts";
import { createPostgresMapFactory } from "../src/persistence/durable-map.ts";
import { createPostgresAdvisoryLock } from "../src/persistence/advisory-lock.ts";

const url = process.env.DATABASE_URL;
test(
  "Postgres preserves interrupted directory identity batches and manual revocation across instances",
  { skip: !url },
  async () => {
    const suffix = randomUUID().replaceAll("-", "");
    const org = "identity-recovery-" + suffix;
    const oldOrg = process.env.ORG_ID;
    process.env.ORG_ID = org;
    const tables = ["identity_test_" + suffix, "identity_journal_test_" + suffix];
    const factories = [createPostgresMapFactory(url!), createPostgresMapFactory(url!)];
    const revoked: string[] = [];
    let fail = true;
    const members: DirectoryMember[] = ["a@example.test", "b@example.test", "c@example.test"].map((principalId) => ({
      principalId,
      displayName: principalId,
      type: "internal",
    }));
    const instances = factories.map((factory) => {
      const identity = createIdentityService(factory.map<DeactivationRecord>(tables[0]!), {
        revokeSessions: async (id) => {
          if (fail && id === "b@example.test") throw new Error("revocation fixture");
          revoked.push(id);
        },
      });
      const journal = factory.map<{ members: DirectoryMember[]; removedIds: string[]; syncedAt?: number }>(tables[1]!);
      const directory = createPostgresDirectoryStore(url!);
      const app = createMessagingMethods(
        {
          identity,
          directory,
          directorySyncJournal: journal,
          advisoryLock: createPostgresAdvisoryLock(factory.pool),
          auditLog: { record() {} },
        } as unknown as AppDeps,
        {} as AppHelpers,
        {} as AmbientHelpers,
      );
      return { identity, journal, directory, app };
    });
    try {
      const [left, right] = instances;
      await left!.app.upsertDirectory(members, 1);
      await assert.rejects(left!.app.upsertDirectory([], 2), /deactivation incomplete/);
      assert.equal((await right!.journal.all())[0]!.removedIds.length, 3);
      assert.deepEqual(await right!.directory.list(), []);
      assert.ok(revoked.includes("c@example.test"));
      for (const member of members) assert.equal(await right!.identity.isActive(member.principalId), false);
      fail = false;
      await right!.app.upsertDirectory([], 3);
      assert.deepEqual(await left!.journal.all(), []);
      assert.ok(revoked.includes("b@example.test"));
      await right!.identity.deactivate("a@example.test");
      await left!.app.upsertDirectory(members, 4);
      assert.equal(await left!.identity.isActive("a@example.test"), false);
      assert.equal(await right!.identity.isActive("b@example.test"), true);
    } finally {
      for (const table of tables) {
        await factories[0]!.pool.query(`DROP TABLE IF EXISTS ${table}`);
        await factories[0]!.pool.query("DELETE FROM durable_map_versions WHERE tbl=$1", [table]);
      }
      for (const table of ["directory_members", "directory_sync"])
        await factories[0]!.pool.query(`DELETE FROM ${table} WHERE org_id=$1`, [org]);
      await Promise.all(factories.map((factory) => factory.pool.close()));
      if (oldOrg === undefined) delete process.env.ORG_ID;
      else process.env.ORG_ID = oldOrg;
    }
  },
);
