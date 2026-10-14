import { randomBytes, randomUUID } from "node:crypto";
import { createMemoryMap } from "../src/persistence/durable-map.ts";
import type { LoginPasswordRecord } from "../src/auth/login-password-store.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createLoginPasswordStore,
  hashPassword,
  passwordMatches,
  validPasswordPolicy,
} from "../src/auth/login-password-store.ts";

test("password policy bounds length and rejects NUL", () => {
  assert.equal(validPasswordPolicy("short"), "password must be at least 8 characters");
  assert.equal(validPasswordPolicy("x".repeat(129)), "password must be at most 128 characters");
  assert.equal(validPasswordPolicy("ok-password\u0000"), "password contains an invalid character");
  assert.equal(validPasswordPolicy("ok-password"), null);
});

test("scrypt round-trip verifies and rejects", async () => {
  const stored = await hashPassword("correct horse");
  assert.ok(await passwordMatches(stored, "correct horse"));
  assert.ok(!(await passwordMatches(stored, "correct horsе")));
  assert.ok(!(await passwordMatches("garbage", "correct horse")));
  assert.ok(!(await passwordMatches("scrypt$16384$8$1$aaa$bbb", "correct horse")));
});

test("verify succeeds, tracks failures, locks after five", async () => {
  let nowMs = 1_000_000;
  const store = createLoginPasswordStore(undefined, () => nowMs);
  await store.putInitial({ id: "a@example.cn", initialPassword: "initial-pass", updatedBy: "test" });
  const ok = await store.verify("a@example.cn", "initial-pass");
  assert.deepEqual(ok, { status: "ok", forceChange: true, version: (await store.get("a@example.cn"))!.version });
  for (let i = 1; i <= 4; i++) {
    const bad = await store.verify("a@example.cn", "wrong-pass");
    assert.deepEqual(bad, { status: "invalid" });
  }
  const locked = await store.verify("a@example.cn", "wrong-pass");
  assert.equal(locked.status, "locked");
  const stillLocked = await store.verify("a@example.cn", "initial-pass");
  assert.equal(stillLocked.status, "locked");
  nowMs += 15 * 60 * 1000 + 1;
  const unlocked = await store.verify("a@example.cn", "initial-pass");
  assert.deepEqual(unlocked, { status: "ok", forceChange: true, version: (await store.get("a@example.cn"))!.version });
  const unknown = await store.verify("nobody@example.cn", "whatever-1");
  assert.deepEqual(unknown, { status: "invalid" });
});

test("a wrong password after a lock has expired starts a fresh count", async () => {
  let nowMs = 1_000_000;
  const store = createLoginPasswordStore(undefined, () => nowMs);
  await store.putInitial({ id: "a@example.cn", initialPassword: "initial-pass", updatedBy: "test" });
  for (let i = 1; i <= 5; i++) await store.verify("a@example.cn", "wrong-pass");
  nowMs += 15 * 60 * 1000 + 1;
  for (let i = 1; i <= 4; i++)
    assert.deepEqual(await store.verify("a@example.cn", "wrong-pass"), { status: "invalid" });
  assert.equal((await store.verify("a@example.cn", "initial-pass")).status, "ok");
});

test("a stored hash is checked with its own cost and refused above the current cost", async () => {
  const stored = await hashPassword("correct horse");
  const [, , r, p, salt, key] = stored.split("$");
  assert.ok(!(await passwordMatches(`scrypt$1024$${r}$${p}$${salt}$${key}`, "correct horse")));
  assert.ok(!(await passwordMatches(`scrypt$1048576$${r}$${p}$${salt}$${key}`, "correct horse")));
});

test("setNew enforces current, freshness, and difference from initial", async () => {
  const store = createLoginPasswordStore();
  await store.putInitial({ id: "a@example.cn", initialPassword: "initial-pass", updatedBy: "test" });
  assert.equal(await store.setNew("a@example.cn", "short", null), "weak-password");
  assert.equal(
    await store.setNew("a@example.cn", "initial-pass", null, undefined, (await store.get("a@example.cn"))!.version),
    "same-as-initial",
  );
  assert.equal(
    await store.setNew("a@example.cn", "brand-new-pass", null, undefined, (await store.get("a@example.cn"))!.version),
    "ok",
  );
  assert.equal((await store.get("a@example.cn"))?.forceChange, false);
  assert.equal(await store.setNew("a@example.cn", "another-pass-2", null), "wrong-current");
  assert.equal(await store.setNew("a@example.cn", "another-pass-2", "wrong-current"), "wrong-current");
  assert.equal(await store.setNew("a@example.cn", "another-pass-2", "brand-new-pass"), "ok");
  assert.equal(await store.setNew("ghost@example.cn", "whatever-1", null), "no-credential");
});

