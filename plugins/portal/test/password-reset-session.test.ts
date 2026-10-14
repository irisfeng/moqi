import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { deriveKey, seal } from "../src/session.ts";

let activeVersion = "before-reset";
let forceChange = false;
let unavailable = false;
let proxied = 0;
let targetActive = true;
let adminActive = true;
const core = createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", (chunk) => chunks.push(chunk));
  req.on("end", () => {
    const url = new URL(req.url ?? "/", "http://fixture");
    res.setHeader("content-type", "application/json");
    if (url.pathname === "/v1/auth/password/session") {
      assert.ok(req.headers["x-signature"]);
      if (unavailable) {
        res.writeHead(503);
        return void res.end("{}");
      }
      const body = JSON.parse(Buffer.concat(chunks).toString());
      return void res.end(
        JSON.stringify({
          valid: !forceChange && body.version === activeVersion && (!body.impersonatedPrincipalId || targetActive),
        }),
      );
    }
    if (url.pathname === "/v1/surface-config") return void res.end("{}");
    if (url.pathname === "/api/whoami") return void res.end(JSON.stringify({ isAdmin: adminActive }));
    proxied++;
    res.end('{"fixture":true}');
  });
});
await new Promise<void>((resolve) => core.listen(0, "127.0.0.1", resolve));
const upstream = `http://127.0.0.1:${(core.address() as AddressInfo).port}`;
const secret = "password-session-fixture-secret";
process.env.PORTAL_PUBLIC_URL = "http://portal.example.test";
process.env.PORTAL_SESSION_SECRET = secret;
process.env.CORE_SIGNING_SECRET = "password-session-source-fixture";
process.env.CORE_ORG_ID = "fixture";
process.env.WEB_UI_UPSTREAM = upstream;
process.env.ADMIN_UPSTREAM = upstream;
process.env.CORE_API_URL = upstream;
process.env.AUTH_BROKER_UPSTREAM = upstream;
const { server } = await import("../src/index.ts");
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
test.after(() => {
  server.close();
  core.close();
});

function cookie(version: string) {
  const now = Math.floor(Date.now() / 1000);
  return (
    "portal_session=" +
    seal(
      {
        k: "session",
        sub: "fixture@example.test",
        org: "fixture",
        auth: now,
        iat: now,
        exp: now + 3600,
        passwordVersion: version,
      },
      deriveKey(secret, "portal.session.v1"),
    )
  );
}

async function request(path: string, version: string, method = "GET", origin?: string) {
  const result = await fetch(base + path, {
    method,
    redirect: "manual",
    headers: { cookie: cookie(version), accept: "application/json", ...(origin ? { origin } : {}) },
  });
  await result.text();
  return result;
}

test("reset revokes old portal sessions on reads, writes and host-service checks", async () => {
  assert.equal((await request("/api/contexts", "before-reset")).status, 200);
  assert.equal((await request("/auth/session-check", "before-reset")).status, 204);
  activeVersion = "reset-version";
  forceChange = true;
  const before = proxied;
  for (const path of ["/api/contexts", "/admin/api/users", "/auth/session-check"])
    assert.equal((await request(path, "before-reset")).status, 401);
  assert.equal(
    (await request("/admin/api/users/fixture/password-reset", "before-reset", "POST", "http://portal.example.test"))
      .status,
    401,
  );
  assert.equal(proxied, before);
  assert.equal((await request("/api/contexts", "reset-version")).status, 401);
  forceChange = false;
  activeVersion = "after-change";
  assert.equal((await request("/api/contexts", "after-change")).status, 200);
  assert.equal((await request("/auth/session-check", "after-change")).status, 204);
  assert.equal(
    (await request("/admin/api/users/fixture/password-reset", "after-change", "POST", "http://evil.example.test"))
      .status,
    403,
  );
});

test("session validation failure fails closed and health stays available", async () => {
  unavailable = true;
  const before = proxied;
  assert.equal((await request("/api/contexts", "after-change")).status, 500);
  assert.equal(proxied, before);
  assert.equal((await request("/healthz", "after-change")).status, 200);
  unavailable = false;
});

test("host-service impersonation requires current admin permission and an active target", async () => {
  const now = Math.floor(Date.now() / 1000);
  const imp = seal(
    {
      k: "impersonate",
      actor: "fixture@example.test",
      target: "target@example.test",
      org: "fixture",
      iat: now,
      exp: now + 3600,
    },
    deriveKey(secret, "portal.impersonate.v1"),
  );
  const headers = { cookie: cookie("after-change") + "; portal_impersonate=" + imp };
  const check = async (path = "/auth/session-check", method = "GET") => {
    const result = await fetch(base + path, {
      method,
      headers: { ...headers, accept: "application/json", origin: "http://portal.example.test" },
    });
    await result.text();
    return result.status;
  };
  assert.equal(await check(), 204);
  assert.equal(await check("/me"), 200);
  assert.equal(await check("/api/notifications"), 200);
  targetActive = false;
  const before = proxied;
  assert.equal(await check(), 401);
  assert.equal(await check("/me"), 401);
  assert.equal(await check("/api/notifications"), 401);
  assert.equal(await check("/api/notifications/example/read", "POST"), 401);
  assert.equal(proxied, before);
  targetActive = true;
  adminActive = false;
  assert.equal(await check(), 401);
  assert.equal(await check("/me"), 401);
  assert.equal(await check("/api/notifications"), 401);
  adminActive = true;
  assert.equal(await check("/api/notifications"), 200);
});
