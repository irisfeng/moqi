import { adoptionDatabase } from "./support/adoption-database.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createAdoptionStore } from "../src/admin/adoption-store.ts";
import { createPostgresRunStore } from "../src/runs/postgres-run-store.ts";

const databaseAvailable = Boolean(process.env.DATABASE_URL);
async function catchUp(store: ReturnType<typeof createAdoptionStore>) {
  for (let batch = 0; batch < 100; batch++) {
    const result = await store.sync();
    if (result.processed < 500) return;
  }
  throw new Error("fixture projection did not catch up");
}
test(
  "adoption reports zero-use members and counts the human actor once across attempts",
  { skip: !databaseAvailable },
  async (t) => {
    const database = await adoptionDatabase(t);
    const runtime = createPostgresRunStore(database!);
    const store = createAdoptionStore(database!, "org:adoption-test", runtime.runs);
    const actor = `adoption-${randomUUID()}@test`;
    const idle = `idle-${randomUUID()}@test`;
    try {
      const roster = await store.roster();
      await store.saveRoster(
        {
          revision: roster.revision,
          source: "verified test allowlist",
          members: [
            {
              principalId: actor,
              displayName: "成员甲",
              department: "交付",
              eligibleFrom: 1,
              eligibleTo: null,
              isTest: false,
            },
            {
              principalId: idle,
              displayName: "成员乙",
              department: "交付",
              eligibleFrom: 1,
              eligibleTo: null,
              isTest: false,
            },
          ],
        },
        "admin@test",
      );
      const request = {
        actor: { id: actor.toUpperCase(), type: "internal" as const },
        conversation: { kind: "dm" as const, threadRef: randomUUID(), audience: [] },
        origin: { kind: "human" as const },
        text: "private text must not enter analytics",
      };
      await runtime.runs.enqueue({ sessionId: randomUUID(), request, dedupKey: actor });
      await runtime.runs.enqueue({ sessionId: randomUUID(), request, dedupKey: actor });
      await runtime.runs.enqueue({ sessionId: randomUUID(), request: { ...request, origin: { kind: "automation" } } });
      const now = Date.now();
      await catchUp(store);
      const report = await store.report({ from: now - 86400000, to: now + 1000, department: "交付", search: actor });
      assert.equal(report.members.length, 1);
      assert.equal(report.summary.coverage, null);
      assert.equal(report.members[0]!.requests, 1);
      assert.equal(report.members[0]!.activeDays, 1);
      const zeros = await store.report({ from: now - 86400000, to: now + 1000, search: idle });
      assert.equal(zeros.members[0]!.requests, 0);
      assert.equal(zeros.summary.activePeople, 0);
      assert.equal(JSON.stringify(report).includes(request.text), false);
      await catchUp(store);
      assert.equal((await store.report({ from: now - 86400000, to: now + 1000, search: actor })).summary.requests, 1);
    } finally {
      await store.close();
      await runtime.close();
    }
  },
);

test(
  "roster rejects invalid and duplicate identities and preserves concurrent edits",
  { skip: !databaseAvailable },
  async (t) => {
    const database = await adoptionDatabase(t);
    const runtime = createPostgresRunStore(database!);
    const store = createAdoptionStore(database!, `org:${randomUUID()}`, runtime.runs);
    const member = {
      principalId: "Person@Test",
      displayName: "甲",
      department: null,
      eligibleFrom: null,
      eligibleTo: null,
      isTest: false,
    };
    try {
      await assert.rejects(
        store.saveRoster(
          { revision: 0, source: "核验名单", members: [member, { ...member, principalId: "person@test" }] },
          "admin",
        ),
      );
      await assert.rejects(
        store.saveRoster(
          { revision: 0, source: "核验名单", members: [{ ...member, eligibleFrom: 20, eligibleTo: 10 }] },
          "admin",
        ),
      );
      await store.saveRoster({ revision: 0, source: "核验名单", members: [member] }, "admin");
      await assert.rejects(store.saveRoster({ revision: 0, source: "旧版本", members: [member] }, "admin"));
      assert.equal((await store.roster()).members[0]!.principalId, "person@test");
      const report = await store.report({ from: 0, to: Date.now() });
      assert.equal(report.summary.coverage, null);
      assert.equal(report.quality.unknownEligibility, 1);
    } finally {
      await store.close();
      await runtime.close();
    }
  },
);

