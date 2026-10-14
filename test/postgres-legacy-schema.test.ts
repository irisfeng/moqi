import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

const databaseUrl = process.env.DATABASE_URL;
const legacySchema = new URL("./fixtures/legacy-schema/2026-10-07.sql", import.meta.url);

test(
  "the migration command upgrades a database built from the legacy schema and can run again",
  { skip: !databaseUrl, timeout: 180_000 },
  async () => {
    const pg = (await import("pg")).default;
    const name = `legacy_${randomUUID().replaceAll("-", "")}`;
    const admin = new pg.Pool({ connectionString: databaseUrl!, max: 1 });
    const legacyUrl = new URL(databaseUrl!);
    legacyUrl.pathname = `/${name}`;
    const dataDir = await mkdtemp(join(tmpdir(), "qm-legacy-schema-"));
    const tables = async (pool: InstanceType<typeof pg.Pool>): Promise<string[]> =>
      (
        await pool.query(
          "SELECT table_schema || '.' || table_name AS name FROM information_schema.tables WHERE table_schema IN ('public','pgboss') ORDER BY 1",
        )
      ).rows.map((row: { name: string }) => row.name);
    const migrate = async (): Promise<string> =>
      (
        await promisify(execFile)(process.execPath, ["src/migrate-main.ts"], {
          cwd: fileURLToPath(new URL("..", import.meta.url)),
          env: {
            PATH: process.env.PATH,
            NODE_ENV: "test",
            DATABASE_URL: legacyUrl.href,
            SESSION_STORE: "postgres",
            HARNESS: "mock",
            SANDBOX_BACKEND: "local",
            CONNECTOR_SECRET_KEY: "legacy-schema-test-connector-secret",
            CAPABILITY_SECRET: "legacy-schema-test-capability-secret",
            DATA_DIR: dataDir,
          },
          timeout: 80_000,
          killSignal: "SIGKILL",
        })
      ).stdout;
    await admin.query(`CREATE DATABASE ${name}`);
    const legacy = new pg.Pool({ connectionString: legacyUrl.href, max: 1 });
    try {
      await legacy.query(readFileSync(legacySchema, "utf8"));
      await legacy.query("SELECT pg_catalog.set_config('search_path', 'public', false)");
      const before = await tables(legacy);
      assert.ok(before.includes("public.cron_fire_log"));
      assert.ok(before.includes("public.adoption_scenario_labels"));
      assert.ok(!before.includes("public.cron_fires"));

      assert.match(await migrate(), /\[qm:migrate\] database migrations applied/);
      const after = await tables(legacy);
      assert.deepEqual(
        before.filter((table) => !after.includes(table)),
        [],
        "no legacy table is dropped",
      );
      for (const table of ["public.cron_fires", "public.qm_schema_migrations", "public.inbound_artifact_cleanup"])
        assert.ok(after.includes(table), table);
      const column = await legacy.query(
        "SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='acl_grants' AND column_name='source_run_id'",
      );
      assert.equal(column.rowCount, 1);

      assert.match(await migrate(), /\[qm:migrate\] database migrations applied/);
      assert.deepEqual(await tables(legacy), after, "a second run changes nothing");
    } finally {
      await legacy.end();
      await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await admin.end();
      await rm(dataDir, { recursive: true, force: true });
    }
  },
);
