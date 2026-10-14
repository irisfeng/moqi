import type { PoolClient } from "pg";

export interface TokenUsage {
  calls: number;
  measuredCalls: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  other: number;
  total: number;
}
export const emptyTokenUsage = (): TokenUsage => ({
  calls: 0,
  measuredCalls: 0,
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  other: 0,
  total: 0,
});
export function sumTokenUsage(items: TokenUsage[]): TokenUsage {
  const result = emptyTokenUsage();
  for (const item of items) for (const key of Object.keys(result) as (keyof TokenUsage)[]) result[key] += item[key];
  return result;
}
export function parseTokenUsage(raw: unknown): TokenUsage {
  const result = emptyTokenUsage();
  result.calls = 1;
  try {
    const value = JSON.parse(String(raw));
    const fields = ["input", "output", "cacheRead", "cacheWrite"] as const;
    if (!value || !fields.every((key) => Number.isSafeInteger(value[key]) && value[key] >= 0)) return result;
    const total = fields.reduce((n, key) => n + value[key], 0);
    if (!Number.isSafeInteger(total) || !Number.isSafeInteger(value.totalTokens) || value.totalTokens < 0)
      return result;
    let uncachedInput = value.input;
    if (value.totalTokens < total) {
      if (value.totalTokens !== value.input + value.output || value.input < value.cacheRead + value.cacheWrite)
        return result;
      uncachedInput -= value.cacheRead + value.cacheWrite;
    }
    for (const key of fields) result[key] = value[key];
    result.input = uncachedInput;
    result.other = Math.max(0, value.totalTokens - total);
    result.total = value.totalTokens;
    result.measuredCalls = 1;
  } catch {
    return result;
  }
  return result;
}
export async function readTokenUsage(
  client: PoolClient,
  org: string,
  from: number,
  to: number,
  aliases: Map<string, string>,
) {
  const readiness = await client.query(
    "SELECT to_regclass('session_llm_requests') IS NOT NULL AND to_regclass('turn_metrics') IS NOT NULL AS available",
  );
  if (!readiness.rows[0]?.available)
    return {
      available: false,
      byActor: new Map<string, TokenUsage>(),
      unattributed: emptyTokenUsage(),
      nonHuman: emptyTokenUsage(),
    };
  const { rows } = await client.query(
    `WITH selected_calls AS MATERIALIZED (
      SELECT session_id,turn_seq,usage_json FROM session_llm_requests WHERE created_at >= $2 AND created_at < $3
    ), turns AS (
      SELECT m.session_id,m.turn_seq,MIN(m.run_id) AS run_id
      FROM turn_metrics m
      JOIN (SELECT DISTINCT session_id,turn_seq FROM selected_calls WHERE turn_seq IS NOT NULL) s
        ON s.session_id=m.session_id AND s.turn_seq=m.turn_seq
      WHERE m.run_id IS NOT NULL
      GROUP BY m.session_id,m.turn_seq HAVING COUNT(DISTINCT m.run_id)=1
    )
    SELECT l.usage_json,f.principal,f.origin
    FROM selected_calls l
    LEFT JOIN turns t ON t.session_id=l.session_id AND t.turn_seq=l.turn_seq
    LEFT JOIN adoption_run_facts f ON f.org=$1 AND f.run_id=t.run_id`,
    [org, from, to],
  );
  const byActor = new Map<string, TokenUsage>();
  let unattributed = emptyTokenUsage();
  let nonHuman = emptyTokenUsage();
  for (const row of rows) {
    const usage = parseTokenUsage(row.usage_json);
    if (!row.principal || !row.origin || row.origin === "invalid") {
      unattributed = sumTokenUsage([unattributed, usage]);
    } else if (row.origin !== "human") {
      nonHuman = sumTokenUsage([nonHuman, usage]);
    } else {
      const principal = aliases.get(String(row.principal)) ?? String(row.principal);
      byActor.set(principal, sumTokenUsage([byActor.get(principal) ?? emptyTokenUsage(), usage]));
    }
  }
  return { available: true, byActor, unattributed, nonHuman };
}
