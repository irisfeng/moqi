import { createPgPool } from "../persistence/pg-pool.ts";

interface FileOrigin {
  artifactId: string;
  sessionId: string;
  runId: string | null;
  recordedAt: number;
}

export interface FileOriginStore {
  record(origin: FileOrigin): Promise<void>;
  forFiles(artifactIds: readonly string[]): Promise<Map<string, FileOrigin>>;
  close?(): Promise<void>;
}

export function createMemoryFileOriginStore(): FileOriginStore {
  const origins = new Map<string, FileOrigin>();
  return {
    async record(origin) {
      if (!origins.has(origin.artifactId)) origins.set(origin.artifactId, { ...origin });
    },
    async forFiles(artifactIds) {
      const found = new Map<string, FileOrigin>();
      for (const id of artifactIds) {
        const origin = origins.get(id);
        if (origin) found.set(id, { ...origin });
      }
      return found;
    },
  };
}

export function createPostgresFileOriginStore(connectionString: string): FileOriginStore {
  const { q, close } = createPgPool(connectionString, "zz-qm-cn/file-origins/0001", [
    `CREATE TABLE IF NOT EXISTS file_origins(
        artifact_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        run_id TEXT,
        recorded_at BIGINT NOT NULL
      )`,
  ]);
  return {
    async record(origin) {
      await q(
        `INSERT INTO file_origins (artifact_id, session_id, run_id, recorded_at) VALUES ($1, $2, $3, $4)
         ON CONFLICT (artifact_id) DO NOTHING`,
        [origin.artifactId, origin.sessionId, origin.runId, origin.recordedAt],
      );
    },
    async forFiles(artifactIds) {
      const found = new Map<string, FileOrigin>();
      if (!artifactIds.length) return found;
      const rows = await q(
        `SELECT artifact_id, session_id, run_id, recorded_at FROM file_origins WHERE artifact_id = ANY($1::text[])`,
        [[...artifactIds]],
      );
      for (const r of rows)
        found.set(r.artifact_id as string, {
          artifactId: r.artifact_id as string,
          sessionId: r.session_id as string,
          runId: (r.run_id as string | null) ?? null,
          recordedAt: Number(r.recorded_at),
        });
      return found;
    },
    close,
  };
}
