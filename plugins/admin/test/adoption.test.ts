import test from "node:test";
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
const requests: { url: string; method: string; actor: unknown; signed: boolean }[] = [];
const core = createServer((req, res) => {
  requests.push({
    url: req.url!,
    method: req.method!,
    actor: req.headers["x-admin-actor"],
    signed: Boolean(req.headers["x-signature"]),
  });
  if (req.url?.includes("/export")) {
    res.writeHead(200, {
      "content-type": "text/csv; charset=utf-8",
      "cache-control": "no-store",
      "content-disposition": 'attachment; filename="adoption.csv"',
    });
    res.end("\uFEFF姓名,请求\r\n演示,3\r\n");
  } else {
    res.writeHead(200, { "content-type": "application/json" });
    res.end('{"members":[]}');
  }
});
await new Promise<void>((resolve) => core.listen(0, resolve));
process.env.CORE_API_URL = `http://localhost:${(core.address() as AddressInfo).port}`;
process.env.CORE_SIGNING_SECRET = "adoption-proxy-test-secret";
const { server } = await import("../src/index.ts");
await new Promise<void>((resolve) => server.listen(0, resolve));
const base = `http://localhost:${(server.address() as AddressInfo).port}`;
test.after(() => {
  server.close();
  core.close();
});
test("the adoption view is registered in the console", () => {
  const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
  const shell = readFileSync(new URL("../ui/admin.ts", import.meta.url), "utf8");
  const view = readFileSync(new URL("../ui/adoption.ts", import.meta.url), "utf8");
  assert.ok(html.includes('adoption: "Usage and outcomes"'));
  assert.ok(html.includes("adoption: renderAdoption"));
  assert.ok(shell.includes('export * as adoption from "./adoption.ts";'));
  assert.ok(view.includes("/api/adoption/export?"));
  assert.ok(view.includes("adoption-export"));
  assert.ok(!/[\u4e00-\u9fff]/.test(view));
});
test("adoption proxy requires identity, signs filters and preserves download bytes and no-store", async () => {
  assert.equal((await fetch(base + "/api/adoption")).status, 401);
  const response = await fetch(base + "/api/adoption?department=demo", { headers: { cookie: "admin=admin" } });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(requests.at(-1), {
    url: "/v1/admin/adoption?department=demo",
    method: "GET",
    actor: "admin@acme",
    signed: true,
  });
  const download = await fetch(base + "/api/adoption/export?search=demo", { headers: { cookie: "admin=admin" } });
  assert.equal(download.status, 200);
  assert.ok(download.headers.get("content-type")?.startsWith("text/csv"));
  assert.equal(download.headers.get("cache-control"), "no-store");
  assert.deepEqual(Array.from(new Uint8Array(await download.arrayBuffer()).slice(0, 3)), [239, 187, 191]);
  const scenarios = await fetch(base + "/api/adoption/scenarios/export?department=demo", {
    headers: { cookie: "admin=admin" },
  });
  assert.equal(scenarios.status, 200);
  assert.equal(requests.at(-1)?.url, "/v1/admin/adoption/scenarios/export?department=demo");
});
