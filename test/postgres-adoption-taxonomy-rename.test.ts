import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { ADOPTION_SCENARIO_SCHEMA, ADOPTION_SCENARIO_TAXONOMY_RENAME } from "../src/admin/adoption-scenarios.ts";
import { ADOPTION_SCENARIO_TAXONOMY } from "../src/admin/adoption-scenario-classifier.ts";

const url = process.env.DATABASE_URL;

test(
  "labels kept under an older taxonomy name move to the current one, and a current label wins",
  { skip: !url },
  async () => {
    const pg = (await import("pg")).default;
    const pool = new pg.Pool({ connectionString: url! });
    const org = `rename-${randomUUID()}`;
    const older = `brand-${ADOPTION_SCENARIO_TAXONOMY}`;
    const label = (runId: string, taxonomy: string, category: string) =>
      pool.query(
        `INSERT INTO adoption_scenario_labels(org,run_id,taxonomy_version,classifier_version,category,status,source,processed_at)
      VALUES($1,$2,$3,'v1',$4,'classified','manual',1)`,
        [org, runId, taxonomy, category],
      );
    try {
      for (const statement of ADOPTION_SCENARIO_SCHEMA) await pool.query(statement);
      await label("moved", older, "writing");
      await label("both", older, "writing");
      await label("both", ADOPTION_SCENARIO_TAXONOMY, "research");
      await label("current", ADOPTION_SCENARIO_TAXONOMY, "data");
      for (const [runId, taxonomy] of [
        ["moved", older],
        ["both", older],
        ["both", ADOPTION_SCENARIO_TAXONOMY],
      ])
        await pool.query(
          `INSERT INTO adoption_scenario_jobs(org,run_id,taxonomy_version,available_at,created_at,updated_at)
          VALUES($1,$2,$3,0,1,1)`,
          [org, runId, taxonomy],
        );
      for (let round = 0; round < 2; round++)
        for (const statement of ADOPTION_SCENARIO_TAXONOMY_RENAME) await pool.query(statement);
      const rows = await pool.query(
        "SELECT run_id,taxonomy_version,category FROM adoption_scenario_labels WHERE org=$1 ORDER BY run_id",
        [org],
      );
      assert.deepEqual(
        rows.rows.map((row) => [row.run_id, row.taxonomy_version, row.category]),
        [
          ["both", ADOPTION_SCENARIO_TAXONOMY, "research"],
          ["current", ADOPTION_SCENARIO_TAXONOMY, "data"],
          ["moved", ADOPTION_SCENARIO_TAXONOMY, "writing"],
        ],
      );
      const jobs = await pool.query(
        "SELECT run_id,taxonomy_version FROM adoption_scenario_jobs WHERE org=$1 ORDER BY run_id",
        [org],
      );
      assert.deepEqual(
        jobs.rows.map((row) => [row.run_id, row.taxonomy_version]),
        [
          ["both", ADOPTION_SCENARIO_TAXONOMY],
          ["moved", ADOPTION_SCENARIO_TAXONOMY],
        ],
      );
    } finally {
      await pool.query("DELETE FROM adoption_scenario_jobs WHERE org=$1", [org]);
      await pool.query("DELETE FROM adoption_scenario_labels WHERE org=$1", [org]);
      await pool.end();
    }
  },
);
