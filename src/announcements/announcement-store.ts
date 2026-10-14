import { randomUUID } from "node:crypto";
import { orgId as configOrgId } from "../config.ts";
import type { DurableMap } from "../persistence/durable-map.ts";
import { createPgPool } from "../persistence/pg-pool.ts";

export const ANNOUNCEMENT_LEVELS = ["notice", "maintenance", "incident"] as const;
export type AnnouncementLevel = (typeof ANNOUNCEMENT_LEVELS)[number];

interface Announcement {
  id: string;
  level: AnnouncementLevel;
  popup?: boolean;
  title: string;
  body: string;
  startsAt: number;
  endsAt: number | null;
  createdBy: string;
  createdAt: number;
}

interface AnnouncementDraft {
  level: AnnouncementLevel;
  popup?: boolean;
  title: string;
  body: string;
  startsAt: number;
  endsAt: number | null;
}

export interface AnnouncementPatch {
  level?: AnnouncementLevel;
  popup?: boolean;
  title?: string;
  body?: string;
  startsAt?: number;
  endsAt?: number | null;
}

export interface AnnouncementStore {
  create(draft: AnnouncementDraft, createdBy: string): Promise<Announcement>;
  get(id: string): Promise<Announcement | null>;
  list(): Promise<Announcement[]>;
  listActive(): Promise<Announcement[]>;
  update(id: string, patch: AnnouncementPatch): Promise<Announcement | null>;
  dismissals(principalId: string): Promise<string[]>;
  dismiss(principalId: string, announcementId: string): Promise<string[]>;
}

export function isAnnouncementLevel(value: unknown): value is AnnouncementLevel {
  return typeof value === "string" && (ANNOUNCEMENT_LEVELS as readonly string[]).includes(value);
}

function announcementActive(announcement: Pick<Announcement, "startsAt" | "endsAt">, now: number): boolean {
  return announcement.startsAt <= now && (announcement.endsAt === null || now < announcement.endsAt);
}

function dismissalFace(map: DurableMap<string[]>): Pick<AnnouncementStore, "dismissals" | "dismiss"> {
  return {
    async dismissals(principalId) {
      return (await map.get(principalId)) ?? [];
    },
    async dismiss(principalId, announcementId) {
      const existing = await map.putIfAbsent(principalId, [announcementId]);
      if (existing.includes(announcementId)) return existing;
      if (map.update) {
        const updated = await map.update(principalId, (ids) => Array.from(new Set([...ids, announcementId])));
        if (updated) return updated;
      }
      const next = Array.from(new Set([...((await map.get(principalId)) ?? []), announcementId]));
      await map.put(principalId, next);
      return next;
    },
  };
}

export function createMemoryAnnouncementStore(dismissals: DurableMap<string[]>): AnnouncementStore {
  const rows: Announcement[] = [];
  const newestFirst = () =>
    rows.slice().sort((a, b) => {
      if (a.createdAt !== b.createdAt) return b.createdAt - a.createdAt;
      if (a.id === b.id) return 0;
      return a.id < b.id ? -1 : 1;
    });
  return {
    async create(draft, createdBy) {
      const announcement: Announcement = { id: randomUUID(), createdAt: Date.now(), ...draft, createdBy };
      rows.push(announcement);
      return { ...announcement };
    },
    async get(id) {
      const row = rows.find((a) => a.id === id);
      return row ? { ...row } : null;
    },
    async list() {
      return newestFirst().map((row) => ({ ...row }));
    },
    async listActive() {
      const now = Date.now();
      return newestFirst()
        .filter((row) => announcementActive(row, now))
        .map((row) => ({ ...row }));
    },
    async update(id, patch) {
      const row = rows.find((a) => a.id === id);
      if (!row) return null;
      Object.assign(row, patch);
      return { ...row };
    },
    ...dismissalFace(dismissals),
  };
}

