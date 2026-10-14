import { adoptionDatabase } from "./support/adoption-database.ts";
import "./support/auto-fake-sprites.ts";
import test from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import type { AddressInfo } from "node:net";
import { createAdoptionStore } from "../src/admin/adoption-store.ts";
import { createPostgresRunStore } from "../src/runs/postgres-run-store.ts";
import { buildApp } from "../src/wiring.ts";
import { createInsecureTestServer } from "../src/api/server.ts";
import { testConfig } from "./support/test-config.ts";

test(
  "Token report filters reconcile across summary, departments, people and real HTTP CSV",
  { skip: !process.env.DATABASE_URL },
  async (t) => {
    const database = await adoptionDatabase(t);
    const runtime = createPostgresRunStore(database);
    const store = createAdoptionStore(database, "org:token-test", runtime.runs);
    const pool = new pg.Pool({ connectionString: database });
    const built = buildApp(testConfig({ adminGrants: "admin:org_admin" }));
    const server = createInsecureTestServer(built.app, {
      admin: built.admin,
      auditLog: built.auditLog,
      adoption: store,
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const from = Date.parse("2026-09-01T00:00:00+08:00");
    const to = from + 7 * 86400000;
    try {
      const members = [
        { principalId: "alpha@test", displayName: "成员甲", department: "交付", isTest: false },
        { principalId: "beta@test", displayName: "成员乙", department: "运营", isTest: false },
        { principalId: "idle@test", displayName: "成员丙", department: null, isTest: false },
        { principalId: "test@test", displayName: "测试", department: "交付", isTest: true },
      ].map((m) => ({ ...m, eligibleFrom: 1, eligibleTo: null }));
      await store.saveRoster({ revision: 0, source: "synthetic", members }, "admin@test");
      assert.equal((await store.report({ from, to })).tokenQuality.available, false);
      await pool.query(
        "CREATE TABLE turn_metrics(id bigserial,session_id text,turn_seq int,run_id text,status text,ts bigint)",
      );
      await pool.query(
        "CREATE TABLE session_llm_requests(id text PRIMARY KEY,session_id text,turn_seq int,usage_json text,created_at bigint)",
      );
      let index = 0;
      for (const [principal, raw] of [
        ["alpha@test", JSON.stringify({ input: 100, output: 20, cacheRead: 60, cacheWrite: 10, totalTokens: 190 })],
        ["alpha@test", null],
        ["beta@test", JSON.stringify({ input: 200, output: 40, cacheRead: 0, cacheWrite: 0, totalTokens: 243 })],
        ["test@test", JSON.stringify({ input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 })],
        ["unknown@test", JSON.stringify({ input: 3, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 4 })],
      ] as const) {
        index++;
        await pool.query("INSERT INTO adoption_run_facts VALUES ('org:token-test',$1,$2,'human',$3,'done',true,$3)", [
          String(index),
          principal,
          from,
        ]);
        await pool.query("INSERT INTO turn_metrics(session_id,turn_seq,run_id) VALUES ('s',$1,$2)", [
          index,
          String(index),
        ]);
        await pool.query("INSERT INTO session_llm_requests VALUES ($1,'s',$2,$3,$4)", [
          String(index),
          index,
          raw,
          from,
        ]);
      }
      const all = await store.report({ from, to });
      assert.equal(all.summary.tokens.total, 433);
      assert.equal(all.summary.tokens.calls, 3);
      assert.equal(all.summary.tokens.other, 3);
      assert.equal(all.summary.tokens.measuredCalls, 2);
      assert.equal(
        all.members.reduce((n, m) => n + m.tokens.total, 0),
        433,
      );
      assert.equal(
        all.departmentMetrics.reduce((n, m) => n + m.tokens.total, 0),
        433,
      );
      assert.equal(all.tokenQuality.excludedTest.total, 2);
      assert.equal(all.tokenQuality.unregistered.total, 4);
      assert.equal(all.members.find((m) => m.principalId === "idle@test")!.tokens.measuredCalls, 0);
      const filtered = await store.report({ from, to, department: "交付", search: "成员甲" });
      assert.equal(filtered.summary.tokens.total, 190);
      assert.equal(filtered.members.length, 1);
      assert.equal(filtered.tokenQuality.unregistered.total, 4);
      assert.equal((await store.report({ from, to, department: "No dept" })).members.length, 1);
      assert.equal((await store.report({ from: to, to: to + 86400000 })).summary.tokens.measuredCalls, 0);
      assert.equal((await store.report({ from, to, search: "no-match" })).summary.tokens.calls, 0);
      const query = "/v1/admin/adoption/export?from=2026-09-01&to=2026-09-08&department=" + encodeURIComponent("交付");
      const denied = await fetch(base + query, { headers: { "x-admin-actor": "ordinary@default-org" } });
      assert.equal(denied.status, 403);
      assert.equal(denied.headers.get("cache-control"), "no-store");
      const response = await fetch(base + query, { headers: { "x-admin-actor": "admin@default-org" } });
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("cache-control"), "no-store");
      const bytes = new Uint8Array(await response.arrayBuffer());
      assert.deepEqual(Array.from(bytes.slice(0, 3)), [239, 187, 191]);
      const csv = Buffer.from(bytes).toString();
      assert.ok(csv.includes('"Total tokens recorded"'));
      assert.ok(csv.includes('"交付","190","100","20","60","10","0","1","2"'));
      assert.ok(!csv.includes("成员乙"));
      assert.ok(!csv.includes("测试"));
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await pool.end();
      await store.close();
      await runtime.close();
    }
  },
);

test("unconfigured statistics API is not cacheable", async () => {
  const built = buildApp(testConfig({ adminGrants: "admin:org_admin" }));
  const server = createInsecureTestServer(built.app, { admin: built.admin, auditLog: built.auditLog });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/admin/adoption`, {
      headers: { "x-admin-actor": "admin@default-org" },
    });
    assert.equal(response.status, 503);
    assert.equal(response.headers.get("cache-control"), "no-store");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test(
  "current Beijing day uses one cutoff for requests and Tokens without including future records",
  { skip: !process.env.DATABASE_URL },
  async (t) => {
    const database = await adoptionDatabase(t);
    const runtime = createPostgresRunStore(database);
    const store = createAdoptionStore(database, "org:today-test", runtime.runs);
    const pool = new pg.Pool({ connectionString: database });
    const day = 86400000;
    const today = Date.parse("2026-09-10T00:00:00+08:00");
    try {
      await store.saveRoster(
        {
          revision: 0,
          source: "synthetic",
          members: [
            {
              principalId: "today@test",
              displayName: "当天测试",
              department: "测试部门",
              eligibleFrom: 1,
              eligibleTo: null,
              isTest: false,
            },
          ],
        },
        "admin@test",
      );
      await pool.query(
        "CREATE TABLE turn_metrics(id bigserial,session_id text,turn_seq int,run_id text,status text,ts bigint)",
      );
      await pool.query(
        "CREATE TABLE session_llm_requests(id text PRIMARY KEY,session_id text,turn_seq int,usage_json text,created_at bigint)",
      );
      const times = [
        today - 1,
        today,
        today + 12 * 3600000 - 1,
        today + 12 * 3600000,
        today + 13 * 3600000,
        today + day,
      ];
      for (const [i, at] of times.entries()) {
        await pool.query(
          "INSERT INTO adoption_run_facts VALUES ('org:today-test',$1,'today@test','human',$2,'done',true,$2,2)",
          [String(i), at],
        );
        await pool.query("INSERT INTO turn_metrics(session_id,turn_seq,run_id) VALUES ('today-session',$1,$2)", [
          i,
          String(i),
        ]);
        await pool.query("INSERT INTO session_llm_requests VALUES ($1,'today-session',$2,$3,$4)", [
          String(i),
          i,
          JSON.stringify({ input: 100, output: 20, cacheRead: 60, cacheWrite: 10, totalTokens: 190 }),
          at,
        ]);
      }
      t.mock.timers.enable({ apis: ["Date"], now: today + 12 * 3600000 });
      const report = await store.report({ from: today, to: today + day, department: "测试部门" });
      assert.deepEqual(report.window, { from: today, to: today + day, department: "测试部门" });
      assert.equal(report.asOf, today + 12 * 3600000);
      assert.equal(report.partialDay, true);
      assert.equal(report.summary.requests, 2);
      assert.equal(report.summary.tokens.total, 380);
      assert.equal(report.summary.tokens.measuredCalls, 2);
      assert.deepEqual(report.trend, [{ at: today, requests: 2, activePeople: 1 }]);
      assert.equal(report.summary.steadyObservedPeople, null);
      t.mock.timers.setTime(today);
      const midnight = await store.report({ from: today, to: today + day });
      assert.equal(midnight.summary.requests, 0);
      assert.equal(midnight.summary.tokens.measuredCalls, 0);
      assert.deepEqual(midnight.trend, [{ at: today, requests: 0, activePeople: 0 }]);
      t.mock.timers.setTime(today + day);
      const closed = await store.report({ from: today, to: today + day });
      assert.equal(closed.partialDay, false);
      assert.equal(closed.summary.requests, 4);
      assert.equal(closed.summary.tokens.total, 760);
      const previous = await store.report({ from: today - day, to: today });
      assert.equal(previous.summary.requests, 1);
      assert.equal(previous.summary.tokens.total, 190);
    } finally {
      t.mock.timers.reset();
      await pool.end();
      await store.close();
      await runtime.close();
    }
  },
);
