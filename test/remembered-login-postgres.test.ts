import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { test } from "node:test";
import { createLoginPasswordStore, type LoginPasswordRecord } from "../src/auth/login-password-store.ts";
import { createPostgresMapFactory } from "../src/persistence/durable-map.ts";

const url = process.env.DATABASE_URL;
test(
  "remembered devices persist, enforce one shared limit, and cannot survive concurrent reset or import in Postgres",
  { skip: !url },
  async () => {
    const table = "remember_test_" + randomUUID().replaceAll("-", "");
    const factories = Array.from({ length: 3 }, () => createPostgresMapFactory(url!));
    const stores = factories.map((factory) => createLoginPasswordStore(factory.map<LoginPasswordRecord>(table)));
    const [left, right, reader] = stores;
    const id = "postgres-login@example.test";
    try {
      await left!.putInitial({ id, initialPassword: "fixture-initial", updatedBy: "fixture" });
      await left!.setNew(id, "fixture-private", "fixture-initial");
      const version = (await right!.get(id))!.version!;
      const register = (index: number, expected = version) =>
        stores[index % 2]!.remember(id, expected, randomBytes(32).toString("hex"), {
          id: randomUUID(),
          label: "Postgres fixture",
          createdAt: Date.now(),
          expiresAt: Date.now() + 86400_000,
        });
      const results = await Promise.all(Array.from({ length: 30 }, (_, index) => register(index)));
      assert.equal(results.filter((value) => value === "ok").length, 20);
      assert.equal(results.filter((value) => value === "limit").length, 10);
      const persisted = await reader!.get(id);
      assert.equal(persisted!.devices!.length, 20);
      const sid = randomBytes(32).toString("hex");
      const device = { id: randomUUID(), label: "Recreated", createdAt: Date.now(), expiresAt: Date.now() + 86400_000 };
      await left!.revokeDevice(id, version, persisted!.devices![0]!.id);
      assert.equal(await right!.remember(id, version, sid, device), "ok");
      assert.equal(await left!.remember(id, version, sid, device), "ok");
      assert.equal((await reader!.get(id))!.devices!.length, 20);
      await right!.revokeSession(id, sid);
      assert.equal((await reader!.get(id))!.devices!.length, 19);
      await Promise.all([register(0), right!.resetInitial(id, "admin", version, randomUUID())]);
      assert.deepEqual((await reader!.get(id))!.devices, []);
      assert.equal(await register(1), "invalid");
      await left!.setNew(id, "fixture-next", "fixture-initial");
      const nextVersion = (await reader!.get(id))!.version!;
      await Promise.all([
        register(1, nextVersion),
        left!.putInitial({ id, initialPassword: "fixture-reimport", updatedBy: "operator" }),
      ]);
      assert.equal((await reader!.get(id))!.devices?.length ?? 0, 0);
      assert.equal(await register(0, nextVersion), "invalid");
      await left!.setNew(id, "fixture-returning", "fixture-reimport");
      const returningVersion = (await reader!.get(id))!.version!;
      await Promise.all([register(0, returningVersion), right!.revokeAllSessions(id)]);
      assert.deepEqual((await reader!.get(id))!.devices, []);
      assert.notEqual((await reader!.get(id))!.version, returningVersion);
      assert.equal(await register(1, returningVersion), "invalid");
      const currentVersion = (await reader!.get(id))!.version!;
      assert.equal(await register(0, currentVersion), "ok");
    } finally {
      await factories[0]!.pool.query(`DROP TABLE IF EXISTS ${table}`);
      await factories[0]!.pool.query("DELETE FROM durable_map_versions WHERE tbl=$1", [table]);
      await Promise.all(factories.map((factory) => factory.pool.close()));
    }
  },
);
