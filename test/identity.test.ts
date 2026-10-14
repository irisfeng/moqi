import { test } from "node:test";
import assert from "node:assert/strict";
import { createIdentityService, type DeactivationRecord } from "../src/identity/identity-service.ts";
import type { ExternalMember } from "../src/identity/external-members.ts";
import { createMemoryMap } from "../src/persistence/durable-map.ts";
import { createLoginPasswordStore, type LoginPasswordRecord } from "../src/auth/login-password-store.ts";

const id = createIdentityService();

test("classifies a same-org member as internal", () => {
  const p = id.classify("U1");
  assert.equal(p.type, "internal");
  assert.equal(id.isInternal(p), true);
});

test("classifies a flagged Slack Connect user as guest", () => {
  const p = id.classify("U2", true);
  assert.equal(p.type, "guest");
  assert.equal(id.isInternal(p), false);
});

test("resolves bot assertions as internal automation callers", () => {
  const p = id.resolve({ externalId: "B1", isBot: true });
  assert.equal(p.type, "internal");
  assert.equal(id.isInternal(p), true);
});

test("audienceIsAllInternal is false if any member is non-internal (G1)", () => {
  const internal = id.classify("U1");
  const guest = id.classify("U2", true);
  assert.equal(id.audienceIsAllInternal([internal]), true);
  assert.equal(id.audienceIsAllInternal([internal, guest]), false);
});

test("audienceIsAllInternal is false for an empty audience (unknown ≠ all-internal)", () => {
  assert.equal(id.audienceIsAllInternal([]), false);
});

test("a deactivated principal classifies as non-internal (fail-closed source, §3)", async () => {
  const svc = createIdentityService();
  assert.equal(svc.classify("U-leaver").type, "internal");
  await svc.deactivate("U-leaver");
  const after = svc.classify("U-leaver");
  assert.equal(after.type, "guest");
  assert.equal(svc.isInternal(after), false);
  await svc.reactivate("U-leaver");
  assert.equal(svc.classify("U-leaver").type, "internal");
});

test("deactivation folds email case: a leaver stays out under any casing of their address", async () => {
  const svc = createIdentityService();
  await svc.deactivate("Alice@Corp.com");
  assert.equal(svc.classify("alice@corp.com").type, "guest");
  assert.equal(svc.classify("ALICE@CORP.COM").type, "guest");
  await svc.reactivate("alice@corp.com");
  assert.equal(svc.classify("Alice@Corp.com").type, "internal");
});

test("case fold does not merge distinct emails or touch non-email ids", async () => {
  const svc = createIdentityService();
  await svc.deactivate("bob@corp.com");
  assert.equal(svc.classify("bobby@corp.com").type, "internal");
  await svc.deactivate("U-Case");
  assert.equal(svc.classify("u-case").type, "internal");
});

test("durable rehydration folds a cased stored deactivation", async () => {
  const backing = createMemoryMap<DeactivationRecord>();
  const first = createIdentityService(backing);
  await first.deactivate("Carol@Corp.com");
  const second = createIdentityService(backing);
  await second.hydrate();
  assert.equal(second.classify("carol@corp.com").type, "guest");
});

test("deactivation is durable: a fresh service over the same backing rehydrates it", async () => {
  const backing = createMemoryMap<DeactivationRecord>();
  const first = createIdentityService(backing);
  await first.deactivate("U-leaver");

  const second = createIdentityService(backing);
  assert.equal(second.classify("U-leaver").type, "internal");
  await second.hydrate();
  assert.equal(second.classify("U-leaver").type, "guest");
});

test("a running instance refreshes deactivations written by another instance", async () => {
  const backing = createMemoryMap<DeactivationRecord>();
  const writer = createIdentityService(backing);
  const reader = createIdentityService(backing);
  await reader.hydrate();
  await writer.deactivate("U-leaver");
  assert.equal(reader.classify("U-leaver").type, "internal");
  await reader.refresh();
  assert.equal(reader.classify("U-leaver").type, "guest");
});

