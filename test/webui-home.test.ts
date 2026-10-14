import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { buildApp, type BuiltApp } from "../src/wiring.ts";
import { createInsecureTestServer } from "../src/api/server.ts";
import { testConfig } from "./support/test-config.ts";
import { createMemoryWebuiEventStore, isWebuiEventType, TASK_EVENT_TYPES } from "../src/webui/webui-events-store.ts";

const ADMIN = "admin-alice@default-org";

const HOME = {
  welcome: { headline: "今天要办什么？", subline: "", roles: [{ id: "a", label: "业务人员", tips: ["T02"] }] },
  composerPlaceholder: "描述任务交给它",
  tips: [
    {
      id: "T02",
      layer: "icebreak",
      title: "问我任何事",
      oneLiner: "",
      prompt: "帮我总结",
      capability: "",
      depts: [],
      status: "active",
    },
  ],
  nav: { advancedGroup: ["webhooks", "connectors", "memory"] },
  opener: { enabled: false },
};

describe("webui-home config seam", () => {
  let server: Server;
  let base: string;
  let built: BuiltApp;

  const adminSend = (method: string, path: string, body: unknown) =>
    fetch(`${base}${path}`, {
      method,
      headers: { "x-admin-actor": ADMIN, "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  before(async () => {
    built = buildApp(testConfig({ dataDir: mkdtempSync(join(tmpdir(), "webui-home-")) }));
    server = createInsecureTestServer(built.app, {
      admin: built.admin,
      auditLog: built.auditLog,
      config: built.config,
      webuiHome: built.webuiHome,
      webuiEvents: built.webuiEvents,
    });
    await new Promise<void>((r) => server.listen(0, r));
    base = `http://localhost:${(server.address() as AddressInfo).port}`;
  });
  after(() => new Promise<void>((r) => server.close(() => r())));

  test("unset config returns 404 so the web-ui falls back to built-in behavior", async () => {
    const r = await fetch(`${base}/v1/webui-home`);
    assert.equal(r.status, 404);
  });

  test("admin put stores the config and users read it back unchanged", async () => {
    const put = await adminSend("PUT", "/v1/admin/scopes/org:default-org/webui-home", { home: HOME });
    assert.equal(put.status, 200);
    const r = await fetch(`${base}/v1/webui-home`);
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), HOME);
  });

  test("invalid shapes are rejected", async () => {
    const noWelcome = await adminSend("PUT", "/v1/admin/scopes/org:default-org/webui-home", { home: { tips: [] } });
    assert.equal(noWelcome.status, 400);
    const personalScope = await adminSend("PUT", "/v1/admin/scopes/personal:u@x.cn/webui-home", { home: HOME });
    assert.equal(personalScope.status, 400);
  });

  test("clear restores the 404 fallback", async () => {
    await adminSend("PUT", "/v1/admin/scopes/org:default-org/webui-home", { clear: true });
    const r = await fetch(`${base}/v1/webui-home`);
    assert.equal(r.status, 404);
  });

  test("webui events record usage without awarding task progress", async () => {
    const bad = await fetch(`${base}/v1/webui-events`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ principalId: "u@x.cn", type: "webhook_recon", ref: "T99" }),
    });
    assert.equal(bad.status, 400);
    const ok = await fetch(`${base}/v1/webui-events`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ principalId: "u@x.cn", type: "example_card_click", ref: "T02" }),
    });
    assert.equal(ok.status, 204);
    const events = await built.webuiEvents.list({ principalId: "u@x.cn" });
    assert.equal(events.length, 1);
    assert.equal(events[0]?.type, "example_card_click");
  });
});

describe("webui event store", () => {
  test("type guard and task-event membership", () => {
    assert.equal(isWebuiEventType("example_card_click"), true);
    assert.equal(isWebuiEventType("tip_card_close"), true);
    assert.equal(isWebuiEventType("webhook_recon"), false);
    assert.ok(TASK_EVENT_TYPES.includes("guide_try_click"));
    assert.ok(!TASK_EVENT_TYPES.includes("tip_card_close"));
  });

  test("memory store records and filters", async () => {
    const store = createMemoryWebuiEventStore();
    await store.record("a@x.cn", "example_card_click", "T07");
    await store.record("a@x.cn", "tip_card_close", "T13");
    await store.record("b@x.cn", "guide_page_open", "");
    assert.equal((await store.list({ principalId: "a@x.cn" })).length, 2);
    const tasks = await store.list({ principalId: "a@x.cn", types: TASK_EVENT_TYPES });
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0]?.ref, "T07");
    assert.equal((await store.list({})).length, 3);
  });
});
