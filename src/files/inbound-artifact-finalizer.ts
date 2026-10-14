import { swallow, swallowAs } from "../util/errors.ts";
import { artifactIsReferenced, lockGrantResource } from "../persistence/artifact-resource.ts";
import { createPgPool, withPgTransaction } from "../persistence/pg-pool.ts";
import type { ScopeId } from "../types.ts";
import { createSweeper } from "../util/sweeper.ts";

export function createInboundArtifactFinalizer(connectionString: string, intervalMs: number) {
  const db = createPgPool(connectionString, []);
  let active: Promise<void> | null = null;
  let stopping = false;
  const sweep = async (): Promise<void> => {
    const ready = await db.q(
      "SELECT to_regclass('runs') AS runs, to_regclass('session_entries') AS entries, to_regclass('inbound_artifact_cleanup') AS cleanup",
    );
    if (!ready[0]?.runs || !ready[0]?.entries || !ready[0]?.cleanup) return;
    const candidates = await db.q(
      `SELECT c.artifact_id FROM inbound_artifact_cleanup c LEFT JOIN runs r ON r.id = c.run_id
       WHERE c.next_attempt_at <= $1 AND (r.id IS NULL OR r.status IN ('done', 'failed'))
       ORDER BY c.next_attempt_at, c.created_at, c.artifact_id LIMIT 100`,
      [Date.now()],
    );
    for (const candidate of candidates) {
      if (stopping) break;
      try {
        await withPgTransaction(await db.pool(), async (client) => {
          await client.query("SET LOCAL lock_timeout = '2s'");
          await client.query("SET LOCAL statement_timeout = '3s'");
          const files = await client.query("SELECT owner_scope_id FROM file_artifacts WHERE id = $1", [
            candidate.artifact_id,
          ]);
          const file = files.rows[0];
          if (file) await lockGrantResource(client, file.owner_scope_id as ScopeId, String(candidate.artifact_id));
          const registrations = await client.query(
            "SELECT run_id FROM inbound_artifact_cleanup WHERE artifact_id = $1 FOR UPDATE",
            [candidate.artifact_id],
          );
          if (!registrations.rowCount) return;
          const runId = registrations.rows[0].run_id;
          const run = await client.query("SELECT status FROM runs WHERE id = $1", [runId]);
          if (run.rowCount && !["done", "failed"].includes(run.rows[0].status)) return;
          if (file && !(await artifactIsReferenced(client, String(candidate.artifact_id)))) {
            await client.query(
              "DELETE FROM acl_grants WHERE owner_scope_id = $1 AND path = $2 AND source_run_id = $3 AND permission = 'read'",
              [file.owner_scope_id, candidate.artifact_id, runId],
            );
            const removed = await client.query(
              `DELETE FROM file_artifacts WHERE id = $1 AND NOT EXISTS
             (SELECT 1 FROM acl_grants WHERE owner_scope_id = $2 AND path = $3)`,
              [candidate.artifact_id, file.owner_scope_id, candidate.artifact_id],
            );
            if (removed.rowCount)
              await client.query(
                "INSERT INTO file_artifact_deletions(id,deleted_at) VALUES($1,$2) ON CONFLICT(id) DO NOTHING",
                [candidate.artifact_id, Date.now()],
              );
          }
          await client.query("DELETE FROM inbound_artifact_cleanup WHERE artifact_id = $1", [candidate.artifact_id]);
        });
      } catch (error) {
        swallow("inbound-artifact-finalizer: artifact reconciliation failed", error);
        if (stopping) break;
        await withPgTransaction(await db.pool(), async (client) => {
          await client.query("SET LOCAL lock_timeout = '500ms'");
          await client.query("SET LOCAL statement_timeout = '1s'");
          await client.query("UPDATE inbound_artifact_cleanup SET next_attempt_at = $2 WHERE artifact_id = $1", [
            candidate.artifact_id,
            Date.now() + Math.max(1000, intervalMs),
          ]);
        }).catch(swallowAs("inbound-artifact-finalizer: retry scheduling failed", undefined));
      }
    }
  };
  const timer = createSweeper(
    () => {
      if (!active)
        active = sweep().finally(() => {
          active = null;
        });
      return active;
    },
    intervalMs,
    { label: "inbound-artifact-finalizer", immediate: true },
  );
  return {
    start() {
      stopping = false;
      timer.start();
    },
    async stop() {
      stopping = true;
      await timer.stop();
      await active?.catch(swallowAs("inbound-artifact-finalizer: drain failed", undefined));
    },
    async close() {
      await db.close().catch(swallowAs("inbound-artifact-finalizer: close failed", undefined));
    },
  };
}