test("external members written by one instance reach another over the same backing", async () => {
  const externalMembers = createMemoryMap<ExternalMember>();
  const writer = createIdentityService(undefined, { externalMembers });
  const reader = createIdentityService(undefined, { externalMembers });
  await reader.hydrate();
  const now = Date.now();
  const member = (expiresAt: number): ExternalMember => ({
    email: "pat@partner.example",
    role: "member",
    expiresAt,
    invitedBy: "admin-alice",
    createdAt: now,
    updatedAt: now,
  });
  await writer.putExternalMember(member(now + 60_000));
  assert.equal(reader.externalMember("pat@partner.example"), undefined);
  await reader.refresh();
  assert.equal(reader.externalMember("Pat@Partner.example")?.expiresAt, now + 60_000);
  assert.equal(reader.classify("pat@partner.example").type, "internal");

  await writer.putExternalMember(member(now - 1));
  await reader.refresh();
  assert.equal(reader.classify("pat@partner.example").type, "internal", "within the TTL the cache is served");
  await reader.refresh(true);
  assert.equal(reader.classify("pat@partner.example").type, "guest", "a forced refresh reads the store");
  const late = createIdentityService(undefined, { externalMembers });
  await late.hydrate();
  assert.equal(late.classify("pat@partner.example").type, "guest");
});

test("a directory sync deactivates dropped members and self-heals when they reappear", async () => {
  const svc = createIdentityService();
  const out = await svc.recordDirectorySync(["U-gone"], ["U-here"]);
  assert.deepEqual(out, { deactivated: ["U-gone"], reactivated: [] });
  assert.equal(svc.classify("U-gone").type, "guest");

  const back = await svc.recordDirectorySync([], ["U-gone", "U-here"]);
  assert.deepEqual(back, { deactivated: [], reactivated: ["U-gone"] });
  assert.equal(svc.classify("U-gone").type, "internal");
});

test("a manual deactivation survives roster churn — only reactivate() clears it", async () => {
  const svc = createIdentityService();
  await svc.deactivate("U-fired");
  await svc.recordDirectorySync([], ["U-fired"]);
  assert.equal(svc.classify("U-fired").type, "guest");
  await svc.recordDirectorySync(["U-fired"], []);
  await svc.recordDirectorySync([], ["U-fired"]);
  assert.equal(svc.classify("U-fired").type, "guest");
  await svc.reactivate("U-fired");
  assert.equal(svc.classify("U-fired").type, "internal");
});

test("an overridden principal classifies internal even when flagged guest or deactivated", async () => {
  const overrides = new Set(["u-contractor"]);
  const svc = createIdentityService(createMemoryMap<DeactivationRecord>(), {
    isOverridden: (externalId) => overrides.has(externalId.trim().toLowerCase()),
  });
  assert.equal(svc.classify("U-CONTRACTOR", true).type, "internal");
  await svc.deactivate("U-CONTRACTOR");
  assert.equal(svc.classify("U-CONTRACTOR").type, "internal");
  assert.equal(svc.classify("U-OTHER", true).type, "guest");
});

test("revocation failure keeps deactivation durable and prevents reactivation until retry succeeds", async () => {
  const backing = createMemoryMap<DeactivationRecord>();
  let failing = true;
  const svc = createIdentityService(backing, {
    revokeSessions: async () => {
      if (failing) throw new Error("revocation unavailable");
    },
  });
  await assert.rejects(svc.deactivate("alice@example.test"), /revocation unavailable/);
  assert.equal(svc.classify("alice@example.test").type, "guest");
  assert.ok(await backing.get("alice@example.test"));
  const reader = createIdentityService(backing);
  await reader.hydrate();
  assert.equal(reader.classify("alice@example.test").type, "guest");
  await assert.rejects(svc.reactivate("alice@example.test"), /revocation unavailable/);
  assert.ok(await backing.get("alice@example.test"));
  assert.equal(svc.classify("alice@example.test").type, "guest");
  failing = false;
  await svc.reactivate("alice@example.test");
  assert.equal(await backing.get("alice@example.test"), null);
  assert.equal(svc.classify("alice@example.test").type, "internal");
});