test(
  "late terminal results refresh after restart without turning retries into new activity",
  { skip: !databaseAvailable },
  async (t) => {
    const database = await adoptionDatabase(t);
    const org = `org:${randomUUID()}`;
    const runtime = createPostgresRunStore(database!);
    let store = createAdoptionStore(database!, org, runtime.runs);
    const principal = `${randomUUID()}@test`;
    try {
      await store.saveRoster(
        {
          revision: 0,
          source: "test",
          members: [
            {
              principalId: principal,
              displayName: "甲",
              department: "研发",
              eligibleFrom: 1,
              eligibleTo: null,
              isTest: false,
            },
          ],
        },
        "admin",
      );
      const request = {
        actor: { id: principal, type: "internal" as const },
        origin: { kind: "human" as const },
        conversation: { kind: "dm" as const, threadRef: randomUUID(), audience: [] },
        text: "request",
      };
      const enqueued = await runtime.runs.enqueue({ sessionId: randomUUID(), request });
      let claimed = await runtime.runs.claimById(enqueued.run.id, "adoption-test", 60000);
      assert.ok(claimed?.leaseToken);
      await catchUp(store);
      await runtime.runs.fail(claimed.id, claimed.leaseToken, "retry", { retry: true });
      claimed = await runtime.runs.claimById(enqueued.run.id, "adoption-test", 60000);
      assert.ok(claimed?.leaseToken);
      await runtime.runs.complete(claimed.id, claimed.leaseToken, { status: "ok", reply: "done" });
      await store.close();
      store = createAdoptionStore(database!, org, runtime.runs);
      await catchUp(store);
      let result = await store.report({ from: 1, to: Date.now() + 1 });
      for (let batch = 0; batch < 40 && result.summary.pending; batch++) {
        await store.sync();
        result = await store.report({ from: 1, to: Date.now() + 1 });
      }
      assert.equal(result.summary.requests, 1);
      assert.equal(result.summary.succeeded, 1);
      assert.equal(result.summary.terminal, 1);
      assert.equal(result.summary.pending, 0);
    } finally {
      await store.close();
      await runtime.close();
    }
  },
);

test(
  "Beijing day boundaries are half-open and unknown eligibility never becomes a denominator",
  { skip: !databaseAvailable },
  async (t) => {
    const database = await adoptionDatabase(t);
    const org = `org:${randomUUID()}`;
    const runtime = createPostgresRunStore(database!);
    const store = createAdoptionStore(database!, org, runtime.runs);
    const principal = `${randomUUID()}@test`;
    const from = Date.parse("2026-09-01T00:00:00+08:00");
    const to = from + 2 * 86400000;
    try {
      await store.saveRoster(
        {
          revision: 0,
          source: "fixture",
          members: [
            {
              principalId: principal,
              displayName: "边界",
              department: null,
              eligibleFrom: null,
              eligibleTo: null,
              isTest: false,
            },
          ],
        },
        "admin",
      );
      t.mock.timers.enable({ apis: ["Date"], now: from - 1 });
      for (const at of [from - 1, from, from + 86399999, from + 86400000, to]) {
        t.mock.timers.setTime(at);
        await runtime.runs.enqueue({
          sessionId: randomUUID(),
          request: {
            actor: { id: principal, type: "internal" },
            origin: { kind: "human" },
            conversation: { kind: "dm", threadRef: randomUUID(), audience: [] },
            text: "synthetic",
          },
        });
      }
      t.mock.timers.reset();
      await catchUp(store);
      const r = await store.report({ from, to });
      assert.equal(r.members[0]!.requests, 3);
      assert.equal(r.members[0]!.activeDays, 2);
      assert.equal(r.members[0]!.firstObservedAt, from - 1);
      assert.equal(r.summary.coverage, null);
    } finally {
      t.mock.timers.reset();
      await store.close();
      await runtime.close();
    }
  },
);

