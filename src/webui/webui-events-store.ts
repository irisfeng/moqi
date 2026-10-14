import { createPgPool } from "../persistence/pg-pool.ts";

const WEBUI_EVENT_TYPES = [
  "example_card_click",
  "tip_try_click",
  "tip_card_close",
  "guide_page_open",
  "guide_try_click",
  "announced_toast_open",
  "trio_step_done",
] as const;
export type WebuiEventType = (typeof WEBUI_EVENT_TYPES)[number];

export const TASK_EVENT_TYPES: readonly WebuiEventType[] = ["example_card_click", "tip_try_click", "guide_try_click"];

interface WebuiEventFilter {
  principalId?: string;
  types?: readonly string[];
  limit?: number;
}

export interface WebuiEventStore {
  record(principalId: string, type: WebuiEventType, ref: string): Promise<void>;
  list(filter: WebuiEventFilter): Promise<Array<{ at: number; principalId: string; type: string; ref: string }>>;
}

export function isWebuiEventType(value: unknown): value is WebuiEventType {
  return typeof value === "string" && (WEBUI_EVENT_TYPES as readonly string[]).includes(value);
}

export function createMemoryWebuiEventStore(): WebuiEventStore {
  const rows: Array<{ at: number; principalId: string; type: string; ref: string }> = [];
  const cap = 10_000;
  return {
    async record(principalId, type, ref) {
      rows.push({ at: Date.now(), principalId, type, ref });
      if (rows.length > cap) rows.splice(0, rows.length - cap);
    },
    async list(filter) {
      const limit = Math.min(Math.max(filter.limit ?? 200, 1), 1000);
      return rows
        .filter(
          (r) =>
            (!filter.principalId || r.principalId === filter.principalId) &&
            (!filter.types || filter.types.includes(r.type)),
        )
        .slice(-limit)
        .reverse();
    },
  };
}

const WEBUI_EVENTS_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS webui_events(
    at BIGINT NOT NULL,
    principal TEXT NOT NULL,
    type TEXT NOT NULL,
    ref TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS webui_events_principal ON webui_events (principal, at DESC)`,
  `CREATE INDEX IF NOT EXISTS webui_events_type ON webui_events (type, at DESC)`,
];

export function createPostgresWebuiEventStore(connectionString: string): WebuiEventStore {
  const { q } = createPgPool(connectionString, "zz-qm-cn/webui-events/0001", WEBUI_EVENTS_SCHEMA);
  return {
    async record(principalId, type, ref) {
      await q("INSERT INTO webui_events(at, principal, type, ref) VALUES ($1,$2,$3,$4)", [
        Date.now(),
        principalId,
        type,
        ref,
      ]);
    },
    async list(filter) {
      const limit = Math.min(Math.max(filter.limit ?? 200, 1), 1000);
      const where: string[] = [];
      const args: unknown[] = [];
      if (filter.principalId) {
        args.push(filter.principalId);
        where.push(`principal = $${args.length}`);
      }
      if (filter.types) {
        args.push(filter.types);
        where.push(`type = ANY($${args.length})`);
      }
      args.push(limit);
      const rows = await q(
        `SELECT at, principal, type, ref FROM webui_events${where.length ? " WHERE " + where.join(" AND ") : ""}
         ORDER BY at DESC LIMIT $${args.length}`,
        args,
      );
      return rows.map((r) => ({
        at: Number(r.at),
        principalId: String(r.principal),
        type: String(r.type),
        ref: String(r.ref),
      }));
    },
  };
}
