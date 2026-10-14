import { adoptionDatabase } from "./support/adoption-database.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import { buildApp } from "../src/wiring.ts";
import { createInsecureTestServer } from "../src/api/server.ts";
import { testConfig } from "./support/test-config.ts";
import { createAdoptionStore } from "../src/admin/adoption-store.ts";
import { createPostgresRunStore } from "../src/runs/postgres-run-store.ts";

const databaseAvailable = Boolean(process.env.DATABASE_URL);

test(
  "the adoption report carries request scenes and exports them, and a paused classifier does no work",
  { skip: !databaseAvailable },
  async (t) => {
    const database = await adoptionDatabase(t);
    const built = buildApp(testConfig({ adminGrants: "admin:org_admin" }));
    const runtime = createPostgresRunStore(database!);
    let modelAsked = 0;
    const adoption = createAdoptionStore(database!, `org:${randomUUID()}`, runtime.runs, undefined, {
      enabled: false,
      resolveModel: async () => {
        modelAsked += 1;
        return null;
      },
    });
    const server = createInsecureTestServer(built.app, { admin: built.admin, auditLog: built.auditLog, adoption });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const request = (path: string, actor = "admin@default-org") =>
      fetch(base + path, { headers: { "x-admin-actor": actor } });
    try {
      const report = (await (await request("/v1/admin/adoption")).json()) as Awaited<
        ReturnType<typeof adoption.report>
      >;
      const scenes = report.scenarios;
      assert.equal(scenes.taxonomyVersion, "scenes-v1");
      assert.deepEqual(
        scenes.categories.map((c) => c.id),
        [
          "research",
          "writing",
          "business",
          "data",
          "presentation",
          "media",
          "engineering",
          "coordination",
          "unclassified",
        ],
      );
      assert.equal(scenes.totalRequests, 0);
      assert.equal(scenes.coverage, null);
      assert.equal(scenes.processing.state, "idle");
      assert.equal(scenes.trend.length, report.trend.length);

      assert.deepEqual(await adoption.processScenarios(), { processed: 0 });
      assert.equal(modelAsked, 0);

      assert.equal((await request("/v1/admin/adoption/scenarios/export", "ordinary@default-org")).status, 403);
      const download = await request("/v1/admin/adoption/scenarios/export");
      assert.equal(download.status, 200);
      assert.ok(download.headers.get("content-type")?.startsWith("text/csv"));
      assert.match(download.headers.get("content-disposition") ?? "", /request-scenarios\.csv/);
      const lines = (await download.text()).split("\r\n");
      assert.ok(lines[0]!.startsWith('"Record type","Current department","Date","Request scene"'));
      assert.equal(lines.filter((line) => line.startsWith('"Scene summary"')).length, 9);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await adoption.close();
      await runtime.close();
    }
  },
);