test(
  "projection reports incomplete batches and catches up without a truncated report",
  { skip: !databaseAvailable },
  async (t) => {
    const database = await adoptionDatabase(t);
    const org = `org:${randomUUID()}`;
    const runtime = createPostgresRunStore(database!);
    const store = createAdoptionStore(database!, org, runtime.runs);
    const principal = `${randomUUID()}@test`;
    try {
      await store.saveRoster(
        {
          revision: 0,
          source: "batch fixture",
          members: [
            {
              principalId: principal,
              displayName: "回填",
              department: "批次",
              eligibleFrom: 1,
              eligibleTo: null,
              isTest: false,
            },
          ],
        },
        "admin",
      );
      for (let i = 0; i < 501; i++)
        await runtime.runs.enqueue({
          sessionId: randomUUID(),
          request: {
            actor: { id: principal, type: "internal" },
            origin: { kind: "human" },
            conversation: { kind: "dm", threadRef: randomUUID(), audience: [] },
            text: "fixture",
          },
        });
      await store.sync();
      const window = { from: 1, to: Date.now() + 1000 };
      let report = await store.report(window);
      assert.equal(report.quality.projectionPending, true);
      assert.equal(report.summary.coverage, null);
      for (let i = 0; i < 20 && report.quality.projectionPending; i++) {
        await store.sync();
        report = await store.report(window);
      }
      assert.equal(report.quality.projectionPending, false);
      assert.equal(report.members[0]!.requests, 501);
      assert.equal(report.summary.activePeople, 1);
    } finally {
      await store.close();
      await runtime.close();
    }
  },
);

test(
  "withdrawn projected requests become source-unknown and incomplete history never yields coverage",
  { skip: !databaseAvailable },
  async (t) => {
    const database = await adoptionDatabase(t);
    const runtime = createPostgresRunStore(database!);
    const store = createAdoptionStore(database!, `org:${randomUUID()}`, runtime.runs);
    const principal = `${randomUUID()}@test`;
    try {
      await store.saveRoster(
        {
          revision: 0,
          source: "fixture",
          members: [
            {
              principalId: principal,
              displayName: "已停用",
              department: "交付",
              eligibleFrom: 1,
              eligibleTo: 2,
              isTest: false,
            },
          ],
        },
        "admin",
      );
      const enqueued = await runtime.runs.enqueue({
        sessionId: randomUUID(),
        request: {
          actor: { id: principal, type: "internal" },
          origin: { kind: "human" },
          conversation: { kind: "dm", threadRef: randomUUID(), audience: [] },
          text: "fixture",
        },
      });
      await catchUp(store);
      assert.equal(await runtime.runs.withdraw(enqueued.run.id), true);
      await catchUp(store);
      const report = await store.report({ from: 1, to: Date.now() + 1000 });
      assert.equal(report.summary.pending, 0);
      assert.equal(report.summary.coverage, null);
      assert.equal(report.summary.activePeople, 0);
      assert.equal(report.summary.otherActivePeople, 1);
      assert.equal(report.quality.sourceMissingRequests, 1);
      assert.equal(report.members[0]!.requests, 1);
    } finally {
      await store.close();
      await runtime.close();
    }
  },
);

test(
  "report and projection initialize a fresh source schema without another runtime read",
  { skip: !databaseAvailable },
  async (t) => {
    const database = await adoptionDatabase(t);
    const { default: pg } = await import("pg");
    const pool = new pg.Pool({ connectionString: database });
    const schema = "adoption_cold_" + randomUUID().replaceAll("-", "");
    await pool.query(`CREATE SCHEMA ${schema}`);
    const url = new URL(database!);
    url.searchParams.set("options", `-c search_path=${schema}`);
    const runtime = createPostgresRunStore(url.toString());
    const store = createAdoptionStore(url.toString(), "org:cold", runtime.runs);
    try {
      const report = await store.report({ from: Date.now() - 86400000, to: Date.now() });
      assert.equal(report.members.length, 0);
      assert.equal(report.quality.checkedAt, null);
      assert.equal((await store.sync()).processed, 0);
    } finally {
      await store.close();
      await runtime.close();
      await pool.query(`DROP SCHEMA ${schema} CASCADE`);
      await pool.end();
    }
  },
);

