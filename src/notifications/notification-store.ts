import { createPgPool } from "../persistence/pg-pool.ts";
import type { Session } from "../types.ts";
import type { SessionStore } from "../sessions/session-store.ts";
import type { DeliveryStore } from "../delivery/delivery-store.ts";
import type { RunStore } from "../runs/run-store.ts";

interface MessageNotification {
  id: string;
  sessionId: string;
  threadRef: string;
  title: string;
  at: number;
  kind: "message" | "mention" | "reply" | "done" | "announcement" | "added";
  unread: boolean;
  unreadCount: number;
  seq?: number;
  deliveryId?: string;
  runId?: string;
  scopeId?: string;
}

interface NotificationPage {
  items: MessageNotification[];
  unreadCount: number;
  unreadThreads: number;
  nextCursor?: string;
}

interface NotificationResult {
  title: string;
  threadRef: string;
  at: number;
  text: string;
  files: { id: string; name: string }[];
}

export interface NotificationStore {
  prepare(): Promise<void>;
  list(viewer: string, sessions: Session[], cursor?: string, viewerName?: string): Promise<NotificationPage>;
  read(viewer: string, sessions: Session[], id: string): Promise<boolean>;
  readAll(viewer: string, sessions: Session[]): Promise<number>;
  result(viewer: string, sessions: Session[], id: string): Promise<NotificationResult | null>;
  close(): Promise<void>;
}

const ANNOUNCEMENT_PREFIX = "announcement:";

export function announcementIdOf(notificationId: string): string | null {
  return notificationId.startsWith(ANNOUNCEMENT_PREFIX) ? notificationId.slice(ANNOUNCEMENT_PREFIX.length) : null;
}

export function mentions(text: string, name: string): boolean {
  const tag = `@${name}`;
  const latinEnd = /[A-Za-z0-9_]$/.test(name);
  for (let at = text.indexOf(tag); at >= 0; at = text.indexOf(tag, at + 1)) {
    if (!latinEnd || !/[A-Za-z0-9_]/.test(text.charAt(at + tag.length))) return true;
  }
  return false;
}

const PROJECT_JOIN_PREFIX = "project-join:";

export function projectJoinIdOf(notificationId: string): string | null {
  return notificationId.startsWith(PROJECT_JOIN_PREFIX) ? notificationId.slice(PROJECT_JOIN_PREFIX.length) : null;
}

function withRows(page: NotificationPage, rows: MessageNotification[], firstPage: boolean): NotificationPage {
  const unread = rows.filter((row) => row.unread).length;
  return {
    ...page,
    items: firstPage ? [...page.items, ...rows].sort((a, b) => b.at - a.at) : page.items,
    unreadCount: page.unreadCount + unread,
    unreadThreads: page.unreadThreads + unread,
  };
}

export function withAnnouncements(
  page: NotificationPage,
  active: ReadonlyArray<{ id: string; title: string; startsAt: number }>,
  dismissed: readonly string[],
  firstPage: boolean,
): NotificationPage {
  const seen = new Set(dismissed);
  const rows = active.map((announcement): MessageNotification => {
    const id = `${ANNOUNCEMENT_PREFIX}${announcement.id}`;
    const unread = !seen.has(announcement.id);
    return {
      id,
      sessionId: id,
      threadRef: id,
      title: announcement.title,
      at: announcement.startsAt,
      kind: "announcement",
      unread,
      unreadCount: Number(unread),
    };
  });
  return withRows(page, rows, firstPage);
}

export function withProjectJoins(
  page: NotificationPage,
  joins: ReadonlyArray<{ projectId: string; name: string; scopeId: string; addedAt: number; seenAt: number | null }>,
  firstPage: boolean,
): NotificationPage {
  const rows = joins.map((join): MessageNotification => {
    const id = `${PROJECT_JOIN_PREFIX}${join.projectId}`;
    const unread = join.seenAt === null;
    return {
      id,
      sessionId: id,
      threadRef: id,
      title: join.name,
      at: join.addedAt,
      kind: "added",
      unread,
      unreadCount: Number(unread),
      scopeId: join.scopeId,
    };
  });
  return withRows(page, rows, firstPage);
}

export function notificationCursor(value?: string): { at: number; id: string } | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString()) as { at?: unknown; id?: unknown };
    if (
      typeof parsed.at !== "number" ||
      !Number.isSafeInteger(parsed.at) ||
      parsed.at < 0 ||
      typeof parsed.id !== "string" ||
      !parsed.id ||
      parsed.id.length > 200
    )
      throw new Error();
    return { at: parsed.at, id: parsed.id };
  } catch {
    throw new Error("invalid notification cursor");
  }
}

