import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";

const calls: { method: string; url: string; actor: string | null; signed: boolean; body: string }[] = [];
const core = createServer((req: IncomingMessage, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    calls.push({
      method: req.method ?? "",
      url: req.url ?? "",
      actor: (req.headers["x-admin-actor"] as string) ?? null,
      signed: Boolean(req.headers["x-timestamp"] && req.headers["x-signature"]),
      body,
    });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ announcements: [] }));
  });
});
await new Promise<void>((r) => core.listen(0, r));
const corePort = (core.address() as AddressInfo).port;

process.env.CORE_API_URL = `http://localhost:${corePort}`;
process.env.CORE_SIGNING_SECRET = "admin-announcements-proxy-secret";

const { server } = await import("../src/index.ts");
await new Promise<void>((r) => server.listen(0, r));
const base = `http://localhost:${(server.address() as AddressInfo).port}`;
test.after(() => {
  server.close();
  if (core.listening) core.close();
});

const ADMIN = "admin=U-ann";

test("GET /api/announcements forwards to /v1/admin/announcements with the actor + a source-auth signature", async () => {
  const r = await fetch(`${base}/api/announcements`, { headers: { cookie: ADMIN } });
  assert.equal(r.status, 200);
  const c = calls.at(-1)!;
  assert.equal(c.method, "GET");
  assert.equal(c.url, "/v1/admin/announcements");
  assert.equal(c.actor, "U-ann@acme");
  assert.equal(c.signed, true);
});

test("POST /api/announcements forwards the publish payload untouched", async () => {
  const draft = {
    level: "maintenance",
    title: "今晚停机维护",
    body: "22:00-23:00 升级数据库，期间无法使用。",
    startsAt: 1780000000000,
    endsAt: 1780003600000,
  };
  const r = await fetch(`${base}/api/announcements`, {
    method: "POST",
    headers: { cookie: ADMIN, "content-type": "application/json" },
    body: JSON.stringify(draft),
  });
  assert.equal(r.status, 200);
  const c = calls.at(-1)!;
  assert.equal(c.method, "POST");
  assert.equal(c.url, "/v1/admin/announcements");
  assert.deepEqual(JSON.parse(c.body), draft);
  assert.equal(c.actor, "U-ann@acme");
  assert.equal(c.signed, true);
});

test("PUT /api/announcements/:id forwards the id + takedown body", async () => {
  const r = await fetch(`${base}/api/announcements/ann-1`, {
    method: "PUT",
    headers: { cookie: ADMIN, "content-type": "application/json" },
    body: JSON.stringify({ endsAt: 1780000100000 }),
  });
  assert.equal(r.status, 200);
  const c = calls.at(-1)!;
  assert.equal(c.method, "PUT");
  assert.equal(c.url, "/v1/admin/announcements/ann-1");
  assert.deepEqual(JSON.parse(c.body), { endsAt: 1780000100000 });
  assert.equal(c.actor, "U-ann@acme");
});

test("announcements require a signed-in cookie → 401 when absent (no core hop)", async () => {
  const before = calls.length;
  assert.equal((await fetch(`${base}/api/announcements`)).status, 401);
  assert.equal(
    (
      await fetch(`${base}/api/announcements`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      })
    ).status,
    401,
  );
  assert.equal(
    (
      await fetch(`${base}/api/announcements/ann-1`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: "{}",
      })
    ).status,
    401,
  );
  assert.equal(calls.length, before, "a signed-out request is rejected at the surface, never forwarded");
});
