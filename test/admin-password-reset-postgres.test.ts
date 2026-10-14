import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { createLoginPasswordStore, type LoginPasswordRecord } from "../src/auth/login-password-store.ts";
import { createPostgresMapFactory } from "../src/persistence/durable-map.ts";

const url = process.env.DATABASE_URL;

test(
  "password reset persists across connections and serializes concurrent administrators",
  { skip: !url },
  async () => {
    const table = "reset_test_" + randomUUID().replaceAll("-", "");
    const first = createPostgresMapFactory(url!);
    const second = createPostgresMapFactory(url!);
    const third = createPostgresMapFactory(url!);
    try {
      const writer = createLoginPasswordStore(first.map<LoginPasswordRecord>(table));
      const peer = createLoginPasswordStore(second.map<LoginPasswordRecord>(table));
      const id = "durable-fixture@example.test";
      const initial = await writer.putInitial({ id, initialPassword: "fixture-initial", updatedBy: "fixture" });
      assert.equal(await writer.setNew(id, "fixture-private", null, undefined, initial.version), "ok");
      const before = (await peer.get(id))!;
      const operations = [randomUUID(), randomUUID()];
      const results = await Promise.all([
        writer.resetInitial(id, "admin-one", before.version!, operations[0]!),
        peer.resetInitial(id, "admin-two", before.version!, operations[1]!),
      ]);
      assert.deepEqual([...results].sort(), ["conflict", "ok"]);
      const restarted = createLoginPasswordStore(third.map<LoginPasswordRecord>(table));
      const record = (await restarted.get(id))!;
      const winner = results.indexOf("ok");
      assert.equal(record.version, operations[winner]);
      assert.equal(record.forceChange, true);
      assert.equal(record.lastReset?.actor, winner === 0 ? "admin-one" : "admin-two");
      assert.equal((await restarted.verify(id, "fixture-private")).status, "invalid");
      assert.equal((await restarted.verify(id, "fixture-initial")).status, "ok");
      assert.equal(await restarted.resetInitial(id, record.lastReset!.actor, before.version!, record.version!), "ok");
      assert.equal((await restarted.get(id))!.version, record.version);
    } finally {
      await third.pool.query(`DROP TABLE IF EXISTS ${table}`);
      await third.pool.query("DELETE FROM durable_map_versions WHERE tbl = $1", [table]);
      await Promise.all([first.pool.close(), second.pool.close(), third.pool.close()]);
    }
  },
);
