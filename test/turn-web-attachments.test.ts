import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { projectGroupRef } from "../src/projects/project-store.ts";
import { buildApp } from "../src/wiring.ts";
import type { TurnRequest } from "../src/types.ts";
import { hashId } from "../src/util/crypto.ts";
import { testConfig } from "./support/test-config.ts";

async function projectApp() {
  const config = testConfig({ dataDir: mkdtempSync(join(tmpdir(), "ap-")) });
  config.spritesSandbox.namePrefix ??= `test-${hashId([config.dataDir]).slice(0, 10)}`;
  const built = buildApp(config);
  await built.app.upsertDirectory([
    { principalId: "fang", displayName: "Fang Ming", type: "internal" as const },
    { principalId: "zhu", displayName: "Zhu Ning", type: "internal" as const },
  ]);
  const project = await built.app.createProject("fang", "Colleagues");
  assert.ok(project);
  assert.equal((await built.app.addProjectMember(project.id, "fang", "zhu")).status, "ok");
  const channelRef = projectGroupRef(project.id);
  const group = (text: string, extra: Partial<TurnRequest> = {}): TurnRequest => ({
    surface: "web",
    actor: { externalId: "fang" },
    origin: { kind: "human" },
    conversation: { kind: "group", channelRef, threadRef: `${channelRef}:colleagues`, audience: [] },
    text,
    ...extra,
  });
  return { app: built.app, group };
}

const missingAttachment = { name: "notes.txt", mimetype: "text/plain", sizeBytes: 5, blobId: "never-staged" };

test("a web group message that mentions a colleague is recorded and gets no reply", async () => {
  const { app, group } = await projectApp();
  const res = await app.turn(group("@Zhu Ning please look at this plan"));
  assert.equal(res.status, "silent", res.reason);

  const found = await app.getSession(res.sessionId!);
  const users = found!.entries.filter((entry) => entry.type === "user");
  assert.equal(users.length, 1);
  assert.equal((users[0]!.payload as { text?: string }).text, "@Zhu Ning please look at this plan");
  assert.equal(
    found!.entries.some((entry) => entry.type === "assistant"),
    false,
  );
});

test("a web group message without a mention still gets a reply", async () => {
  const { app, group } = await projectApp();
  const res = await app.turn(group("what is your favorite color"));
  assert.equal(res.status, "ok", res.reason);
});

test("a web turn is refused when an attachment cannot be saved", async () => {
  const { app, group } = await projectApp();
  const res = await app.turn(
    group("summarize the attached notes", {
      conversation: { kind: "dm", threadRef: "web:fang:attachments" },
      attachments: [missingAttachment],
    }),
  );
  assert.equal(res.status, "refused");
  assert.match(res.reason ?? "", /Upload them again/);
});

test("a colleague message is refused when its attachment cannot be saved", async () => {
  const { app, group } = await projectApp();
  const res = await app.turn(group("@Zhu Ning see the attached notes", { attachments: [missingAttachment] }));
  assert.equal(res.status, "refused");
  assert.match(res.reason ?? "", /Upload them again/);
});