const SOURCES = `WITH allowed AS (
  SELECT s.* FROM sessions s WHERE s.id = ANY($2::text[]) AND s.surface = 'web'
), source AS (
  SELECT 'entry:' || e.session_id || ':' || lpad(e.seq::text, 10, '0') AS id, e.session_id, e.created_at AS at,
    'message'::text AS kind, e.seq, NULL::text AS delivery_id, r.id AS run_id
  FROM allowed s
  JOIN session_entries e ON e.session_id = s.id AND e.type = 'user'
  JOIN participants p ON p.session_id = s.id AND p.principal_id = $1
  JOIN runs r ON r.id = safe_json(e.payload)->>'runId' AND r.session_id = s.thread_ref
  WHERE e.created_at >= (SELECT activated_at FROM notification_state WHERE id = 1)
    AND COALESCE(r.request::jsonb->'origin'->>'kind', 'direct') IN ('human', 'direct')
    AND COALESCE(r.request::jsonb->>'triggered', 'false') <> 'true'
    AND COALESCE(r.request::jsonb->>'unprompted', 'false') <> 'true'
    AND r.request::jsonb->'actor'->>'id' IS DISTINCT FROM $1
    AND COALESCE(safe_json(e.payload)->>'overheard', 'false') <> 'true'
    AND COALESCE(safe_json(e.payload)->>'hidden', 'false') <> 'true'
    AND (((p.valid_from_seq IS NOT NULL AND e.seq >= p.valid_from_seq)
      OR (p.valid_from_seq IS NULL AND e.created_at >= p.valid_from))
      AND ((p.valid_to_seq IS NOT NULL AND e.seq < p.valid_to_seq)
      OR (p.valid_to_seq IS NULL AND (p.valid_to IS NULL OR e.created_at < p.valid_to))))
  UNION ALL
  SELECT 'delivery:' || d.id, s.id, d.created_at, 'reply', location.seq, d.id,
    CASE WHEN dr.id IS NOT NULL THEN dr.id ELSE NULL END
  FROM allowed s
  JOIN deliveries d ON d.destination->>'target' = s.thread_ref AND d.destination->>'type' = 'web'
  JOIN participants p ON p.session_id = s.id AND p.principal_id = $1
  LEFT JOIN runs dr ON d.idempotency_key = 'run:' || dr.id
  CROSS JOIN LATERAL (
    SELECT CASE WHEN d.provenance->>'sourceThreadRef' = s.thread_ref
      AND jsonb_typeof(d.provenance->'sourceAssistantEntrySeq') = 'number'
      AND (d.provenance->>'sourceAssistantEntrySeq') ~ '^[0-9]{1,9}$'
      THEN (d.provenance->>'sourceAssistantEntrySeq')::integer ELSE NULL END AS seq
  ) location
  WHERE NOT d.shadow
    AND d.created_at >= (SELECT activated_at FROM notification_state WHERE id = 1)
    AND (d.idempotency_key NOT LIKE 'run:%' OR
      (dr.id IS NOT NULL AND (COALESCE(dr.request::jsonb->>'surfaceTools', 'false') <> 'true'
        OR dr.status = 'failed' OR dr.result::jsonb->>'status' = 'failed')))
    AND ((location.seq IS NULL AND d.created_at >= p.valid_from AND (p.valid_to IS NULL OR d.created_at < p.valid_to))
      OR (location.seq IS NOT NULL
        AND ((p.valid_from_seq IS NOT NULL AND location.seq >= p.valid_from_seq)
          OR (p.valid_from_seq IS NULL AND d.created_at >= p.valid_from))
        AND ((p.valid_to_seq IS NOT NULL AND location.seq < p.valid_to_seq)
          OR (p.valid_to_seq IS NULL AND (p.valid_to IS NULL OR d.created_at < p.valid_to)))))
  UNION ALL
  SELECT 'run:' || r.id, s.id, r.finished_at, 'done', location.seq, NULL::text, r.id
  FROM allowed s
  JOIN runs r ON r.session_id = s.thread_ref AND r.status = 'done' AND s.parent_session_id IS NULL
  CROSS JOIN LATERAL (
    SELECT CASE WHEN (r.result::jsonb->>'sourceAssistantEntrySeq') ~ '^[0-9]{1,9}$'
      THEN (r.result::jsonb->>'sourceAssistantEntrySeq')::integer ELSE NULL END AS seq
  ) location
  WHERE r.finished_at >= (SELECT completions_at FROM notification_state WHERE id = 1)
    AND COALESCE(r.request::jsonb->>'surfaceTools', 'false') = 'true'
    AND r.request::jsonb->'actor'->>'id' = $1
    AND r.result::jsonb->>'status' = 'ok'
    AND NOT EXISTS (SELECT 1 FROM deliveries d WHERE d.idempotency_key = 'run:' || r.id)
), distinct_source AS (
  SELECT DISTINCT ON (id) * FROM source ORDER BY id
)`;