test("reactivation revokes preexisting sessions written before lifecycle integration without changing the password", async () => {
  const backing = createMemoryMap<DeactivationRecord>();
  const passwords = createLoginPasswordStore(createMemoryMap<LoginPasswordRecord>());
  const principal = "legacy@example.test";
  await passwords.putInitial({ id: principal, initialPassword: "fixture-initial", updatedBy: "fixture" });
  await passwords.setNew(principal, "fixture-current", "fixture-initial");
  const before = (await passwords.get(principal))!;
  await createIdentityService(backing).deactivate(principal);
  const restarted = createIdentityService(backing, { revokeSessions: (id) => passwords.revokeAllSessions(id) });
  await restarted.hydrate();
  await restarted.reactivate(principal.toUpperCase());
  const after = (await passwords.get(principal))!;
  assert.notEqual(after.version, before.version);
  assert.equal(after.hash, before.hash);
  assert.equal(after.forceChange, false);
  assert.deepEqual(after.devices, []);
  assert.equal((await passwords.verify(principal, "fixture-current")).status, "ok");
  await restarted.deactivate("no-password@example.test");
  await restarted.reactivate("no-password@example.test");
  assert.equal(await passwords.get("no-password@example.test"), null);
});

test("a stale sibling directory sync cannot downgrade or reactivate a manual deactivation", async () => {
  const backing = createMemoryMap<DeactivationRecord>();
  const manual = createIdentityService(backing);
  const directory = createIdentityService(backing);
  await directory.refresh();
  await manual.deactivate("alice@example.test");
  assert.equal(await directory.isActive("alice@example.test"), false);
  await directory.recordDirectorySync(["alice@example.test"], []);
  await directory.recordDirectorySync([], ["alice@example.test"]);
  assert.equal((await backing.get("alice@example.test"))!.source, "manual");
  assert.equal(await manual.isActive("alice@example.test"), false);
});

test("a manual deactivation arriving during directory reactivation wins the conditional delete", async () => {
  const backing = createMemoryMap<DeactivationRecord>();
  const manual = createIdentityService(backing);
  await manual.deactivate("alice@example.test", "directory-sync");
  const started = Promise.withResolvers<void>();
  const resume = Promise.withResolvers<void>();
  const directory = createIdentityService(backing, {
    revokeSessions: async () => {
      started.resolve();
      await resume.promise;
    },
  });
  const sync = directory.recordDirectorySync([], ["alice@example.test"]);
  await started.promise;
  await manual.deactivate("alice@example.test");
  resume.resolve();
  assert.deepEqual(await sync, { deactivated: [], reactivated: [] });
  assert.equal((await backing.get("alice@example.test"))!.source, "manual");
  assert.equal(directory.classify("alice@example.test").type, "guest");
});

for (const action of ["hydrate", "refresh"] as const) {
  test(`an old ${action} snapshot cannot erase a completed local deactivation`, async () => {
    const backing = createMemoryMap<DeactivationRecord>();
    const started = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    const svc = createIdentityService({
      ...backing,
      async all() {
        const records = await backing.all();
        started.resolve();
        await resume.promise;
        return records;
      },
    });
    const reading = svc[action]();
    await started.promise;
    await svc.deactivate("alice@example.test");
    resume.resolve();
    await reading;
    assert.equal(svc.classify("alice@example.test").type, "guest");
    assert.ok(await backing.get("alice@example.test"));
  });
}

test("deactivation retries a failed durable insertion instead of trusting its provisional cache", async () => {
  const backing = createMemoryMap<DeactivationRecord>();
  let fail = true;
  const svc = createIdentityService({
    ...backing,
    async putIfAbsent(key, record) {
      if (fail) throw new Error("database unavailable");
      return backing.putIfAbsent(key, record);
    },
  });
  await assert.rejects(svc.deactivate("alice@example.test"), /database unavailable/);
  assert.equal(await backing.get("alice@example.test"), null);
  fail = false;
  await svc.deactivate("alice@example.test");
  assert.equal(await createIdentityService(backing).isActive("alice@example.test"), false);
});

test("reactivating an already active principal does not revoke unrelated sessions", async () => {
  let revocations = 0;
  const svc = createIdentityService(undefined, {
    revokeSessions: async () => {
      revocations++;
    },
  });
  await svc.reactivate("alice@example.test");
  assert.equal(revocations, 0);
});

