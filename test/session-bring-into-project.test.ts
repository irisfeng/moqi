import "./support/auto-fake-sprites.ts";

import { test } from "node:test";
import assert from "node:assert/strict";
import { buildApp } from "../src/wiring.ts";
import { testConfig } from "./support/test-config.ts";
import { orgId } from "../src/config.ts";
import { scopeId } from "../src/types.ts";

const HOME = "personal:alice";

async function fixture() {
  const built = buildApp(testConfig());
  await built.app.upsertDirectory([
    { principalId: "alice", displayName: "Alice", type: "internal" },
    { principalId: "bob", displayName: "Bob", type: "internal" },
    { principalId: "carol", displayName: "Carol", type: "internal" },
  ]);
  const project = (await built.app.createProject("alice", "Launch"))!;
  const other = (await built.app.createProject("bob", "Bob only"))!;
  const added = await built.app.addProjectMember(project.id, "alice", "bob");
  assert.equal(added.status, "ok");

  const source = await built.sessions.getOrCreateByThread("web:alice:source", "dm", HOME, undefined, "web");
  await built.sessions.addParticipant(source.id, "alice");
  await built.sessions.updateTitle(source.id, "Launch plan");
  const { lease } = await built.sessions.acquireLease(source.id, "turn");
  assert.ok(lease);
  await built.sessions.append(lease, {
    type: "user",
    scopeLabel: HOME,
    payload: {
      text: "plan the launch",
      memoryRecall: "PRIVATE_SENTINEL likes tea",
      memoryContext: { kind: "memory_context", snapshot: { audience: "CONTEXT_SENTINEL" }, throughSeq: -1 },
      environment: "env-detail",
      environmentSnapshot: "SNAPSHOT_SENTINEL",
    },
  });
  await built.sessions.append(lease, {
    type: "thinking",
    scopeLabel: HOME,
    payload: { text: "THINKING_SENTINEL from the notebook" },
  });
  await built.sessions.append(lease, {
    type: "tool_call",
    scopeLabel: HOME,
    payload: { tool: "memory", action: "save", facts: ["CALL_SENTINEL"], callId: "m1" },
  });
  await built.sessions.append(lease, {
    type: "tool_result",
    scopeLabel: HOME,
    payload: { callId: "m1", isError: false, result: "NOTEBOOK_SENTINEL" },
  });
  await built.sessions.append(lease, {
    type: "system",
    scopeLabel: HOME,
    payload: { kind: "context_summary", text: "SUMMARY_SENTINEL" },
  });
  await built.sessions.append(lease, {
    type: "assistant",
    scopeLabel: "team:ops",
    payload: { text: "TEAM_SENTINEL" },
  });
  await built.sessions.append(lease, {
    type: "tool_call",
    scopeLabel: HOME,
    payload: { tool: "sessions", action: "search", query: "tea", callId: "s1" },
  });
  await built.sessions.append(lease, {
    type: "tool_result",
    scopeLabel: HOME,
    payload: { tool: "sessions", callId: "s1", isError: false, result: "OTHER_CHAT_SENTINEL" },
  });
  await built.sessions.append(lease, {
    type: "user",
    scopeLabel: HOME,
    payload: { text: "HIDDEN_SENTINEL opener", hidden: true },
  });
  await built.sessions.append(lease, {
    type: "user",
    scopeLabel: HOME,
    payload: { text: "DELETED_SENTINEL draft", ts: "1700000000.000100" },
  });
  await built.sessions.append(lease, {
    type: "system",
    scopeLabel: HOME,
    payload: { kind: "message_revision", action: "deleted", ts: "1700000000.000100" },
  });
  await built.sessions.append(lease, {
    type: "tool_call",
    scopeLabel: HOME,
    payload: { tool: "web_search", query: "launch dates", callId: "w1" },
  });
  await built.sessions.append(lease, {
    type: "tool_result",
    scopeLabel: scopeId("org", orgId()),
    payload: { tool: "web_search", callId: "w1", isError: false, result: "ORG_RESULT" },
  });
  await built.sessions.append(lease, {
    type: "system",
    scopeLabel: HOME,
    payload: { kind: "memory_context", snapshot: { audience: "abc" }, throughSeq: -1 },
  });
  await built.sessions.append(lease, { type: "assistant", scopeLabel: HOME, payload: { text: "here is the plan" } });
  await built.sessions.releaseLease(lease);

  const file = async (id: string, sessionId: string | null) => {
    await built.files.put({
      id,
      ownerScopeId: HOME,
      createdBy: "alice",
      name: `${id}.txt`,
      path: `${id}.txt`,
      mimetype: "text/plain",
      data: Buffer.from(id),
      direction: "out",
      createdInScope: HOME,
    });
    if (sessionId) await built.fileOrigins.record({ artifactId: id, sessionId, runId: null, recordedAt: 1 });
  };
  const elsewhere = await built.sessions.getOrCreateByThread("web:alice:elsewhere", "dm", HOME, undefined, "web");
  await file("FCHAT", source.id);
  await file("FOTHER", elsewhere.id);
  await file("FLOOSE", null);
  return { built, project, other, source };
}