export function createPostgresNotificationStore(
  connectionString: string,
  dependencies: { sessions: SessionStore; deliveries: DeliveryStore; runs: RunStore },
): NotificationStore {
  const pg = createPgPool(connectionString, [
    {
      id: "zz-qm-cn/notifications/0001",
      statements: [
        `CREATE TABLE IF NOT EXISTS notification_state (
      id INTEGER PRIMARY KEY CHECK (id = 1), activated_at BIGINT NOT NULL
    )`,
        `CREATE TABLE IF NOT EXISTS notification_reads (
      principal_id TEXT NOT NULL, event_id TEXT NOT NULL, session_id TEXT NOT NULL,
      read_at BIGINT NOT NULL, PRIMARY KEY (principal_id, event_id),
      FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
    )`,
        `CREATE INDEX IF NOT EXISTS notification_reads_session_idx ON notification_reads(session_id)`,
        `CREATE INDEX IF NOT EXISTS notification_user_entries_idx
      ON session_entries(session_id, created_at, seq) WHERE type = 'user'`,
        `CREATE INDEX IF NOT EXISTS notification_web_deliveries_idx
      ON deliveries((destination->>'target'), created_at, id) WHERE destination->>'type' = 'web' AND NOT shadow`,
        `INSERT INTO notification_state(id, activated_at)
      VALUES (1, (EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::BIGINT) ON CONFLICT (id) DO NOTHING`,
      ],
    },
    {
      id: "zz-qm-cn/notifications/0002",
      statements: [
        `ALTER TABLE notification_state ADD COLUMN IF NOT EXISTS completions_at BIGINT`,
        `UPDATE notification_state SET completions_at = (EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::BIGINT
          WHERE completions_at IS NULL`,
      ],
    },
  ]);
  let preparing: Promise<void> | undefined;
  const prepare = () =>
    (preparing ??= (async () => {
      try {
        await dependencies.sessions.get("notification-schema");
        await dependencies.deliveries.get("notification-schema");
        await dependencies.runs.get("notification-schema");
        await pg.q("SELECT activated_at FROM notification_state WHERE id = 1");
      } catch (error) {
        preparing = undefined;
        throw error;
      }
    })());
  const selected = (sessions: Session[]) => sessions.filter((s) => s.surface === "web" && !s.archived);
  async function mentionedIn(messages: Array<Record<string, unknown>>, viewerName?: string): Promise<Set<string>> {
    const name = viewerName?.trim();
    if (!name || !messages.length) return new Set();
    const rows = await pg.q(
      `SELECT e.session_id, e.seq, safe_json(e.payload)->>'text' AS text FROM session_entries e
        JOIN unnest($1::text[], $2::int[]) AS wanted(session_id, seq)
          ON e.session_id = wanted.session_id AND e.seq = wanted.seq
        WHERE position($3 in safe_json(e.payload)->>'text') > 0`,
      [messages.map((value) => String(value.session_id)), messages.map((value) => Number(value.seq)), `@${name}`],
    );
    const found = new Set(
      rows.filter((row) => mentions(String(row.text ?? ""), name)).map((row) => `${row.session_id}:${row.seq}`),
    );
    return new Set(
      messages.filter((value) => found.has(`${value.session_id}:${value.seq}`)).map((value) => String(value.id)),
    );
  }
  return {
    prepare,
    async list(viewer, sessions, cursor, viewerName) {
      const after = notificationCursor(cursor);
      await prepare();
      const visible = selected(sessions);
      if (!visible.length) return { items: [], unreadCount: 0, unreadThreads: 0 };
      const [row] = await pg.q(
        `${SOURCES}, events AS (
        SELECT n.*, NOT EXISTS (
          SELECT 1 FROM notification_reads r WHERE r.principal_id = $1 AND r.event_id = n.id
        ) AS unread FROM distinct_source n
      ), grouped AS (
        SELECT DISTINCT ON (session_id) *, COUNT(*) FILTER (WHERE unread) OVER (PARTITION BY session_id) AS unread_count
        FROM events ORDER BY session_id, unread DESC, at DESC, id DESC
      ) SELECT (SELECT COUNT(*) FROM events WHERE unread) AS unread_count,
        (SELECT COUNT(*) FROM grouped WHERE unread) AS unread_threads,
        COALESCE((SELECT jsonb_agg(page ORDER BY at DESC, id DESC) FROM (
          SELECT * FROM grouped WHERE $3::bigint IS NULL OR (at, id) < ($3::bigint, $4::text)
          ORDER BY at DESC, id DESC LIMIT 51
        ) page), '[]'::jsonb) AS items`,
        [viewer, visible.map((s) => s.id), after?.at ?? null, after?.id ?? null],
      );
      const raw = row!.items as Array<Record<string, unknown>>;
      const byId = new Map(visible.map((s) => [s.id, s]));
      const mentions = await mentionedIn(
        raw.filter((value) => value.kind === "message" && value.seq != null),
        viewerName,
      );
      const items = raw.slice(0, 50).map((value): MessageNotification => {
        const session = byId.get(String(value.session_id))!;
        return {
          id: String(value.id),
          sessionId: session.id,
          threadRef: session.threadRef,
          title: session.title || session.channelName || "New message",
          at: Number(value.at),
          kind: mentions.has(String(value.id)) ? "mention" : (value.kind as MessageNotification["kind"]),
          unread: value.unread === true,
          unreadCount: Number(value.unread_count),
          ...(value.kind !== "message" && value.seq != null ? { seq: Number(value.seq) } : {}),
          ...((value.kind === "message" || (value.kind === "done" && value.seq == null)) && value.run_id
            ? { runId: String(value.run_id) }
            : {}),
          ...(value.seq == null && value.delivery_id ? { deliveryId: String(value.delivery_id) } : {}),
        };
      });
      const last = items.at(-1);
      return {
        items,
        unreadCount: Number(row!.unread_count),
        unreadThreads: Number(row!.unread_threads),
        ...(raw.length > 50 && last
          ? {
              nextCursor: Buffer.from(JSON.stringify({ at: last.at, id: last.id })).toString("base64url"),
            }
          : {}),
      };
    },
    async result(viewer, sessions, id) {
      if (!id || id.length > 200) return null;
      await prepare();
      const visible = selected(sessions);
      const [row] = await pg.q(
        `${SOURCES} SELECT n.session_id, n.at, d.text, d.attachments
         FROM distinct_source n JOIN deliveries d ON d.id = n.delivery_id
         WHERE n.id = $3 LIMIT 1`,
        [viewer, visible.map((s) => s.id), id],
      );
      if (!row) return null;
      const session = visible.find((s) => s.id === row.session_id)!;
      const attachments = Array.isArray(row.attachments) ? row.attachments : [];
      return {
        title: session.title || session.channelName || "Task result",
        threadRef: session.threadRef,
        at: Number(row.at),
        text: String(row.text ?? ""),
        files: attachments.flatMap((file) =>
          typeof file?.artifactId === "string" && typeof file?.name === "string"
            ? [{ id: file.artifactId, name: file.name }]
            : [],
        ),
      };
    },
    async read(viewer, sessions, id) {
      if (!id || id.length > 200) return false;
      await prepare();
      const [row] = await pg.q(
        `${SOURCES}, target AS (
        SELECT * FROM distinct_source WHERE id = $3
      ), saved AS (
        INSERT INTO notification_reads(principal_id, event_id, session_id, read_at)
        SELECT $1, n.id, n.session_id, (EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::BIGINT
        FROM distinct_source n JOIN target t ON n.session_id = t.session_id AND (n.id = t.id OR (
          n.at < t.at
          AND (n.delivery_id IS NULL OR n.seq IS NOT NULL)
          AND (t.delivery_id IS NULL OR t.seq IS NOT NULL)
        ))
        ON CONFLICT (principal_id, event_id) DO NOTHING RETURNING event_id
      ) SELECT EXISTS(SELECT 1 FROM target) AS found`,
        [viewer, selected(sessions).map((s) => s.id), id],
      );
      return row?.found === true;
    },
    async readAll(viewer, sessions) {
      await prepare();
      const visible = selected(sessions);
      if (!visible.length) return 0;
      const rows = await pg.q(
        `${SOURCES} INSERT INTO notification_reads(principal_id, event_id, session_id, read_at)
        SELECT $1, n.id, n.session_id, (EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::BIGINT FROM distinct_source n
        ON CONFLICT (principal_id, event_id) DO NOTHING RETURNING event_id`,
        [viewer, visible.map((s) => s.id)],
      );
      return rows.length;
    },
    close: () => pg.close(),
  };
}