const ANNOUNCEMENTS_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS announcements(
    id TEXT PRIMARY KEY,
    org_id TEXT NOT NULL,
    level TEXT NOT NULL,
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    starts_at BIGINT NOT NULL,
    ends_at BIGINT,
    created_by TEXT NOT NULL,
    created_at BIGINT NOT NULL
  )`,
  `ALTER TABLE announcements ADD COLUMN IF NOT EXISTS popup BOOLEAN NOT NULL DEFAULT FALSE`,
  `ALTER TABLE announcements ALTER COLUMN ends_at DROP NOT NULL`,
  `CREATE INDEX IF NOT EXISTS announcements_org_created ON announcements (org_id, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS announcements_org_window ON announcements (org_id, starts_at DESC, ends_at DESC)`,
];

const ANNOUNCEMENT_COLS = "id, popup, level, title, body, starts_at, ends_at, created_by, created_at";

function rowToAnnouncement(r: Record<string, unknown>): Announcement {
  return {
    id: String(r.id),
    level: r.level as AnnouncementLevel,
    popup: r.popup === true,
    title: String(r.title),
    body: String(r.body),
    startsAt: Number(r.starts_at),
    endsAt: r.ends_at === null ? null : Number(r.ends_at),
    createdBy: String(r.created_by),
    createdAt: Number(r.created_at),
  };
}

export function createPostgresAnnouncementStore(
  connectionString: string,
  dismissals: DurableMap<string[]>,
): AnnouncementStore {
  const { q } = createPgPool(connectionString, "zz-qm-cn/announcements/0001", ANNOUNCEMENTS_SCHEMA);
  const orgId = configOrgId();
  async function get(id: string): Promise<Announcement | null> {
    const rows = await q(`SELECT ${ANNOUNCEMENT_COLS} FROM announcements WHERE org_id = $1 AND id = $2`, [orgId, id]);
    return rows[0] ? rowToAnnouncement(rows[0]) : null;
  }
  return {
    async create(draft, createdBy) {
      const id = randomUUID();
      const createdAt = Date.now();
      await q(
        `INSERT INTO announcements(id, org_id, level, title, body, starts_at, ends_at, created_by, created_at, popup)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [
          id,
          orgId,
          draft.level,
          draft.title,
          draft.body,
          draft.startsAt,
          draft.endsAt,
          createdBy,
          createdAt,
          draft.popup === true,
        ],
      );
      return { id, ...draft, createdBy, createdAt };
    },
    get,
    async list() {
      const rows = await q(
        `SELECT ${ANNOUNCEMENT_COLS} FROM announcements WHERE org_id = $1 ORDER BY created_at DESC, id`,
        [orgId],
      );
      return rows.map(rowToAnnouncement);
    },
    async listActive() {
      const now = Date.now();
      const rows = await q(
        `SELECT ${ANNOUNCEMENT_COLS} FROM announcements
         WHERE org_id = $1 AND starts_at <= $2 AND (ends_at IS NULL OR ends_at > $2)
         ORDER BY starts_at DESC, created_at DESC, id`,
        [orgId, now],
      );
      return rows.map(rowToAnnouncement);
    },
    async update(id, patch) {
      const sets: string[] = [];
      const args: unknown[] = [];
      const set = (col: string, value: unknown): void => {
        args.push(value);
        sets.push(`${col} = $${args.length}`);
      };
      if (patch.popup !== undefined) set("popup", patch.popup);
      if (patch.level !== undefined) set("level", patch.level);
      if (patch.title !== undefined) set("title", patch.title);
      if (patch.body !== undefined) set("body", patch.body);
      if (patch.startsAt !== undefined) set("starts_at", patch.startsAt);
      if (patch.endsAt !== undefined) set("ends_at", patch.endsAt);
      if (!sets.length) return get(id);
      args.push(orgId, id);
      const rows = await q(
        `UPDATE announcements SET ${sets.join(", ")}
         WHERE org_id = $${args.length - 1} AND id = $${args.length}
         RETURNING ${ANNOUNCEMENT_COLS}`,
        args,
      );
      return rows[0] ? rowToAnnouncement(rows[0]) : null;
    },
    ...dismissalFace(dismissals),
  };
}