test("changed passwords cannot be restored through a retained initial credential", async () => {
  const store = createLoginPasswordStore();
  await store.putInitial({ id: "a@example.cn", initialPassword: "initial-pass", updatedBy: "test" });
  assert.equal(
    await store.setNew("a@example.cn", "brand-new-pass", null, undefined, (await store.get("a@example.cn"))!.version),
    "ok",
  );
  assert.deepEqual(await store.verify("a@example.cn", "initial-pass"), { status: "invalid" });
  assert.equal(await store.setNew("a@example.cn", "attacker-password", "initial-pass"), "wrong-current");
  assert.equal(await store.setNew("a@example.cn", "attacker-password", null), "wrong-current");
  assert.deepEqual(await store.verify("a@example.cn", "brand-new-pass"), {
    status: "ok",
    forceChange: false,
    version: (await store.get("a@example.cn"))!.version,
  });
});

test("remembered devices are hashed, bounded, idempotent, expiring and shared across instances", async () => {
  let at = Date.now();
  const backing = createMemoryMap<LoginPasswordRecord>();
  const left = createLoginPasswordStore(backing, () => at);
  const right = createLoginPasswordStore(backing, () => at);
  const id = "device@example.test";
  await left.putInitial({ id, initialPassword: "initial-device-password", updatedBy: "test" });
  await left.setNew(id, "changed-device-password", "initial-device-password");
  const version = (await left.get(id))!.version!;
  const create = () => ({
    sid: randomBytes(32).toString("hex"),
    device: { id: randomUUID(), label: "Browser\n" + "x".repeat(200), createdAt: at, expiresAt: at + 30 * 86400_000 },
  });
  const first = create();
  assert.equal(await left.remember(id, version, first.sid, first.device), "ok");
  assert.equal(await right.remember(id, version, first.sid, first.device), "ok");
  assert.equal((await right.get(id))!.devices!.length, 1);
  assert.ok(!JSON.stringify(await right.get(id)).includes(first.sid));
  assert.equal((await right.get(id))!.devices![0]!.label.length, 160);
  assert.ok(!(await right.get(id))!.devices![0]!.label.includes("\n"));
  const devices = Array.from({ length: 25 }, create);
  const results = await Promise.all(
    devices.map((entry, index) => (index % 2 ? left : right).remember(id, version, entry.sid, entry.device)),
  );
  assert.equal(results.filter((result) => result === "ok").length, 19);
  assert.equal(results.filter((result) => result === "limit").length, 6);
  assert.equal((await right.get(id))!.devices!.length, 20);
  await right.revokeSession(id, first.sid);
  assert.equal((await left.get(id))!.devices!.length, 19);
  assert.equal(await left.revokeDevice(id, version, devices[0]!.device.id, first.sid), false);
  assert.equal(await left.revokeDevice(id, version, devices[0]!.device.id), true);
  at += 30 * 86400_000;
  const next = create();
  assert.equal(await right.remember(id, version, next.sid, next.device), "ok");
  assert.equal((await left.get(id))!.devices!.length, 1);
});

test("reset, password change and credential import revoke devices under concurrent registration", async () => {
  const at = Date.now();
  const backing = createMemoryMap<LoginPasswordRecord>();
  const left = createLoginPasswordStore(backing, () => at);
  const right = createLoginPasswordStore(backing, () => at);
  const id = "race@example.test";
  await left.putInitial({ id, initialPassword: "initial-password", updatedBy: "test" });
  await left.setNew(id, "changed-password", "initial-password");
  const register = (version: string) =>
    right.remember(id, version, randomBytes(32).toString("hex"), {
      id: randomUUID(),
      label: "Browser",
      createdAt: at,
      expiresAt: at + 86400_000,
    });
  const old = (await left.get(id))!.version!;
  await Promise.all([register(old), left.resetInitial(id, "admin", old, randomUUID())]);
  assert.deepEqual((await right.get(id))!.devices, []);
  assert.equal(await register(old), "invalid");
  const reset = (await left.get(id))!.version!;
  assert.equal(await register(reset), "invalid");
  await left.setNew(id, "next-password", "initial-password");
  const changed = (await left.get(id))!.version!;
  await Promise.all([register(changed), left.setNew(id, "third-password", "next-password")]);
  assert.deepEqual((await right.get(id))!.devices, []);
  assert.equal(await register(changed), "invalid");
  const third = (await left.get(id))!.version!;
  await Promise.all([
    register(third),
    left.putInitial({ id, initialPassword: "reimported-password", updatedBy: "operator" }),
  ]);
  assert.equal((await right.get(id))!.devices?.length ?? 0, 0);
  assert.equal(await register(third), "invalid");
  await backing.delete(id);
  await assert.doesNotReject(left.revokeSession(id, "a".repeat(64)));
});
