import { randomUUID } from "node:crypto";
import { createPgPool, withPgTransaction } from "../persistence/pg-pool.ts";

const LEGACY_INTENT_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_PENDING_PER_MEMBER = 500;
const PAGE_SIZE = 50;

export interface LegacyTurnIntentPayload {
  text: string;
  attachmentsWerePresent?: boolean;
  quoteSeq?: number;
  quoteText?: string;
  quoteAuthor?: string;
  attachments?: Array<{ name: string; mimetype: string; sizeBytes: number; blobId: string }>;
}

interface LegacyTurnIntentInput {
  principalId: string;
  scopeId: string;
  threadRef: string;
  payload: LegacyTurnIntentPayload;
}

interface LegacyTurnIntent extends LegacyTurnIntentInput {
  id: string;
  text: string;
  status: "pending_review";
  createdAt: number;
  expiresAt: number;
  requiresReattach: boolean;
}

export interface LegacyTurnIntentStore {
  add(input: LegacyTurnIntentInput): Promise<LegacyTurnIntent>;
  list(
    principalId: string,
    before?: { createdAt: number; id: string },
  ): Promise<{ intents: LegacyTurnIntent[]; nextCursor: string | null }>;
  dismiss(principalId: string, ingressId: string): Promise<void>;
  prune(now?: number): Promise<number>;
  close(): Promise<void>;
}

export class LegacyTurnIntentCapacityError extends Error {
  constructor() {
    super("legacy turn intent capacity reached");
  }
}

export function createPostgresLegacyTurnIntentStore(connectionString: string): LegacyTurnIntentStore {
  const pg = createPgPool(connectionString, "zz-qm-cn/legacy-turn-intents/0001", [
    `CREATE TABLE IF NOT EXISTS legacy_turn_intents(
      id TEXT PRIMARY KEY,
      principal_id TEXT NOT NULL,
      scope_id TEXT NOT NULL,
      thread_ref TEXT NOT NULL,
      payload JSONB NOT NULL,
      created_at BIGINT NOT NULL,
      expires_at BIGINT NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS idx_legacy_turn_intents_owner_page
      ON legacy_turn_intents(principal_id, created_at DESC, id DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_legacy_turn_intents_expiry ON legacy_turn_intents(expires_at)`,
  ]);

  const fromRow = (row: Record<string, unknown>): LegacyTurnIntent => {
    const payload = row.payload as LegacyTurnIntentPayload;
    return {
      id: row.id as string,
      principalId: row.principal_id as string,
      scopeId: row.scope_id as string,
      threadRef: row.thread_ref as string,
      payload,
      text: payload.text,
      status: "pending_review",
      createdAt: Number(row.created_at),
      expiresAt: Number(row.expires_at),
      requiresReattach: Boolean(payload.attachmentsWerePresent || payload.attachments?.length),
    };
  };

  return {
    async add(input) {
      const now = Date.now();
      const id = randomUUID();
      const pool = await pg.pool();
      await withPgTransaction(pool, async (client) => {
        await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`legacy-intents:${input.principalId}`]);
        await client.query("DELETE FROM legacy_turn_intents WHERE expires_at <= $1", [now]);
        const counted = await client.query("SELECT count(*) AS total FROM legacy_turn_intents WHERE principal_id=$1", [
          input.principalId,
        ]);
        if (Number(counted.rows[0]?.total) >= MAX_PENDING_PER_MEMBER) throw new LegacyTurnIntentCapacityError();
        await client.query(
          `INSERT INTO legacy_turn_intents(id, principal_id, scope_id, thread_ref, payload, created_at, expires_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [
            id,
            input.principalId,
            input.scopeId,
            input.threadRef,
            JSON.stringify(input.payload),
            now,
            now + LEGACY_INTENT_TTL_MS,
          ],
        );
      });
      return {
        ...input,
        id,
        text: input.payload.text,
        status: "pending_review" as const,
        createdAt: now,
        expiresAt: now + LEGACY_INTENT_TTL_MS,
        requiresReattach: Boolean(input.payload.attachmentsWerePresent || input.payload.attachments?.length),
      };
    },

    async list(principalId, before) {
      const rows = await pg.q(
        `SELECT id, principal_id, scope_id, thread_ref, payload, created_at, expires_at
         FROM legacy_turn_intents
         WHERE principal_id=$1 AND expires_at>$2
           AND ($3::BIGINT IS NULL OR (created_at, id) < ($3::BIGINT, $4::TEXT))
         ORDER BY created_at DESC, id DESC LIMIT $5`,
        [principalId, Date.now(), before?.createdAt ?? null, before?.id ?? null, PAGE_SIZE + 1],
      );
      const visible = rows.slice(0, PAGE_SIZE).map(fromRow);
      const last = visible.at(-1);
      return {
        intents: visible,
        nextCursor: rows.length > PAGE_SIZE && last ? `${last.createdAt}:${last.id}` : null,
      };
    },

    async prune(now = Date.now()) {
      return (await pg.query("DELETE FROM legacy_turn_intents WHERE expires_at <= $1", [now])).rowCount;
    },

    async dismiss(principalId, ingressId) {
      await pg.query("DELETE FROM legacy_turn_intents WHERE principal_id=$1 AND id=$2", [principalId, ingressId]);
    },

    close: () => pg.close(),
  };
}
