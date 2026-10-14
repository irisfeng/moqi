import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { createLoginPasswordStore, type LoginPasswordRecord } from "../src/auth/login-password-store.ts";
import { createMemoryMap } from "../src/persistence/durable-map.ts";

const id = "reset-fixture@example.test";

test("reset restores initial hash, unlocks, rotates sessions and rejects old change tokens", async () => {
  const backing = createMemoryMap<LoginPasswordRecord>();
  const store = createLoginPasswordStore(backing);
  const initial = await store.putInitial({ id, initialPassword: "fixture-initial", updatedBy: "fixture" });
  assert.equal(await store.setNew(id, "fixture-private", null, undefined, initial.version), "ok");
  const before = (await store.get(id))!;
  for (let i = 0; i < 5; i++) await store.verify(id, "incorrect-fixture");
  assert.equal((await store.verify(id, "fixture-private")).status, "locked");
  const operation = randomUUID();
  assert.equal(await store.resetInitial(id, "admin-fixture", before.version!, operation), "ok");
  const restarted = createLoginPasswordStore(backing);
  const after = (await restarted.get(id))!;
  assert.equal(after.hash, initial.initialHash);
  assert.equal(after.forceChange, true);
  assert.equal(after.failedAttempts, 0);
  assert.equal(after.lockedUntil, 0);
  assert.equal(after.version, operation);
  assert.equal(after.lastReset?.actor, "admin-fixture");
  assert.equal((await restarted.verify(id, "fixture-private")).status, "invalid");
  assert.equal((await restarted.verify(id, "fixture-initial")).status, "ok");
  assert.equal(await restarted.setNew(id, "fixture-attacker", null, undefined, initial.version), "wrong-current");
  assert.equal(await restarted.setNew(id, "fixture-attacker", null), "wrong-current");
  assert.equal(await restarted.setNew(id, "fixture-initial", null, undefined, operation), "same-as-initial");
  assert.equal(await restarted.setNew(id, "fixture-new-private", null, undefined, operation), "ok");
  assert.equal(await restarted.setNew(id, "fixture-attacker", null, undefined, operation), "wrong-current");
});

test("repeated operations are idempotent and stale concurrent reset attempts cannot overwrite", async () => {
  const store = createLoginPasswordStore();
  const initial = await store.putInitial({ id, initialPassword: "fixture-initial", updatedBy: "fixture" });
  const operation = randomUUID();
  assert.equal(await store.resetInitial(id, "admin-fixture", initial.version!, operation), "ok");
  const first = await store.get(id);
  assert.equal(await store.resetInitial(id, "admin-fixture", initial.version!, operation), "ok");
  assert.deepEqual(await store.get(id), first);
  assert.equal(await store.resetInitial(id, "other-admin", operation, operation), "conflict");
  assert.equal(await store.setNew(id, "fixture-new-private", null, undefined, operation), "ok");
  assert.equal(await store.resetInitial(id, "admin-fixture", initial.version!, operation), "conflict");
  assert.equal((await store.verify(id, "fixture-new-private")).status, "ok");
  assert.equal(await store.resetInitial(id, "other-admin", initial.version!, randomUUID()), "conflict");
  assert.equal(await store.resetInitial("missing", "admin-fixture", "", randomUUID()), "no-credential");
});

test("an old reset retry cannot report a subsequently locked account as unlocked", async () => {
  const store = createLoginPasswordStore();
  const initial = await store.putInitial({ id, initialPassword: "fixture-initial", updatedBy: "fixture" });
  const operation = randomUUID();
  assert.equal(await store.resetInitial(id, "admin-fixture", initial.version!, operation), "ok");
  for (let i = 0; i < 5; i++) await store.verify(id, "incorrect-fixture");
  assert.equal(await store.resetInitial(id, "admin-fixture", initial.version!, operation), "conflict");
  assert.equal((await store.verify(id, "fixture-initial")).status, "locked");
});

test("a reset racing with password hashing prevents a stale password write", async () => {
  const backing = createMemoryMap<LoginPasswordRecord>();
  const baseUpdate = backing.update!;
  let beforeUpdate: (() => Promise<void>) | undefined;
  backing.update = async (key, fn) => {
    const action = beforeUpdate;
    beforeUpdate = undefined;
    await action?.();
    return baseUpdate(key, fn);
  };
  const store = createLoginPasswordStore(backing);
  const initial = await store.putInitial({ id, initialPassword: "fixture-initial", updatedBy: "fixture" });
  const operation = randomUUID();
  beforeUpdate = async () => {
    await store.resetInitial(id, "admin-fixture", initial.version!, operation);
  };
  assert.equal(await store.setNew(id, "stale-new-password", null, undefined, initial.version), "wrong-current");
  assert.equal((await store.get(id))!.version, operation);
  assert.equal((await store.verify(id, "stale-new-password")).status, "invalid");
});

test("a reset racing with verify cannot authenticate the previous password", async () => {
  const backing = createMemoryMap<LoginPasswordRecord>();
  const store = createLoginPasswordStore(backing);
  const initial = await store.putInitial({ id, initialPassword: "fixture-initial", updatedBy: "fixture" });
  await store.setNew(id, "private-before-reset", null, undefined, initial.version);
  const current = (await store.get(id))!;
  const update = backing.update!;
  let race = true;
  backing.update = async (key, fn) => {
    if (race) {
      race = false;
      await store.resetInitial(id, "admin-fixture", current.version!, randomUUID());
    }
    return update(key, fn);
  };
  assert.equal((await store.verify(id, "private-before-reset")).status, "invalid");
  assert.equal((await store.get(id))!.forceChange, true);
});
