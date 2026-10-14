import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { buildApp } from "../src/wiring.ts";
import { createServer } from "../src/api/server.ts";
import { testConfig } from "./support/test-config.ts";
import { signedRequestHeaders } from "../plugins/chassis/src/source-auth-sign.ts";
import { mintSignedPayload } from "../src/auth/signed-token.ts";
import { createPostgresGrowthStore } from "../src/webui/growth-store.ts";
import { createPostgresRunStore } from "../src/runs/postgres-run-store.ts";
import { createMemoryRunStore } from "../src/runs/memory-run-store.ts";

const source = "growth-test-source-secret-distinct-123456";
const identity = "growth-test-portal-secret-distinct-123456";
const capability = "growth-test-capability-secret-distinct-123456";
const database = process.env.DATABASE_URL;

test(
  "growth HTTP ingress rejects unsigned, forged and cross-user requests; never accepts client points",
  { skip: !database },
  async () => {
    const built = buildApp(testConfig());
    const growth = createPostgresGrowthStore(database!);
    await built.webuiHome.put(
      "org:default-org",
      JSON.parse(readFileSync("deploy/layers/qm-cn/seed/webui-home.json", "utf8")),
    );
    const deps = {
      signingSecret: source,
      portalIdentitySecret: identity,
      capabilitySecret: capability,
      requireSignedPortalIdentity: true,
      sessions: built.sessions,
      runs: built.runs,
      webuiHome: built.webuiHome,
      growth,
    };
    const server = createServer(built.app, deps);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const principal = `growth-http-${randomUUID()}@test`;
    async function request(path: string, body?: unknown, actor = principal, secret = identity) {
      const method = body ? "POST" : "GET";
      const text = body ? JSON.stringify(body) : "";
      const headers = signedRequestHeaders(source, method, path, text, { "content-type": "application/json" });
      if (actor) headers["x-portal-identity"] = await mintSignedPayload({ p: actor, exp: Date.now() + 60000 }, secret);
      return fetch(base + path, { method, headers, ...(body ? { body: text } : {}) });
    }
    try {
      assert.equal((await fetch(base + "/v1/me/growth")).status, 401);
      assert.equal((await request("/v1/me/growth", undefined, "")).status, 401);
      assert.equal((await request("/v1/me/growth", undefined, principal, source)).status, 401);
      assert.ok([403, 404].includes((await request("/v1/me/growth?principalId=someone-else")).status));
      assert.ok(
        [403, 404].includes(
          (
            await request("/v1/me/growth/action", {
              action: "start",
              key: "onboarding-v1",
              principalId: "someone-else",
            })
          ).status,
        ),
      );
      const r = await request("/v1/me/growth/action", { action: "start", key: "onboarding-v1", points: 99999 });
      assert.equal(r.status, 200);
      const view = (await r.json()) as { points: number; onboarding: { participation: { threadRef: string } } };
      assert.equal(view.points, 0);
      assert.ok(view.onboarding.participation.threadRef.startsWith(`web:${principal}:`));
      assert.equal(
        (
          await request("/v1/me/growth/action", {
            action: "accept",
            key: "onboarding-v1",
            runId: "forged",
            points: 99999,
          })
        ).status,
        409,
      );
      await built.webuiHome.delete("org:default-org");
      assert.equal((await request("/v1/me/growth")).status, 503);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await growth.close();
    }
  },
);

test("run stores filter session before limiting results", { skip: !database }, async () => {
  const pg = createPostgresRunStore(database!);
  const memory = createMemoryRunStore();
  try {
    for (const runs of [memory.runs, pg.runs]) {
      const sessionId = randomUUID();
      const request = {
        actor: { id: "growth-filter@test", type: "internal" as const },
        conversation: { kind: "dm" as const, threadRef: sessionId, audience: [] },
        origin: { kind: "human" as const },
        text: "filter query verification",
      };
      const first = await runs.enqueue({ sessionId, request });
      await runs.enqueue({ sessionId: randomUUID(), request });
      const rows = await runs.list({ threadRef: sessionId, limit: 1 });
      assert.deepEqual(
        rows.map((r) => r.id),
        [first.run.id],
      );
      assert.equal((await runs.list({ threadRef: randomUUID() })).length, 0);
    }
  } finally {
    await pg.close();
  }
});
