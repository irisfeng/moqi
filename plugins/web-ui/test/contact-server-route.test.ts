import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { createHmac } from "node:crypto";

const calls: Array<{ method: string; url: string; body: Record<string, unknown>; identity: unknown }> = [];
const core = createServer((req, res) => {
  let raw = "";
  req.on("data", (chunk) => {
    raw += chunk;
  });
  req.on("end", () => {
    calls.push({
      method: req.method ?? "",
      url: req.url ?? "",
      body: raw ? JSON.parse(raw) : {},
      identity: req.headers["x-portal-identity"],
    });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ email: "alice@example.com", phone: null }));
  });
});
await new Promise<void>((resolve) => core.listen(0, resolve));
process.env.CORE_API_URL = `http://localhost:${(core.address() as AddressInfo).port}`;
process.env.CORE_SIGNING_SECRET = "contact-route-source-secret";
process.env.WEB_UI_PRINCIPALS = "alice";
process.env.PORTAL_IDENTITY_SECRET = "contact-route-identity-secret";
function sign(claims: Record<string, unknown>): string {
  const payload = Buffer.from(JSON.stringify({ ...claims, exp: Date.now() + 60000 })).toString("base64url");
  return `${payload}.${createHmac("sha256", process.env.PORTAL_IDENTITY_SECRET!).update(payload).digest("base64url")}`;
}
const identity = sign({ p: "alice" });
const { handler } = await import("../server/index.ts");
const surface = createServer((req, res) => void handler(req, res));
await new Promise<void>((resolve) => surface.listen(0, resolve));
const base = `http://localhost:${(surface.address() as AddressInfo).port}`;
const headers = { cookie: "webuiuser=alice", "x-portal-identity": identity, "content-type": "application/json" };
test.after(() => {
  surface.close();
  core.close();
});

test("the own-contact relay pins the signed-in person and forwards their identity", async () => {
  assert.equal((await fetch(`${base}/api/me/contact?principalId=someone-else`, { headers })).status, 200);
  const get = calls.find((c) => c.method === "GET" && c.url.startsWith("/v1/me/contact?"));
  assert.ok(get);
  assert.equal(new URL(get.url, "http://core").searchParams.get("principalId"), "alice");
  assert.equal(get.identity, identity);
  const put = await fetch(`${base}/api/me/contact`, {
    method: "PUT",
    headers,
    body: JSON.stringify({ phone: "0123-0123 4567", principalId: "someone-else", email: "x@example.com" }),
  });
  assert.equal(put.status, 200);
  const sent = calls.find((c) => c.method === "PUT" && c.url.startsWith("/v1/me/contact"));
  assert.deepEqual(sent?.body, { phone: "0123-0123 4567", principalId: "alice" });
  assert.equal(sent?.identity, identity);
});

test("the own-contact relay refuses an empty body and an impersonated write", async () => {
  const before = calls.length;
  assert.equal((await fetch(`${base}/api/me/contact`, { method: "PUT", headers })).status, 400);
  const impersonated = await fetch(`${base}/api/me/contact`, {
    method: "PUT",
    headers: { ...headers, "x-portal-identity": sign({ p: "alice", imp: "admin-bob" }) },
    body: JSON.stringify({ phone: "138" }),
  });
  assert.equal(impersonated.status, 403);
  assert.equal(calls.length, before, "neither request reaches the core");
});
