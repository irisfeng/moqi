import "./support/auto-fake-sprites.ts";

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { toFileItem } from "../src/api/app-types.ts";
import { artifactPath, fileArtifactId, type FileArtifact } from "../src/files/file-artifact-store.ts";
import { createMemoryFileOriginStore } from "../src/files/file-origin-store.ts";
import { scopeId, type TurnRequest } from "../src/types.ts";
import { buildApp } from "../src/wiring.ts";
import { settle } from "./support/settle.ts";
import { testConfig } from "./support/test-config.ts";

function artifact(patch: Partial<FileArtifact>): FileArtifact {
  return {
    id: "a".repeat(32),
    ownerScopeId: "personal:U1",
    createdBy: "U1",
    name: "report.pdf",
    path: artifactPath("a".repeat(32), "report.pdf"),
    mimetype: "application/pdf",
    sizeBytes: 10,
    blobKey: "blob",
    sha256: null,
    direction: "out",
    source: "live",
    createdAt: 1,
    updatedAt: 1,
    enabled: true,
    ...patch,
  };
}

test("a file is a deliverable only when the assistant attached it to a reply", () => {
  assert.equal(toFileItem(artifact({})).delivered, true);
  assert.equal(toFileItem(artifact({ direction: "in" })).delivered, false, "an upload is a working file");
  assert.equal(
    toFileItem(artifact({ path: "reports/draft.md" })).delivered,
    false,
    "a file written in the workspace without being attached is a working file",
  );
});

test("the first conversation recorded for a file is kept", async () => {
  const store = createMemoryFileOriginStore();
  await store.record({ artifactId: "f1", sessionId: "s1", runId: "r1", recordedAt: 1 });
  await store.record({ artifactId: "f1", sessionId: "s2", runId: "r2", recordedAt: 2 });
  const found = await store.forFiles(["f1", "unknown"]);
  assert.deepEqual([...found.keys()], ["f1"]);
  assert.equal(found.get("f1")!.sessionId, "s1");
});

test("a project file names its conversation only to someone who can see that conversation", async () => {
  const built = buildApp(testConfig({ dataDir: mkdtempSync(join(tmpdir(), "file-origins-")) }));
  const dm = (externalId: string, thread: string): TurnRequest => ({
    surface: "test",
    actor: { externalId },
    conversation: { kind: "dm", threadRef: thread },
    text: "hello",
  });
  const mine = await built.app.turn(dm("U1", "web:U1:mine"));
  const theirs = await built.app.turn(dm("U2", "web:U2:theirs"));
  await settle(async () =>
    (await built.sessions.listByParticipant("U1")).some((session) => session.id === mine.sessionId),
  );
  const scope = scopeId("personal", "U1");
  const put = async (seed: string, name: string) => {
    const id = fileArtifactId(seed, "out", 0);
    await built.files.put({
      id,
      ownerScopeId: scope,
      createdBy: "U1",
      name,
      path: artifactPath(id, name),
      mimetype: "text/plain",
      data: Buffer.from("content"),
      direction: "out",
      createdInScope: scope,
    });
    return id;
  };
  const fromMine = await put("one", "mine.txt");
  const fromTheirs = await put("two", "theirs.txt");
  const unlinked = await put("three", "unlinked.txt");
  await built.fileOrigins.record({ artifactId: fromMine, sessionId: mine.sessionId!, runId: null, recordedAt: 1 });
  await built.fileOrigins.record({ artifactId: fromTheirs, sessionId: theirs.sessionId!, runId: null, recordedAt: 1 });

  const resources = await built.app.listScopeResources("U1", scope);
  assert.ok(resources);
  const byId = new Map(resources.files.map((file) => [file.id, file]));
  assert.equal(byId.get(fromMine)?.session?.id, mine.sessionId);
  assert.equal(byId.get(fromMine)?.delivered, true);
  assert.equal(byId.get(fromTheirs)?.session, undefined, "another person's conversation is not named");
  assert.equal(byId.get(unlinked)?.session, undefined);
});

test("the orchestrator records the conversation for every file it registers during a turn", () => {
  const source = readFileSync(new URL("../src/core/orchestrator.ts", import.meta.url), "utf8");
  assert.match(
    source,
    /onRegistered: async \(\{ id, ownerScopeId, direction \}\) => \{\s+await deps\.fileOrigins\s+\?\.record\(\{ artifactId: id, sessionId: session\.id, runId: input\.runId \?\? null, recordedAt: Date\.now\(\) \}\)/,
  );
});
