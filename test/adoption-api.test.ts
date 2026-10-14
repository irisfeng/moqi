import { adoptionDatabase } from "./support/adoption-database.ts";
import "./support/auto-fake-sprites.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import { buildApp } from "../src/wiring.ts";
import { signRequest } from "../src/auth/source-auth.ts";
import { createAdminService } from "../src/admin/admin-service.ts";
import { createAdminGrantStore, createMemoryAdminGrantPersistence } from "../src/admin/admin-grant-store.ts";
import { scopeId } from "../src/types.ts";
import { createInsecureTestServer, createServer } from "../src/api/server.ts";
import { testConfig } from "./support/test-config.ts";
import { createAdoptionStore } from "../src/admin/adoption-store.ts";
import { createPostgresRunStore } from "../src/runs/postgres-run-store.ts";

const databaseAvailable = Boolean(process.env.DATABASE_URL);
test(
  "adoption HTTP is organization-admin only, validates dates and supports safe roster updates",
  { skip: !databaseAvailable },
  async (t) => {
    const database = await adoptionDatabase(t);
    const built = buildApp(testConfig({ adminGrants: "admin:org_admin" }));
    const runtime = createPostgresRunStore(database!);
    const adoption = createAdoptionStore(database!, `org:${randomUUID()}`, runtime.runs);
    const server = createInsecureTestServer(built.app, { admin: built.admin, auditLog: built.auditLog, adoption });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const request = (path: string, actor = "admin@default-org", body?: unknown) =>
      fetch(base + path, {
        method: body ? "PUT" : "GET",
        headers: { "x-admin-actor": actor, "content-type": "application/json" },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    try {
      assert.equal((await request("/v1/admin/adoption", "ordinary@default-org")).status, 403);
      assert.equal((await request("/v1/admin/adoption?scope=org:elsewhere")).status, 400);
      assert.equal((await request("/v1/admin/adoption?from=2026-02-31&to=2026-03-05")).status, 400);
      assert.equal((await request("/v1/admin/adoption?from=2025-01-01&to=2026-01-01")).status, 400);
      assert.equal((await request("/v1/admin/adoption")).status, 200);
      type Report = Awaited<ReturnType<typeof adoption.report>>;
      const today = Date.parse("2026-09-10T00:00:00+08:00");
      t.mock.timers.enable({ apis: ["Date"], now: today + 12 * 3600000 });
      try {
        const current = (await (await request("/v1/admin/adoption")).json()) as Report;
        assert.deepEqual(current.window, { from: today - 6 * 86400000, to: today + 86400000 });
        assert.equal(current.asOf, today + 12 * 3600000);
        assert.equal(current.partialDay, true);
        assert.equal(current.trend.length, 7);
        assert.equal(current.trend.at(-1)!.at, today);
        const sameDay = await request("/v1/admin/adoption?from=2026-09-10&to=2026-09-11");
        assert.equal(sameDay.status, 200);
        assert.equal(((await sameDay.json()) as Report).trend.length, 1);
        assert.equal((await request("/v1/admin/adoption?from=2026-09-10&to=2026-09-12")).status, 400);
        assert.equal((await request("/v1/admin/adoption?from=2026-09-11&to=2026-09-12")).status, 400);
        assert.equal((await request("/v1/admin/adoption?from=2026-09-10&to=2026-09-10")).status, 400);
        const historical = (await (await request("/v1/admin/adoption?from=2026-09-08&to=2026-09-10")).json()) as Report;
        assert.equal(historical.asOf, today);
        assert.equal(historical.partialDay, false);
        t.mock.timers.setTime(today);
        const midnight = (await (await request("/v1/admin/adoption?from=2026-09-10&to=2026-09-11")).json()) as Report;
        assert.equal(midnight.asOf, today);
        assert.equal(midnight.partialDay, true);
        assert.equal(midnight.trend.length, 1);
      } finally {
        t.mock.timers.reset();
      }
      const body = {
        revision: 0,
        source: "核验名单",
        members: [
          {
            principalId: "test-member@example.org",
            displayName: '=HYPERLINK("x")',
            department: "交付",
            eligibleFrom: null,
            eligibleTo: null,
            isTest: false,
          },
        ],
      };
      assert.equal((await request("/v1/admin/adoption/roster", undefined, body)).status, 200);
      assert.equal((await request("/v1/admin/adoption/roster", undefined, body)).status, 409);
      assert.equal(
        (await request("/v1/admin/adoption/roster", undefined, { ...body, revision: 1, org: "forged" })).status,
        400,
      );
      const csv = await request("/v1/admin/adoption/export?search=test-member");
      assert.equal(csv.status, 200);
      const bytes = new Uint8Array(await csv.arrayBuffer());
      assert.deepEqual(Array.from(bytes.slice(0, 3)), [239, 187, 191]);
      assert.ok(Buffer.from(bytes).toString().includes("'=HYPERLINK"));
      const rows = (await (await request("/v1/admin/adoption?search=test-member")).json()) as { members: unknown[] };
      assert.equal(rows.members.length, 1);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await adoption.close();
      await runtime.close();
    }
  },
);

test("signed ingress rejects forged access and an administrator granted only another organization", async () => {
  const built = buildApp(testConfig({ adminGrants: "admin:org_admin" }));
  const admin = createAdminService(
    createAdminGrantStore(createMemoryAdminGrantPersistence(), {
      seed: [{ principalId: "outsider", role: "org_admin", scopeId: scopeId("org", "elsewhere") }],
    }),
  );
  const secret = "adoption-ingress-test-secret".repeat(2);
  const server = createServer(built.app, { signingSecret: secret, admin });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    for (const [method, path] of [
      ["GET", "/v1/admin/adoption"],
      ["GET", "/v1/admin/adoption/export"],
      ["GET", "/v1/admin/adoption/roster"],
      ["PUT", "/v1/admin/adoption/roster"],
    ]) {
      assert.equal(
        (await fetch(base + path, { method, headers: { "x-admin-actor": "admin@default-org" } })).status,
        401,
      );
      const ts = Math.floor(Date.now() / 1000);
      const headers = {
        "x-admin-actor": "outsider@default-org",
        "x-timestamp": String(ts),
        "x-signature": signRequest(secret, ts, `${method}\n${path}\n`),
      };
      assert.equal((await fetch(base + path, { method, headers })).status, 403);
      headers["x-admin-actor"] = "admin@default-org";
      headers["x-signature"] = signRequest("forged", ts, `${method}\n${path}\n`);
      assert.equal((await fetch(base + path, { method, headers })).status, 401);
    }
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