test("an owner brings a personal chat into a project as a copy with provenance", async () => {
  const { built, project, source } = await fixture();
  const out = await built.app.forkSession(source.id, "alice", { targetScopeId: project.scopeId });
  assert.ok(out);
  assert.equal(out.session.scopeId, project.scopeId);
  assert.notEqual(out.session.id, source.id);
  assert.deepEqual(out.session.forkedFrom, { sessionId: source.id, title: "Launch plan" });
  assert.equal(out.session.title, "Launch plan");
  assert.equal(out.session.forkBoundarySeq, out.entries.at(-1)?.seq);
  assert.deepEqual(
    out.entries.filter((entry) => entry.type !== "system").map((entry) => entry.type),
    ["user", "tool_call", "tool_result", "assistant"],
  );
  const orgScope = scopeId("org", orgId());
  assert.ok(out.entries.every((entry) => entry.scopeLabel === project.scopeId || entry.scopeLabel === orgScope));
  assert.equal(out.entries.find((entry) => entry.type === "tool_result")?.scopeLabel, orgScope);
  assert.equal(out.session.surface, "web");
  const members = await built.sessions.listByParticipant("bob");
  assert.ok(members.some((session) => session.id === out.session.id));
  assert.equal((await built.sessions.get(source.id))?.scopeId, HOME);
});

test("the project copy carries no personal memory", async () => {
  const { built, project, source } = await fixture();
  const out = await built.app.forkSession(source.id, "alice", { targetScopeId: project.scopeId });
  assert.ok(out);
  const text = JSON.stringify(await built.sessions.getEntries(out.session.id));
  for (const sentinel of [
    "PRIVATE_SENTINEL",
    "CONTEXT_SENTINEL",
    "env-detail",
    "SNAPSHOT_SENTINEL",
    "THINKING_SENTINEL",
    "CALL_SENTINEL",
    "NOTEBOOK_SENTINEL",
    "SUMMARY_SENTINEL",
    "TEAM_SENTINEL",
    "OTHER_CHAT_SENTINEL",
    "HIDDEN_SENTINEL",
    "DELETED_SENTINEL",
    "memory_context",
  ])
    assert.ok(!text.includes(sentinel), sentinel);
  assert.match(text, /ORG_RESULT/);
  const plain = await built.app.forkSession(source.id, "alice");
  assert.ok(plain);
  const unfiltered = JSON.stringify(await built.sessions.getEntries(plain.session.id));
  for (const sentinel of [
    "PRIVATE_SENTINEL",
    "CONTEXT_SENTINEL",
    "THINKING_SENTINEL",
    "CALL_SENTINEL",
    "NOTEBOOK_SENTINEL",
    "TEAM_SENTINEL",
    "OTHER_CHAT_SENTINEL",
    "HIDDEN_SENTINEL",
  ])
    assert.ok(unfiltered.includes(sentinel), sentinel);
  assert.match(text, /plan the launch/);
  assert.match(text, /here is the plan/);
});

test("only files tied to the chat become readable by the project", async () => {
  const { built, project, source } = await fixture();
  assert.deepEqual(await built.acl.handlesFor([project.scopeId]), []);
  const out = await built.app.forkSession(source.id, "alice", { targetScopeId: project.scopeId });
  assert.ok(out);
  const handles = await built.acl.handlesFor([project.scopeId]);
  assert.deepEqual(
    handles.map((handle) => [handle.fileId, handle.permission, handle.ownerScopeId]),
    [["FCHAT", "read", HOME]],
  );
  assert.deepEqual(await built.acl.handlesFor(["personal:bob"]), []);
});

test("bringing a chat into a project is refused outside the owner's own projects", async () => {
  const { built, project, other, source } = await fixture();
  const refused = async (sessionId: string, principalId: string, targetScopeId: string) =>
    assert.equal(await built.app.forkSession(sessionId, principalId, { targetScopeId }), null);

  await refused(source.id, "alice", other.scopeId);
  await refused(source.id, "alice", "personal:alice");
  await refused(source.id, "alice", "channel:C1");
  await refused(source.id, "carol", project.scopeId);
  const empty = await built.sessions.getOrCreateByThread("web:alice:empty", "dm", HOME, undefined, "web");
  await built.sessions.addParticipant(empty.id, "alice");
  const { lease } = await built.sessions.acquireLease(empty.id, "turn");
  assert.ok(lease);
  await built.sessions.append(lease, { type: "thinking", scopeLabel: HOME, payload: { text: "only thoughts" } });
  await built.sessions.releaseLease(lease);
  const before = (await built.sessions.listByParticipant("bob")).length;
  await refused(empty.id, "alice", project.scopeId);
  assert.equal((await built.sessions.listByParticipant("bob")).length, before);
  await built.sessions.addParticipant(source.id, "bob");
  await refused(source.id, "bob", project.scopeId);

  const inProject = await built.app.forkSession(source.id, "alice", { targetScopeId: project.scopeId });
  assert.ok(inProject);
  await refused(inProject.session.id, "alice", project.scopeId);
  await refused(inProject.session.id, "bob", other.scopeId);
  assert.deepEqual(await built.acl.handlesFor(["personal:bob"]), []);
});