test(
  "one source database refuses adoption reads or writes for a second organization",
  { skip: !databaseAvailable },
  async (t) => {
    const database = await adoptionDatabase(t);
    const runtime = createPostgresRunStore(database);
    const first = createAdoptionStore(database, "org:first", runtime.runs);
    const other = createAdoptionStore(database, "org:other", runtime.runs);
    try {
      await first.roster();
      await assert.rejects(other.sync(), /organization/);
      await assert.rejects(other.roster(), /organization/);
      await assert.rejects(other.report({ from: Date.now() - 86400000, to: Date.now() }), /organization/);
    } finally {
      await first.close();
      await other.close();
      await runtime.close();
    }
  },
);

test(
  "a foreign row in the source database pauses adoption work without stopping the process",
  { skip: !databaseAvailable },
  async (t) => {
    const database = await adoptionDatabase(t);
    const { default: pg } = await import("pg");
    const pool = new pg.Pool({ connectionString: database });
    const runtime = createPostgresRunStore(database);
    const first = createAdoptionStore(database, "org:first", runtime.runs);
    await first.roster();
    await first.close();
    await pool.query("INSERT INTO adoption_roster_versions VALUES('first',1,'operator','manual row',1,'[]'::jsonb)");
    const restarted = createAdoptionStore(database, "org:first", runtime.runs);
    let runs = 0;
    try {
      await assert.rejects(restarted.prepare(), /organization/);
      await restarted.whenAvailable(() => runs++);
      await restarted.whenAvailable(() => runs++);
      assert.equal(runs, 0, "background work waits while the foreign row is there");
      await pool.query("DELETE FROM adoption_roster_versions WHERE org='first'");
      await restarted.whenAvailable(() => runs++);
      assert.equal(runs, 1, "work resumes once the row is gone, without a restart");
    } finally {
      await restarted.close();
      await runtime.close();
      await pool.end();
    }
  },
);

test(
  "unattributed human activity remains visible in quality rather than disappearing",
  { skip: !databaseAvailable },
  async (t) => {
    const database = await adoptionDatabase(t);
    const runtime = createPostgresRunStore(database);
    const store = createAdoptionStore(database, "org:quality", runtime.runs);
    try {
      await runtime.runs.enqueue({
        sessionId: randomUUID(),
        request: {
          actor: { id: "guest-fixture", type: "guest" },
          origin: { kind: "human" },
          conversation: { kind: "dm", threadRef: randomUUID(), audience: [] },
          text: "synthetic",
        },
      });
      await store.sync();
      const report = await store.report({ from: Date.now() - 86400000, to: Date.now() + 1 });
      assert.equal(report.quality.unattributedRequests, 1);
      assert.equal(report.quality.unregisteredActors, 0);
      assert.equal(report.summary.requests, 0);
      assert.equal(report.dataThrough, null);
      assert.equal(report.coverageStatus, "unknown-retention");
    } finally {
      await store.close();
      await runtime.close();
    }
  },
);

test(
  "period-end eligibility means the last instant of the half-open window",
  { skip: !databaseAvailable },
  async (t) => {
    const database = await adoptionDatabase(t);
    const runtime = createPostgresRunStore(database);
    const store = createAdoptionStore(database, "org:boundary", runtime.runs);
    const from = Date.parse("2026-09-01T00:00:00+08:00");
    const to = from + 7 * 86400000;
    try {
      await store.saveRoster(
        {
          revision: 0,
          source: "boundary fixture",
          members: [
            {
              principalId: "ends-before@test",
              displayName: "停用于首日",
              department: null,
              eligibleFrom: from - 1,
              eligibleTo: from,
              isTest: false,
            },
            {
              principalId: "ends-after@test",
              displayName: "停用于下期首日",
              department: null,
              eligibleFrom: from - 1,
              eligibleTo: to,
              isTest: false,
            },
            {
              principalId: "starts-after@test",
              displayName: "开通于下期首日",
              department: null,
              eligibleFrom: to,
              eligibleTo: null,
              isTest: false,
            },
          ],
        },
        "admin",
      );
      const report = await store.report({ from, to });
      assert.equal(report.members.find((m) => m.principalId === "ends-before@test")!.eligible, false);
      assert.equal(report.members.find((m) => m.principalId === "ends-after@test")!.eligible, true);
      assert.equal(report.members.find((m) => m.principalId === "starts-after@test")!.eligible, false);
    } finally {
      await store.close();
      await runtime.close();
    }
  },
);

