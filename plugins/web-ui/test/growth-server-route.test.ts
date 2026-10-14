import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { createHmac } from "node:crypto";

const calls: Array<{ url: string; body: Record<string, unknown>; identity: unknown }> = [];
const core = createServer((req, res) => {
  let raw = "";
  req.on("data", (chunk) => {
    raw += chunk;
  });
  req.on("end", () => {
    calls.push({ url: req.url ?? "", body: raw ? JSON.parse(raw) : {}, identity: req.headers["x-portal-identity"] });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ points: 0 }));
  });
});
await new Promise<void>((resolve) => core.listen(0, resolve));
process.env.CORE_API_URL = `http://localhost:${(core.address() as AddressInfo).port}`;
process.env.CORE_SIGNING_SECRET = "growth-route-source-secret";
process.env.WEB_UI_PRINCIPALS = "alice";
process.env.PORTAL_IDENTITY_SECRET = "growth-route-identity-secret";
const payload = Buffer.from(JSON.stringify({ p: "alice", exp: Date.now() + 60000 })).toString("base64url");
const identity = `${payload}.${createHmac("sha256", process.env.PORTAL_IDENTITY_SECRET).update(payload).digest("base64url")}`;
const { handler } = await import("../server/index.ts");
const surface = createServer((req, res) => void handler(req, res));
await new Promise<void>((resolve) => surface.listen(0, resolve));
const base = `http://localhost:${(surface.address() as AddressInfo).port}`;
const headers = {
  cookie: "webuiuser=alice",
  "x-portal-identity": identity,
  "content-type": "application/json",
};
test.after(() => {
  surface.close();
  core.close();
});

test("growth pins identity, forwards signed portal context and strips invented reward fields", async () => {
  assert.equal((await fetch(`${base}/api/growth?principalId=someone-else`, { headers })).status, 200);
  const get = calls.find((c) => c.url.startsWith("/v1/me/growth?"));
  assert.ok(get);
  assert.equal(new URL(get.url, "http://core").searchParams.get("principalId"), "alice");
  assert.equal(get.identity, identity);
  assert.equal(
    (
      await fetch(`${base}/api/growth/action`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          action: "accept",
          key: "onboarding-v1",
          runId: "r1",
          principalId: "someone-else",
          points: 999,
        }),
      })
    ).status,
    200,
  );
  const post = calls.find((c) => c.url.startsWith("/v1/me/growth/action"));
  assert.deepEqual(post?.body, { action: "accept", key: "onboarding-v1", runId: "r1", principalId: "alice" });
  assert.equal(post?.identity, identity);
});
