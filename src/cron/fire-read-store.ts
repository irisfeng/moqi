import { createHash } from "node:crypto";
import { createPgPool } from "../persistence/pg-pool.ts";
import type { CronFireLogEntry } from "../types.ts";

export type CronFireDetail = CronFireLogEntry & { version: string };

export interface CronFirePage {
  runs: Array<CronFireLogEntry & { readAt?: number }>;
  total: number;
}

interface CronFireRead {
  cronId: string;
  fireKey: string;
  version: string;
  readAt: number;
}

export interface CronFireReadStore {
  mark(viewer: string, read: CronFireRead): Promise<void>;
  list(cronIds: readonly string[], viewer: string): Promise<CronFireRead[]>;
  close?(): Promise<void>;
}

export function cronFireVersion(entry: CronFireLogEntry): string {
  return createHash("md5")
    .update(
      JSON.stringify([
        entry.fireKey,
        entry.threadRef,
        entry.firedAt,
        entry.scheduledAt ?? null,
        entry.status ?? null,
        entry.endedAt ?? null,
        entry.note ?? null,
        entry.reply ?? null,
        entry.sessionId ?? null,
      ]),
    )
    .digest("hex");
}

export function createMemoryCronFireReadStore(): CronFireReadStore {
  const byViewer = new Map<string, Map<string, CronFireRead>>();
  return {
    async mark(viewer, read) {
      let reads = byViewer.get(viewer);
      if (!reads) {
        reads = new Map();
        byViewer.set(viewer, reads);
      }
      reads.set(JSON.stringify([read.cronId, read.fireKey]), { ...read });
    },
    async list(cronIds, viewer) {
      const wanted = new Set(cronIds);
      return [...(byViewer.get(viewer)?.values() ?? [])].filter((read) => wanted.has(read.cronId));
    },
  };
}

export function createPostgresCronFireReadStore(connectionString: string): CronFireReadStore {
  const { q, close } = createPgPool(connectionString, "zz-qm-cn/cron-fire-reads/0001", [
    `CREATE TABLE IF NOT EXISTS cron_fire_reads(
        cron_id TEXT NOT NULL,
        fire_key TEXT NOT NULL,
        viewer_id TEXT NOT NULL,
        read_at BIGINT NOT NULL,
        fire_version TEXT NOT NULL,
        PRIMARY KEY (cron_id, fire_key, viewer_id),
        FOREIGN KEY (cron_id, fire_key) REFERENCES cron_fires(cron_id, fire_key) ON DELETE CASCADE
      )`,
    `CREATE INDEX IF NOT EXISTS idx_cron_fire_reads_viewer ON cron_fire_reads (viewer_id, cron_id)`,
  ]);
  return {
    async mark(viewer, read) {
      await q(
        `INSERT INTO cron_fire_reads (cron_id, fire_key, viewer_id, read_at, fire_version)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (cron_id, fire_key, viewer_id) DO UPDATE
           SET read_at = EXCLUDED.read_at, fire_version = EXCLUDED.fire_version
         WHERE cron_fire_reads.fire_version IS DISTINCT FROM EXCLUDED.fire_version`,
        [read.cronId, read.fireKey, viewer, read.readAt, read.version],
      );
    },
    async list(cronIds, viewer) {
      if (!cronIds.length) return [];
      const rows = await q(
        `SELECT cron_id, fire_key, read_at, fire_version FROM cron_fire_reads
          WHERE viewer_id = $1 AND cron_id = ANY($2::text[])`,
        [viewer, [...cronIds]],
      );
      return rows.map((r) => ({
        cronId: r.cron_id as string,
        fireKey: r.fire_key as string,
        version: r.fire_version as string,
        readAt: Number(r.read_at),
      }));
    },
    close,
  };
}