test(
  "stops, failures and refusals remain distinct from successful returns",
  { skip: !databaseAvailable },
  async (t) => {
    const database = await adoptionDatabase(t);
    const runtime = createPostgresRunStore(database);
    const store = createAdoptionStore(database, "org:results", runtime.runs);
    const principal = "results@example.test";
    try {
      await store.saveRoster(
        {
          revision: 0,
          source: "fixture",
          members: [
            {
              principalId: principal,
              displayName: "结果分类",
              department: null,
              eligibleFrom: 1,
              eligibleTo: null,
              isTest: false,
            },
          ],
        },
        "admin",
      );
      for (const result of [
        { status: "ok" as const },
        { status: "ok" as const, stopped: true },
        { status: "failed" as const },
        { status: "refused" as const },
      ]) {
        const { run } = await runtime.runs.enqueue({
          sessionId: randomUUID(),
          request: {
            actor: { id: principal, type: "internal" },
            origin: { kind: "human" },
            conversation: { kind: "dm", threadRef: randomUUID(), audience: [] },
            text: "synthetic",
          },
        });
        const claimed = await runtime.runs.claimById(run.id, "test", 60000);
        await runtime.runs.complete(run.id, claimed!.leaseToken!, result);
      }
      await store.sync();
      const report = await store.report({ from: Date.now() - 86400000, to: Date.now() + 1 });
      assert.equal(report.summary.succeeded, 1);
      assert.equal(report.summary.stopped, 1);
      assert.equal(report.summary.failed, 1);
      assert.equal(report.summary.otherTerminal, 1);
      assert.equal(report.summary.terminal, 4);
      assert.equal(report.summary.failureRate, 0.5);
    } finally {
      await store.close();
      await runtime.close();
    }
  },
);

test(
  "directory aliases combine existing facts after late directory sync and survive store restart",
  { skip: !databaseAvailable },
  async (t) => {
    const database = await adoptionDatabase(t);
    const runtime = createPostgresRunStore(database);
    const { createPostgresDirectoryStore } = await import("../src/directory/postgres-directory-store.ts");
    const directory = createPostgresDirectoryStore(database);
    let store = createAdoptionStore(database, "org:aliases", runtime.runs, directory);
    const member = {
      principalId: "person@example.test",
      displayName: "成员",
      department: "部门",
      eligibleFrom: 1,
      eligibleTo: null,
      isTest: false,
    };
    try {
      await store.saveRoster({ revision: 0, source: "fixture", members: [member] }, "admin");
      for (const id of ["PERSON@example.test", "U12345"]) {
        await runtime.runs.enqueue({
          sessionId: randomUUID(),
          request: {
            actor: { id, type: "internal" },
            origin: { kind: "human" },
            conversation: { kind: "dm", threadRef: randomUUID(), audience: [] },
            text: "synthetic",
          },
        });
      }
      await store.sync();
      const window = { from: Date.now() - 86400000, to: Date.now() + 1 };
      assert.equal((await store.report(window)).quality.unregisteredRequests, 1);
      await directory.replace([
        { principalId: member.principalId, displayName: member.displayName, type: "internal", slackId: "U12345" },
      ]);
      await store.close();
      store = createAdoptionStore(database, "org:aliases", runtime.runs, createPostgresDirectoryStore(database));
      const report = await store.report(window);
      assert.equal(report.summary.activePeople, 1);
      assert.equal(report.summary.requests, 2);
      assert.equal(report.members[0]!.activeDays, 1);
      assert.equal(report.quality.unregisteredRequests, 0);
      assert.equal(
        report.trend.reduce((n, day) => n + day.activePeople, 0),
        1,
      );
      assert.ok(report.members[0]!.firstObservedAt);
      await assert.rejects(
        store.saveRoster(
          { revision: 1, source: "fixture", members: [member, { ...member, principalId: "U12345" }] },
          "admin",
        ),
        /share one directory identity/,
      );
    } finally {
      await store.close();
      await runtime.close();
    }
  },
);

