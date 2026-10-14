import { test } from "node:test";
import assert from "node:assert/strict";
import { createMessagingMethods } from "../src/api/app-messaging.ts";
import type { AppDeps } from "../src/api/app-types.ts";
import type { AppHelpers } from "../src/api/app-helpers.ts";
import type { AmbientHelpers } from "../src/api/app-ambient.ts";
import { createCronStore } from "../src/cron/cron-store.ts";
import { createMemoryCronFireReadStore, cronFireVersion } from "../src/cron/fire-read-store.ts";
import { findCronRun } from "../src/cron/run-result.ts";
import { createMemoryRunStore } from "../src/runs/memory-run-store.ts";
import type { OrchestratorInput } from "../src/core/orchestrator.ts";
import { scopeId } from "../src/types.ts";

const base = { action: "x", owner: "U1", createdBy: "U1", ownerScopeId: scopeId("personal", "U1") };

function setup() {
  const crons = createCronStore();
  const app = createMessagingMethods(
    { crons, cronFireReads: createMemoryCronFireReadStore(), auditLog: { record() {} } } as unknown as AppDeps,
    {} as AppHelpers,
    {} as AmbientHelpers,
  );
  return { crons, app };
}

test("a fire is unread until its current version is marked, and unread again when it changes", async () => {
  const { crons, app } = setup();
  const cron = await crons.create({ ...base, schedule: { everyMs: 60_000 } });
  await crons.recordFire(cron.id, { fireKey: "f1", threadRef: "cron:t1", firedAt: 1, status: "running" });
  assert.deepEqual(await app.cronUnreadCounts([cron.id], "U1"), { [cron.id]: 1 });

  const running = await app.getCronRun(cron.id, "f1");
  assert.equal(running!.version, cronFireVersion(running!));
  assert.equal(await app.markCronRunRead(cron.id, "f1", "U1", "0".repeat(32)), false);
  assert.equal(await app.markCronRunRead(cron.id, "missing", "U1", running!.version), false);
  assert.equal(await app.markCronRunRead(cron.id, "f1", "U1", running!.version), true);
  assert.deepEqual(await app.cronUnreadCounts([cron.id], "U1"), { [cron.id]: 0 });
  assert.deepEqual(await app.cronUnreadCounts([cron.id], "U2"), { [cron.id]: 1 });
  assert.equal(typeof (await app.getCronRuns(cron.id, {}, "U1")).runs[0]!.readAt, "number");
  assert.equal((await app.getCronRuns(cron.id, {}, "U2")).runs[0]!.readAt, undefined);

  await crons.recordFire(cron.id, {
    fireKey: "f1",
    threadRef: "cron:t1",
    firedAt: 1,
    endedAt: 2,
    status: "ok",
    reply: "done",
  });
  assert.deepEqual(await app.cronUnreadCounts([cron.id], "U1"), { [cron.id]: 1 });
  assert.equal((await app.getCronRuns(cron.id, {}, "U1")).runs[0]!.readAt, undefined);
  const finished = await app.getCronRun(cron.id, "f1");
  assert.notEqual(finished!.version, running!.version);
  assert.equal(await app.markCronRunRead(cron.id, "f1", "U1", running!.version), false);
  assert.equal(await app.markCronRunRead(cron.id, "f1", "U1", finished!.version), true);
  assert.deepEqual(await app.cronUnreadCounts([cron.id], "U1"), { [cron.id]: 0 });
});

test("read markers fold the viewer's email case", async () => {
  const { crons, app } = setup();
  const cron = await crons.create({ ...base, schedule: { everyMs: 60_000 } });
  await crons.recordFire(cron.id, { fireKey: "f1", threadRef: "cron:t1", firedAt: 1, endedAt: 2, status: "ok" });
  const fire = await app.getCronRun(cron.id, "f1");
  assert.equal(await app.markCronRunRead(cron.id, "f1", "Alice@Example.test", fire!.version), true);
  assert.deepEqual(await app.cronUnreadCounts([cron.id], "alice@example.test"), { [cron.id]: 0 });
});

test("a fire's run is found by the fire key, with or without a project version", async () => {
  const { runs } = createMemoryRunStore();
  const request = (threadRef: string, scopeVersion?: string) =>
    ({
      surface: "cron",
      actor: { id: "U1" },
      conversation: { kind: "dm", threadRef },
      ...(scopeVersion === undefined ? {} : { scopeVersion }),
    }) as unknown as OrchestratorInput;
  const plain = await runs.enqueue({ sessionId: "cron:t1", request: request("cron:t1"), dedupKey: "f1" });
  const project = await runs.enqueue({
    sessionId: "cron:t2",
    request: request("cron:t2", "7"),
    dedupKey: "f2:project-7",
  });
  await runs.enqueue({ sessionId: "cron:t3", request: request("cron:t3"), dedupKey: "f3-other" });

  assert.equal((await findCronRun(runs, "cron:t1", "f1"))?.id, plain.run.id);
  assert.equal((await findCronRun(runs, "cron:t2", "f2"))?.id, project.run.id);
  assert.equal(await findCronRun(runs, "cron:other", "f1"), null);
  assert.equal(await findCronRun(runs, "cron:t3", "f3"), null);
});
