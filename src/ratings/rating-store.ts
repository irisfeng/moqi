import { createPgPool } from "../persistence/pg-pool.ts";
import type { SessionStore } from "../sessions/session-store.ts";

export interface Rating {
  principalId: string;
  targetId: string;
  sessionId: string;
  value: "up" | "down";
  reason: string;
  model: string | null;
  skills: string[];
  updatedAt: number;
}

interface RatingTally {
  name: string;
  up: number;
  down: number;
}

export interface RatingSummary {
  byModel: RatingTally[];
  bySkill: RatingTally[];
  reasons: Array<{ reason: string; model: string | null; skills: string[]; at: number }>;
}

export interface RatingStore {
  set(rating: Rating): Promise<void>;
  remove(principalId: string, targetId: string): Promise<void>;
  forSession(principalId: string, sessionId: string): Promise<Rating[]>;
  summary(): Promise<RatingSummary>;
  close?(): Promise<void>;
}

export const RATING_REASON_LIMIT = 500;
const TURN_SCAN_LIMIT = 400;
const REASONS_SHOWN = 50;

export function ratingTargetId(sessionId: string, seq: number, fileId?: string): string {
  return fileId ? `file:${sessionId}:${fileId}` : `entry:${sessionId}:${seq}`;
}

export async function ratingContext(
  sessions: Pick<SessionStore, "getEntries" | "listLlmRequests">,
  sessionId: string,
  seq: number,
): Promise<{ model: string | null; skills: string[] }> {
  const entries = await sessions.getEntries(sessionId, { beforeSeq: seq + 1, limit: TURN_SCAN_LIMIT });
  const turn = entries.filter((entry) => entry.type === "user" && entry.seq <= seq).at(-1);
  if (!turn) return { model: null, skills: [] };
  const skills = new Set<string>();
  for (const entry of entries) {
    if (entry.seq <= turn.seq || entry.type !== "tool_call") continue;
    const call = entry.payload as { tool?: unknown; action?: unknown; name?: unknown } | null;
    if (call?.tool === "skills" && call.action === "read" && typeof call.name === "string") skills.add(call.name);
  }
  const requests = await sessions.listLlmRequests(sessionId, { turnSeqs: [turn.seq], omitRequest: true });
  return { model: requests.at(-1)?.model ?? null, skills: [...skills].sort() };
}

function tally(ratings: readonly Rating[], names: (rating: Rating) => string[]): RatingTally[] {
  const rows = new Map<string, RatingTally>();
  for (const rating of ratings) {
    for (const name of names(rating)) {
      const row = rows.get(name) ?? { name, up: 0, down: 0 };
      row[rating.value] += 1;
      rows.set(name, row);
    }
  }
  return [...rows.values()].sort((a, b) => b.up + b.down - (a.up + a.down) || a.name.localeCompare(b.name));
}

export function summarizeRatings(ratings: readonly Rating[]): RatingSummary {
  return {
    byModel: tally(ratings, (rating) => [rating.model ?? ""]),
    bySkill: tally(ratings, (rating) => rating.skills),
    reasons: ratings
      .filter((rating) => rating.value === "down" && rating.reason)
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, REASONS_SHOWN)
      .map((rating) => ({ reason: rating.reason, model: rating.model, skills: rating.skills, at: rating.updatedAt })),
  };
}

export function createMemoryRatingStore(): RatingStore {
  const ratings = new Map<string, Rating>();
  const keyOf = (principalId: string, targetId: string) => JSON.stringify([principalId, targetId]);
  return {
    async set(rating) {
      ratings.set(keyOf(rating.principalId, rating.targetId), { ...rating, skills: [...rating.skills] });
    },
    async remove(principalId, targetId) {
      ratings.delete(keyOf(principalId, targetId));
    },
    async forSession(principalId, sessionId) {
      return [...ratings.values()].filter((r) => r.principalId === principalId && r.sessionId === sessionId);
    },
    async summary() {
      return summarizeRatings([...ratings.values()]);
    },
  };
}

export function createPostgresRatingStore(connectionString: string): RatingStore {
  const { q, close } = createPgPool(connectionString, "zz-qm-cn/ratings/0001", [
    `CREATE TABLE IF NOT EXISTS answer_ratings(
        principal_id TEXT NOT NULL,
        target_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        value TEXT NOT NULL CHECK (value IN ('up','down')),
        reason TEXT NOT NULL DEFAULT '',
        model TEXT,
        skills JSONB NOT NULL DEFAULT '[]'::jsonb,
        updated_at BIGINT NOT NULL,
        PRIMARY KEY (principal_id, target_id)
      )`,
    `CREATE INDEX IF NOT EXISTS answer_ratings_session_idx ON answer_ratings(principal_id, session_id)`,
  ]);
  const toRating = (r: Record<string, unknown>): Rating => ({
    principalId: r.principal_id as string,
    targetId: r.target_id as string,
    sessionId: r.session_id as string,
    value: r.value as Rating["value"],
    reason: r.reason as string,
    model: (r.model as string | null) ?? null,
    skills: Array.isArray(r.skills) ? (r.skills as string[]) : [],
    updatedAt: Number(r.updated_at),
  });
  return {
    async set(rating) {
      await q(
        `INSERT INTO answer_ratings(principal_id, target_id, session_id, value, reason, model, skills, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)
         ON CONFLICT (principal_id, target_id) DO UPDATE SET session_id = EXCLUDED.session_id,
           value = EXCLUDED.value, reason = EXCLUDED.reason, model = EXCLUDED.model, skills = EXCLUDED.skills,
           updated_at = EXCLUDED.updated_at`,
        [
          rating.principalId,
          rating.targetId,
          rating.sessionId,
          rating.value,
          rating.reason,
          rating.model,
          JSON.stringify(rating.skills),
          rating.updatedAt,
        ],
      );
    },
    async remove(principalId, targetId) {
      await q(`DELETE FROM answer_ratings WHERE principal_id = $1 AND target_id = $2`, [principalId, targetId]);
    },
    async forSession(principalId, sessionId) {
      const rows = await q(`SELECT * FROM answer_ratings WHERE principal_id = $1 AND session_id = $2`, [
        principalId,
        sessionId,
      ]);
      return rows.map(toRating);
    },
    async summary() {
      return summarizeRatings((await q(`SELECT * FROM answer_ratings`)).map(toRating));
    },
    close,
  };
}