test("pending and failed deactivations remain blocked across principal and full-store reads", async () => {
  const backing = createMemoryMap<DeactivationRecord>();
  const started = Promise.withResolvers<void>();
  const resume = Promise.withResolvers<void>();
  let fail = true;
  const svc = createIdentityService({
    ...backing,
    async putIfAbsent(key, record) {
      if (fail) {
        started.resolve();
        await resume.promise;
        throw new Error("database unavailable");
      }
      return backing.putIfAbsent(key, record);
    },
  });
  const writing = assert.rejects(svc.deactivate("alice@example.test"), /database unavailable/);
  await started.promise;
  assert.equal(await svc.isActive("alice@example.test"), false);
  await svc.refresh();
  assert.equal(svc.classify("alice@example.test").type, "guest");
  resume.resolve();
  await writing;
  await svc.refresh();
  assert.equal(await svc.isActive("alice@example.test"), false);
  assert.equal(svc.classify("alice@example.test").type, "guest");
  fail = false;
  await svc.deactivate("alice@example.test");
  await svc.reactivate("alice@example.test");
  assert.equal(await svc.isActive("alice@example.test"), true);
});

test("a sign-in check observes a peer deactivation inside the refresh window", async () => {
  const backing = createMemoryMap<DeactivationRecord>();
  const reader = createIdentityService(backing);
  const writer = createIdentityService(backing);
  await reader.refresh();
  await writer.deactivate("alice@example.test");
  await reader.refresh();
  assert.equal(reader.classify("alice@example.test").type, "internal");
  assert.equal(await reader.isActive("alice@example.test"), false);
  assert.equal(reader.classify("alice@example.test").type, "guest");
});

test("reactivation clears a block left by a deactivation that never reached the store", async () => {
  const backing = createMemoryMap<DeactivationRecord>();
  const svc = createIdentityService({
    ...backing,
    async putIfAbsent() {
      throw new Error("database unavailable");
    },
  });
  await assert.rejects(svc.deactivate("alice@example.test"), /database unavailable/);
  assert.equal(await svc.isActive("alice@example.test"), false);
  await svc.reactivate("alice@example.test");
  assert.equal(await svc.isActive("alice@example.test"), true);
});

test("an overridden principal stays active for sign-in while deactivated", async () => {
  const svc = createIdentityService(createMemoryMap<DeactivationRecord>(), {
    isOverridden: (id) => id === "owner@example.test",
  });
  await svc.deactivate("owner@example.test");
  assert.equal(await svc.isActive("owner@example.test"), true);
});

test("a precommit snapshot cannot unblock identity while session revocation is pending or failed", async () => {
  const backing = createMemoryMap<DeactivationRecord>();
  const writeStarted = Promise.withResolvers<void>();
  const writeResume = Promise.withResolvers<void>();
  const readStarted = Promise.withResolvers<void>();
  const readResume = Promise.withResolvers<void>();
  const revokeStarted = Promise.withResolvers<void>();
  const revokeResume = Promise.withResolvers<void>();
  const svc = createIdentityService(
    {
      ...backing,
      async putIfAbsent(key, record) {
        writeStarted.resolve();
        await writeResume.promise;
        return backing.putIfAbsent(key, record);
      },
      async all() {
        const snapshot = await backing.all();
        readStarted.resolve();
        await readResume.promise;
        return snapshot;
      },
    },
    {
      revokeSessions: async () => {
        revokeStarted.resolve();
        await revokeResume.promise;
        throw new Error("revocation unavailable");
      },
    },
  );
  const writing = assert.rejects(svc.deactivate("alice@example.test"), /revocation unavailable/);
  await writeStarted.promise;
  const reading = svc.refresh();
  await readStarted.promise;
  writeResume.resolve();
  await revokeStarted.promise;
  readResume.resolve();
  await reading;
  assert.ok(await backing.get("alice@example.test"));
  assert.equal(svc.classify("alice@example.test").type, "guest");
  revokeResume.resolve();
  await writing;
  assert.equal(svc.classify("alice@example.test").type, "guest");
  assert.equal(await svc.isActive("alice@example.test"), false);
});

test("a peer can finish revocation and reactivate after a durable local revocation failure", async () => {
  const backing = createMemoryMap<DeactivationRecord>();
  const failed = createIdentityService(backing, {
    revokeSessions: async () => {
      throw new Error("revocation unavailable");
    },
  });
  const peer = createIdentityService(backing);
  await assert.rejects(failed.deactivate("alice@example.test", "directory-sync"), /revocation unavailable/);
  await peer.recordDirectorySync(["alice@example.test"], []);
  await peer.recordDirectorySync([], ["alice@example.test"]);
  assert.equal(await failed.isActive("alice@example.test"), true);
  await failed.refresh();
  assert.equal(failed.classify("alice@example.test").type, "internal");
});