test(
  "malformed retained JSON is durable quality evidence and cannot block healthy records",
  { skip: !databaseAvailable },
  async (t) => {
    const database = await adoptionDatabase(t);
    const runtime = createPostgresRunStore(database);
    let store = createAdoptionStore(database, "org:malformed", runtime.runs);
    const { default: pg } = await import("pg");
    const pool = new pg.Pool({ connectionString: database });
    try {
      await store.saveRoster(
        {
          revision: 0,
          source: "fixture",
          members: [
            {
              principalId: "person@example.test",
              displayName: "成员",
              department: null,
              eligibleFrom: 1,
              eligibleTo: null,
              isTest: false,
            },
          ],
        },
        "admin",
      );
      for (const kind of ["request", "result", "healthy"]) {
        const { run } = await runtime.runs.enqueue({
          sessionId: randomUUID(),
          request: {
            actor: { id: "person@example.test", type: "internal" },
            origin: { kind: "human" },
            conversation: { kind: "dm", threadRef: randomUUID(), audience: [] },
            text: "synthetic",
          },
        });
        const claimed = await runtime.runs.claimById(run.id, "test", 60000);
        await runtime.runs.complete(run.id, claimed!.leaseToken!, { status: "ok" });
        if (kind === "request") await pool.query("UPDATE runs SET request=$2 WHERE id=$1", [run.id, "{broken"]);
        if (kind === "result") await pool.query("UPDATE runs SET result=$2 WHERE id=$1", [run.id, "null"]);
      }
      await store.sync();
      await store.close();
      store = createAdoptionStore(database, "org:malformed", runtime.runs);
      assert.equal((await store.sync()).processed, 0);
      const report = await store.report({ from: Date.now() - 86400000, to: Date.now() + 1 });
      assert.equal(report.quality.malformedRecords, 2);
      assert.equal(report.quality.projectionPending, false);
      assert.equal(report.summary.requests, 2);
      assert.equal(report.summary.succeeded, 1);
      assert.equal(report.summary.unknownTerminal, 1);
    } finally {
      await store.close();
      await runtime.close();
      await pool.end();
    }
  },
);

test(
  "proactive openers cannot count as human adoption even with an explicit human origin",
  { skip: !databaseAvailable },
  async (t) => {
    const database = await adoptionDatabase(t);
    const runtime = createPostgresRunStore(database);
    const store = createAdoptionStore(database, "org:openers", runtime.runs);
    try {
      await store.saveRoster(
        {
          revision: 0,
          source: "fixture",
          members: [
            {
              principalId: "person@example.test",
              displayName: "成员",
              department: null,
              eligibleFrom: 1,
              eligibleTo: null,
              isTest: false,
            },
          ],
        },
        "admin",
      );
      for (const proactiveOpener of [true, false]) {
        await runtime.runs.enqueue({
          sessionId: randomUUID(),
          request: {
            actor: { id: "person@example.test", type: "internal" },
            origin: { kind: "human" },
            proactiveOpener,
            conversation: { kind: "dm", threadRef: randomUUID(), audience: [] },
            text: "synthetic",
          },
        });
      }
      await store.sync();
      const report = await store.report({ from: Date.now() - 86400000, to: Date.now() + 1 });
      assert.equal(report.summary.requests, 1);
      assert.equal(report.summary.activePeople, 1);
      assert.equal(report.members[0]!.requests, 1);
    } finally {
      await store.close();
      await runtime.close();
    }
  },
);
