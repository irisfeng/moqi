import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createPostgresGrantStore } from "../src/acl/postgres-grant-store.ts";
import { createMemoryDurableByteStore } from "../src/files/durable-byte-store.ts";
import { fileArtifactId, type PutFileInput } from "../src/files/file-artifact-store.ts";
import { createPostgresFileArtifactStore } from "../src/files/postgres-file-artifact-store.ts";
import { createPostgresRunStore } from "../src/runs/postgres-run-store.ts";
import { scopeId, type Grant } from "../src/types.ts";

const URL = process.env.DATABASE_URL;
const skip = URL ? false : "set DATABASE_URL (a Postgres) to run the inbound artifact tests";

const reader = scopeId("personal", "reader@test");

function fixture() {
  const runtime = createPostgresRunStore(URL!);
  const files = createPostgresFileArtifactStore(URL!, createMemoryDurableByteStore());
  const grants = createPostgresGrantStore(URL!);
  const sender = `sender-${randomUUID()}@test`;
  const owner = scopeId("personal", sender);
  const request = {
    actor: { id: sender, type: "internal" as const },
    conversation: { kind: "dm" as const, threadRef: randomUUID(), audience: [] },
    origin: { kind: "human" as const },
    text: "see attached",
  };
  const startRun = async () => (await runtime.runs.enqueue({ sessionId: randomUUID(), request })).run.id;
  const inbound = (runId: string, over: Partial<PutFileInput> = {}): PutFileInput => {
    const id = fileArtifactId(randomUUID(), "in", 0);
    return {
      id,
      ownerScopeId: owner,
      createdBy: sender,
      name: "notes.txt",
      path: `artifacts/${id}/notes.txt`,
      mimetype: "text/plain",
      data: Buffer.from("notes"),
      direction: "in",
      inboundRunId: runId,
      ...over,
    };
  };
  const grant = (id: string, over: Partial<Grant> = {}): Grant => ({
    ownerScopeId: owner,
    ref: id,
    granteeScopeId: reader,
    permission: "read",
    grantedBy: sender,
    ...over,
  });
  return { runtime, files, grants, startRun, inbound, grant, owner };
}

test("an inbound file is registered against one active run", { skip }, async () => {
  const f = fixture();
  try {
    const runId = await f.startRun();
    const input = f.inbound(runId);
    assert.equal((await f.files.put(input)).created, true);
    assert.equal((await f.files.put(input)).created, false, "the same run may register the same file again");
    await assert.rejects(f.files.put({ ...input, inboundRunId: await f.startRun() }), /belongs to another run/);
    await assert.rejects(f.files.put(f.inbound(runId, { direction: "out" })), /only inbound files/);

    const finished = await f.startRun();
    const claimed = await f.runtime.runs.claimById(finished, "inbound-artifact-test", 60000);
    assert.ok(claimed?.leaseToken);
    await f.runtime.runs.complete(claimed.id, claimed.leaseToken, { status: "ok", reply: "done" });
    await assert.rejects(f.files.put(f.inbound(finished)), /no longer active/);
  } finally {
    await f.runtime.close();
  }
});

test("a grant made for a run is read-only and only for a file that run registered", { skip }, async () => {
  const f = fixture();
  try {
    const runId = await f.startRun();
    const input = f.inbound(runId);
    await f.files.put(input);

    await f.grants.put(f.grant(input.id), runId);
    assert.equal((await f.grants.all()).filter((g) => g.ref === input.id).length, 1);
    await assert.rejects(f.grants.put(f.grant(input.id, { permission: "write" }), runId), /invalid inbound artifact/);
    await assert.rejects(f.grants.put(f.grant(input.id), await f.startRun()), /invalid inbound artifact/);

    const missing = fileArtifactId(randomUUID(), "in", 0);
    await assert.rejects(f.grants.put(f.grant(missing)), /artifact resource does not exist/);
  } finally {
    await f.runtime.close();
  }
});

test("a file that still has grants is not deleted", { skip }, async () => {
  const f = fixture();
  try {
    const runId = await f.startRun();
    const input = f.inbound(runId);
    await f.files.put(input);
    await f.grants.put(f.grant(input.id), runId);

    await f.files.delete(input.id);
    assert.ok(await f.files.get(input.id), "a granted file survives delete");

    await f.grants.remove(f.grant(input.id));
    await f.files.delete(input.id);
    assert.equal(await f.files.get(input.id), null);
  } finally {
    await f.runtime.close();
  }
});
