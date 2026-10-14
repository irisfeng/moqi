import { readTokenUsage, emptyTokenUsage, sumTokenUsage } from "./token-usage.ts";
import { z } from "zod";
import { createPgPool, withPgTransaction } from "../persistence/pg-pool.ts";
import type { DirectoryStore } from "../directory/directory-store.ts";
import { personKey, personKeys } from "../directory/person.ts";
import { resolveTurnOrigin } from "../core/turn-origin.ts";
import type { OrchestratorInput } from "../core/orchestrator.ts";
import type { RunStore } from "../runs/run-store.ts";
import type { TurnResult } from "../types.ts";
import {
  ADOPTION_SCENARIO_SCHEMA,
  ADOPTION_SCENARIO_TAXONOMY_RENAME,
  createAdoptionScenarios,
  readAdoptionScenarios,
} from "./adoption-scenarios.ts";
import type { AdoptionScenarioOptions } from "./adoption-scenario-classifier.ts";
import { reportFailure } from "../util/errors.ts";

export interface AdoptionMember {
  principalId: string;
  displayName: string;
  department: string | null;
  eligibleFrom: number | null;
  eligibleTo: number | null;
  isTest: boolean;
}
export interface AdoptionRosterInput {
  revision: number;
  source: string;
  members: AdoptionMember[];
}
export interface AdoptionWindow {
  from: number;
  to: number;
  department?: string;
  search?: string;
}
export class AdoptionConflict extends Error {}
const epoch = z.number().int().min(0).max(8640000000000000);
const memberSchema = z
  .object({
    principalId: z.string().trim().min(1).max(254).transform(personKey),
    displayName: z.string().trim().min(1).max(120),
    department: z.string().trim().min(1).max(120).nullable(),
    eligibleFrom: epoch.nullable(),
    eligibleTo: epoch.nullable(),
    isTest: z.boolean(),
  })
  .strict()
  .refine((m) => m.eligibleTo === null || m.eligibleFrom === null || m.eligibleTo > m.eligibleFrom);
const rosterSchema = z
  .object({
    revision: z.number().int().min(0),
    source: z.string().trim().min(1).max(300),
    members: z.array(memberSchema).min(1).max(10000),
  })
  .strict()
  .refine((r) => new Set(r.members.map((m) => m.principalId)).size === r.members.length);
export function parseAdoptionRoster(input: unknown): AdoptionRosterInput {
  return rosterSchema.parse(input);
}

function storedObject(raw: unknown): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(String(raw));
    return value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

export function createAdoptionStore(
  connectionString: string,
  org: string,
  source: Pick<RunStore, "get">,
  directory?: Pick<DirectoryStore, "list">,
  scenarioOptions: AdoptionScenarioOptions = {},
) {
  async function identityKeys() {
    const keys = new Map<string, string>();
    for (const member of (await directory?.list()) ?? []) {
      if (member.type !== "internal") continue;
      const canonical = personKey(member.principalId);
      for (const key of personKeys(member, canonical)) {
        if (keys.has(key) && keys.get(key) !== canonical)
          throw new AdoptionConflict("Member directory alias conflict. Check the directory first.");
        keys.set(key, canonical);
      }
    }
    return keys;
  }
  function canonicalMembers(members: AdoptionMember[], keys: Map<string, string>) {
    const resolved = members.map((m) => ({ ...m, principalId: keys.get(m.principalId) ?? m.principalId }));
    if (new Set(resolved.map((m) => m.principalId)).size !== resolved.length)
      throw new AdoptionConflict("Several tracked members share one directory identity. Check the roster first.");
    return resolved;
  }
  const db = createPgPool(connectionString, "zz-qm-cn/adoption/0001", [
    `CREATE TABLE IF NOT EXISTS adoption_source_binding (singleton BOOLEAN PRIMARY KEY DEFAULT true CHECK (singleton), org TEXT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS adoption_roster_versions (
      org TEXT NOT NULL, revision INT NOT NULL, actor TEXT NOT NULL, source TEXT NOT NULL,
      recorded_at BIGINT NOT NULL, members JSONB NOT NULL, PRIMARY KEY(org, revision))`,
    `CREATE TABLE IF NOT EXISTS adoption_run_facts (
      org TEXT NOT NULL, run_id TEXT NOT NULL, principal TEXT, origin TEXT NOT NULL,
      created_at BIGINT NOT NULL, status TEXT NOT NULL, succeeded BOOLEAN NOT NULL,
      checked_at BIGINT NOT NULL, PRIMARY KEY(org, run_id))`,
    `ALTER TABLE adoption_run_facts ADD COLUMN IF NOT EXISTS projection_version INT NOT NULL DEFAULT 1`,
    `CREATE INDEX IF NOT EXISTS adoption_facts_actor ON adoption_run_facts(org, principal, created_at)`,
    `CREATE INDEX IF NOT EXISTS adoption_facts_window ON adoption_run_facts(org, created_at) WHERE origin='human'`,
    `CREATE INDEX IF NOT EXISTS adoption_facts_refresh ON adoption_run_facts(org, status, checked_at)`,
    `CREATE TABLE IF NOT EXISTS adoption_sync_state (org TEXT PRIMARY KEY, checked_at BIGINT NOT NULL)`,
    ...ADOPTION_SCENARIO_SCHEMA,
  ]);
  let sourceReady: Promise<void> | undefined;
  async function ready() {
    sourceReady ??= (async () => {
      await source.get("adoption-schema-readiness");
      await db.migrate({ id: "zz-qm-cn/adoption/0003-taxonomy-name", statements: ADOPTION_SCENARIO_TAXONOMY_RENAME });
      const existing = await db.q(
        `SELECT EXISTS(SELECT 1 FROM adoption_roster_versions WHERE org<>$1
        UNION ALL SELECT 1 FROM adoption_run_facts WHERE org<>$1) AS conflict`,
        [org],
      );
      if (existing[0]?.conflict) throw new Error("adoption organization differs from existing source database records");
      await db.q("INSERT INTO adoption_source_binding(singleton,org) VALUES(true,$1) ON CONFLICT DO NOTHING", [org]);
      const binding = await db.q("SELECT org FROM adoption_source_binding WHERE singleton=true");
      if (binding[0]?.org !== org) throw new Error("adoption source database is bound to another organization");
    })().catch((error: unknown) => {
      sourceReady = undefined;
      throw error;
    });
    await sourceReady;
  }
  let unavailableReported = false;
  async function whenAvailable(work: () => unknown): Promise<void> {
    try {
      await ready();
    } catch (error) {
      if (!unavailableReported) reportFailure("adoption: unavailable until its source database is consistent", error);
      unavailableReported = true;
      return;
    }
    unavailableReported = false;
    await work();
  }
  async function prepare() {
    await ready();
    await db.migrate({
      id: "zz-qm-cn/adoption/0002-runs-created-index",
      statements: ["CREATE INDEX CONCURRENTLY IF NOT EXISTS adoption_runs_created ON runs(created_at,id)"],
    });
  }
  async function roster() {
    await ready();
    const rows = await db.q("SELECT * FROM adoption_roster_versions WHERE org=$1 ORDER BY revision DESC LIMIT 1", [
      org,
    ]);
    const row = rows[0];
    return {
      revision: row ? Number(row.revision) : 0,
      source: row ? String(row.source) : null,
      recordedAt: row ? Number(row.recorded_at) : null,
      members: (row?.members ?? []) as AdoptionMember[],
    };
  }
  const scenarioWorker = createAdoptionScenarios(
    db,
    org,
    ready,
    async () => {
      const keys = await identityKeys();
      const current = await roster();
      return { keys, members: canonicalMembers(current.members, keys) };
    },
    scenarioOptions,
  );
  async function saveRoster(raw: AdoptionRosterInput, actor: string) {
    const input = parseAdoptionRoster(raw);
    const keys = await identityKeys();
    input.members = canonicalMembers(input.members, keys);
    await ready();
    return withPgTransaction(await db.pool(), async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`adoption-roster:${org}`]);
      const { rows } = await client.query(
        "SELECT revision,members FROM adoption_roster_versions WHERE org=$1 ORDER BY revision DESC LIMIT 1",
        [org],
      );
      const revision = Number(rows[0]?.revision ?? 0);
      if (input.revision !== revision) throw new AdoptionConflict("Member data was updated. Refresh and try again.");
      const byId = new Map<string, AdoptionMember>(
        canonicalMembers((rows[0]?.members ?? []) as AdoptionMember[], keys).map((m) => [m.principalId, m]),
      );
      for (const m of input.members)
        byId.set(personKey(m.principalId), { ...m, principalId: personKey(m.principalId) });
      if (byId.size > 10000) throw new AdoptionConflict("The tracked member limit is 10000. Check the roster first.");
      await client.query("INSERT INTO adoption_roster_versions VALUES($1,$2,$3,$4,$5,$6)", [
        org,
        revision + 1,
        actor,
        input.source,
        Date.now(),
        JSON.stringify([...byId.values()]),
      ]);
      return { revision: revision + 1 };
    });
  }
  async function sync() {
    await ready();
    return withPgTransaction(await db.pool(), async (client) => {
      const lock = await client.query("SELECT pg_try_advisory_xact_lock(hashtext($1)) AS acquired", [
        `adoption-sync:${org}`,
      ]);
      if (!lock.rows[0]?.acquired) return { processed: 0, refreshed: 0 };
      await client.query("SET LOCAL statement_timeout = '5s'");
      const now = Date.now();
      const { rows } = await client.query(
        `
        SELECT r.id,r.request,r.result,r.status,r.created_at,r.started_at,r.finished_at,r.attempts FROM runs r
        WHERE NOT EXISTS (SELECT 1 FROM adoption_run_facts f WHERE f.org=$1 AND f.run_id=r.id)
        ORDER BY r.created_at,r.id LIMIT 500`,
        [org],
      );
      const pending = await client.query(
        `
        SELECT r.id,r.request,r.result,r.status,r.created_at,r.started_at,r.finished_at,r.attempts FROM adoption_run_facts f
        JOIN runs r ON r.id=f.run_id WHERE f.org=$1 AND (f.projection_version<2 OR f.status IN ('pending','running','unknown_done'))
        ORDER BY (f.status IN ('pending','running')) DESC,(f.projection_version<2) DESC,f.checked_at,f.run_id LIMIT 500`,
        [org],
      );
      await client.query(
        `UPDATE adoption_run_facts f SET status='source_missing',succeeded=false,checked_at=$2
         WHERE f.org=$1 AND f.status IN ('pending','running')
         AND NOT EXISTS (SELECT 1 FROM runs r WHERE r.id=f.run_id)`,
        [org, now],
      );
      await client.query(
        `UPDATE adoption_run_facts f SET projection_version=2,
         status=CASE WHEN status='other_done' THEN 'unknown_done' ELSE status END
         WHERE f.org=$1 AND f.projection_version<2 AND NOT EXISTS (SELECT 1 FROM runs r WHERE r.id=f.run_id)`,
        [org],
      );
      const candidates = [...rows, ...pending.rows];
      const metricsReady = await client.query("SELECT to_regclass('turn_metrics') AS name");
      const metrics = metricsReady.rows[0]?.name
        ? (
            await client.query(
              `SELECT DISTINCT ON (m.run_id) m.run_id,m.status,m.ts FROM turn_metrics m
             JOIN runs r ON r.id=m.run_id
             WHERE m.run_id=ANY($1::text[]) AND m.ts>=r.started_at AND m.ts<=r.finished_at
             ORDER BY m.run_id,m.ts DESC,m.id DESC`,
              [candidates.map((r) => r.id)],
            )
          ).rows
        : [];
      const byRun = new Map(metrics.map((m) => [String(m.run_id), m]));
      for (const row of candidates) {
        const parsedRequest = storedObject(row.request);
        const request = parsedRequest as Partial<OrchestratorInput> | null;
        const resolvedOrigin = request ? resolveTurnOrigin(request).kind : "invalid";
        let origin = ["human", "automation", "ambient", "direct"].includes(resolvedOrigin) ? resolvedOrigin : "invalid";
        if (request?.proactiveOpener === true) origin = "automation";
        const principal =
          request?.actor?.type === "internal" && typeof request.actor.id === "string"
            ? personKey(request.actor.id)
            : null;
        const result = row.result ? (storedObject(row.result) as TurnResult | null) : null;
        let status = String(row.status);
        if (status === "done") {
          if (result?.stopped === true) status = "stopped";
          else if (result?.status === "failed") status = "failed";
          else if (result?.status === "silent") {
            const metric = byRun.get(String(row.id));
            const completed =
              request?.surfaceTools === true &&
              Number(row.attempts) === 1 &&
              metric?.status === "ok" &&
              row.started_at != null &&
              row.finished_at != null &&
              Number(metric.ts) >= Number(row.started_at) &&
              Number(metric.ts) <= Number(row.finished_at);
            status = completed ? "done" : "unknown_done";
          } else if (!result?.status) status = "unknown_done";
          else if (result.status === "pending_approval") status = "awaiting_approval";
          else if (result.status === "queued") status = "handed_off";
          else if (["refused", "react"].includes(result.status)) status = "other_done";
          else if (result.status !== "ok") status = "unknown_done";
        }
        if (origin === "invalid") status = "invalid_source";
        else if (row.result && !result) status = "invalid_result";
        await client.query(
          `INSERT INTO adoption_run_facts (org,run_id,principal,origin,created_at,status,succeeded,checked_at,projection_version)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,2)
          ON CONFLICT(org,run_id) DO UPDATE SET status=EXCLUDED.status,succeeded=EXCLUDED.succeeded,
          checked_at=EXCLUDED.checked_at,projection_version=2`,
          [org, row.id, principal, origin, row.created_at, status, status === "done", now],
        );
      }
      await client.query(
        `INSERT INTO adoption_sync_state VALUES($1,$2) ON CONFLICT(org) DO UPDATE SET checked_at=EXCLUDED.checked_at`,
        [org, now],
      );
      return { processed: rows.length, refreshed: pending.rows.length };
    });
  }
  async function report(selectedWindow: AdoptionWindow) {
    await ready();
    const keys = await identityKeys();
    return withPgTransaction(await db.pool(), async (client) => {
      await client.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY");
      const window = { ...selectedWindow, to: Math.min(selectedWindow.to, Date.now()) };
      const { rows: rosters } = await client.query(
        "SELECT * FROM adoption_roster_versions WHERE org=$1 ORDER BY revision DESC LIMIT 1",
        [org],
      );
      const latest = rosters[0];
      const members = canonicalMembers((latest?.members ?? []) as AdoptionMember[], keys);
      const rosterIds = new Set(members.map((m) => m.principalId));
      for (const id of rosterIds) if (!keys.has(id)) keys.set(id, id);
      const rosterAliases = [...keys].filter(([, canonical]) => rosterIds.has(canonical));
      const projection = `WITH projected AS (SELECT f.*, COALESCE(a.canonical,f.principal) AS actor
        FROM adoption_run_facts f LEFT JOIN unnest($4::text[],$5::text[]) a(alias,canonical) ON a.alias=f.principal
        WHERE f.org=$1 AND f.origin='human' AND f.created_at >= $2 AND f.created_at < $3)`;
      await client.query("SET LOCAL statement_timeout = '5s'");
      const { rows: facts } = await client.query(
        `${projection} SELECT actor AS principal, COUNT(*)::int AS requests,
        COUNT(DISTINCT ((created_at + 28800000) / 86400000))::int AS active_days,
        COUNT(DISTINCT ((created_at + 28800000) / 86400000)) FILTER(WHERE created_at >= $3::bigint-604800000)::int AS recent_days,
        MAX(created_at) AS last_at,
        COUNT(*) FILTER(WHERE succeeded)::int AS succeeded,
        COUNT(*) FILTER(WHERE status IN ('done','failed','stopped','other_done','unknown_done','invalid_result'))::int AS terminal,
        COUNT(*) FILTER(WHERE status='failed')::int AS failed,
        COUNT(*) FILTER(WHERE status='stopped')::int AS stopped,
        COUNT(*) FILTER(WHERE status='awaiting_approval')::int AS paused,
        COUNT(*) FILTER(WHERE status='handed_off')::int AS handed_off,
        COUNT(*) FILTER(WHERE status='other_done')::int AS other_terminal,
        COUNT(*) FILTER(WHERE status IN ('unknown_done','invalid_result'))::int AS unknown_terminal,
        COUNT(*) FILTER(WHERE status IN ('pending','running'))::int AS pending,
        COUNT(*) FILTER(WHERE status='source_missing')::int AS source_missing
        FROM projected GROUP BY actor`,
        [org, window.from, window.to, [...keys.keys()], [...keys.values()]],
      );
      const { rows: firsts } = await client.query(
        `SELECT m.canonical AS principal, MIN(f.created_at) AS created_at FROM unnest($2::text[],$4::text[]) AS m(alias,canonical)
        LEFT JOIN LATERAL (SELECT created_at FROM adoption_run_facts
        WHERE org=$1 AND principal=m.alias AND origin='human' AND created_at < $3
        ORDER BY created_at LIMIT 1) f ON true GROUP BY m.canonical`,
        [org, rosterAliases.map(([alias]) => alias), window.to, rosterAliases.map(([, canonical]) => canonical)],
      );
      const firstByActor = new Map(
        firsts.map((r) => [String(r.principal), r.created_at == null ? null : Number(r.created_at)]),
      );
      const byActor = new Map(facts.filter((r) => r.principal !== null).map((r) => [String(r.principal), r]));
      const search = (window.search ?? "").trim().toLocaleLowerCase();
      const filtered = members.filter(
        (m) =>
          !m.isTest &&
          (!window.department || (m.department ?? "No dept") === window.department) &&
          (!search || `${m.principalId} ${m.displayName}`.toLocaleLowerCase().includes(search)),
      );
      const tokenUsage = await readTokenUsage(client, org, window.from, window.to, keys);
      const detail = filtered
        .map((m) => {
          const f = byActor.get(m.principalId);
          let eligible: boolean | null = null;
          if (m.eligibleFrom !== null) eligible = m.eligibleFrom < window.to;
          if (m.eligibleTo !== null && m.eligibleTo < window.to) eligible = false;
          return {
            ...m,
            tokens: tokenUsage.byActor.get(m.principalId) ?? emptyTokenUsage(),
            eligible,
            requests: Number(f?.requests ?? 0),
            activeDays: Number(f?.active_days ?? 0),
            firstObservedAt: firstByActor.get(m.principalId) ?? null,
            steadyObserved:
              eligible === true &&
              m.eligibleFrom !== null &&
              m.eligibleFrom <= window.to - 7 * 86400000 &&
              window.from <= window.to - 7 * 86400000 &&
              Number(f?.recent_days ?? 0) >= 3,
            sourceMissing: Number(f?.source_missing ?? 0),
            lastActiveAt: f?.last_at ? Number(f.last_at) : null,
            succeeded: Number(f?.succeeded ?? 0),
            terminal: Number(f?.terminal ?? 0),
            failed: Number(f?.failed ?? 0),
            stopped: Number(f?.stopped ?? 0),
            paused: Number(f?.paused ?? 0),
            handedOff: Number(f?.handed_off ?? 0),
            otherTerminal: Number(f?.other_terminal ?? 0),
            unknownTerminal: Number(f?.unknown_terminal ?? 0),
            pending: Number(f?.pending ?? 0),
          };
        })
        .sort(
          (a, b) => a.displayName.localeCompare(b.displayName, "zh-CN") || a.principalId.localeCompare(b.principalId),
        );
      const sum = (
        key:
          | "requests"
          | "succeeded"
          | "terminal"
          | "pending"
          | "sourceMissing"
          | "failed"
          | "stopped"
          | "paused"
          | "handedOff"
          | "otherTerminal"
          | "unknownTerminal",
      ) => detail.reduce((n, m) => n + m[key], 0);
      const eligiblePeople = detail.filter((m) => m.eligible).length;
      const unknownEligibility = detail.filter((m) => m.eligible === null).length;
      const activeEligible = detail.filter((m) => m.eligible && m.requests > 0).length;
      const { rows: states } = await client.query("SELECT checked_at FROM adoption_sync_state WHERE org=$1", [org]);
      const { rows: missing } = await client.query(
        `SELECT EXISTS(SELECT 1 FROM runs r WHERE NOT EXISTS
        (SELECT 1 FROM adoption_run_facts f WHERE f.org=$1 AND f.run_id=r.id AND f.projection_version>=2)) AS missing`,
        [org],
      );
      const { rows: stale } = await client.query(
        "SELECT MIN(checked_at) AS oldest FROM adoption_run_facts WHERE org=$1 AND status IN ('pending','running')",
        [org],
      );
      const { rows: malformed } = await client.query(
        "SELECT COUNT(*)::int AS total FROM adoption_run_facts WHERE org=$1 AND created_at >= $2 AND created_at < $3 AND status IN ('invalid_source','invalid_result')",
        [org, window.from, window.to],
      );
      const rosterKeys = new Set(members.map((m) => m.principalId));
      const unknownActors = facts.filter(
        (f) => f.principal !== null && !rosterKeys.has(String(f.principal)) && Number(f.requests) > 0,
      );
      const filteredKeys = new Set(filtered.map((m) => m.principalId));
      const { rows: days } = await client.query(
        `${projection} SELECT ((created_at + 28800000) / 86400000)::text AS day,
         COUNT(*)::int AS requests, COUNT(DISTINCT actor)::int AS active_people
         FROM projected WHERE actor=ANY($6::text[]) GROUP BY day ORDER BY day`,
        [org, window.from, window.to, [...keys.keys()], [...keys.values()], [...filteredKeys]],
      );
      const daily = new Map(days.map((r) => [Number(r.day), r]));
      const trend = [];
      for (let at = window.from; at < selectedWindow.to; at += 86400000) {
        const d = daily.get(Math.floor((at + 28800000) / 86400000));
        trend.push({ at, requests: Number(d?.requests ?? 0), activePeople: Number(d?.active_people ?? 0) });
      }
      const firstObservedInWindow = (m: { firstObservedAt: number | null }) =>
        m.firstObservedAt !== null && m.firstObservedAt >= window.from;
      const openedInWindow = (m: AdoptionMember) =>
        m.eligibleFrom !== null && m.eligibleFrom >= window.from && m.eligibleFrom < window.to;
      const departmentMetrics = [...new Set(detail.map((m) => m.department ?? "No dept"))].sort().map((department) => {
        const group = detail.filter((m) => (m.department ?? "No dept") === department);
        return {
          department,
          tokens: sumTokenUsage(group.map((m) => m.tokens)),
          registeredPeople: group.length,
          eligiblePeople: group.filter((m) => m.eligible === true).length,
          activePeople: group.filter((m) => m.eligible === true && m.requests > 0).length,
          otherActivePeople: group.filter((m) => m.eligible !== true && m.requests > 0).length,
          requests: group.reduce((n, m) => n + m.requests, 0),
          openedPeople: group.filter(openedInWindow).length,
          activePersonDays: group.reduce((n, m) => n + m.activeDays, 0),
          firstObservedPeople: group.filter(firstObservedInWindow).length,
          steadyObservedPeople:
            window.to - window.from < 7 * 86400000 ? null : group.filter((m) => m.steadyObserved).length,
          coverage: null as number | null,
        };
      });
      const departments = [...new Set(members.filter((m) => !m.isTest).map((m) => m.department ?? "No dept"))].sort();
      const scenarios = await readAdoptionScenarios(client, org, window, selectedWindow.to, filtered, keys, members);
      return {
        window: selectedWindow,
        asOf: window.to,
        partialDay: window.to < selectedWindow.to,
        timezone: "Asia/Shanghai",
        metricVersion: "adoption-observed-v2",
        countBasis: "observed-lower-bound",
        dataThrough: null as number | null,
        coverageStart: null as number | null,
        coverageStatus: "unknown-retention",
        eligibilityAt: window.to - 1,
        rosterRevision: Number(latest?.revision ?? 0),
        rosterRecordedAt: latest ? Number(latest.recorded_at) : null,
        rosterSource: latest?.source ?? null,
        departmentBasis: "current-roster",
        departments,
        departmentMetrics,
        trend,
        members: detail,
        scenarios,
        summary: {
          tokens: sumTokenUsage(detail.map((m) => m.tokens)),
          registeredPeople: detail.length,
          eligiblePeople,
          activePeople: activeEligible,
          otherActivePeople: detail.filter((m) => m.eligible !== true && m.requests > 0).length,
          firstObservedPeople: detail.filter(firstObservedInWindow).length,
          openedPeople: detail.filter(openedInWindow).length,
          activePersonDays: detail.reduce((n, m) => n + m.activeDays, 0),
          steadyObservedPeople:
            window.to - window.from < 7 * 86400000 ? null : detail.filter((m) => m.steadyObserved).length,
          requests: sum("requests"),
          succeeded: sum("succeeded"),
          terminal: sum("terminal"),
          failed: sum("failed"),
          stopped: sum("stopped"),
          paused: sum("paused"),
          handedOff: sum("handedOff"),
          otherTerminal: sum("otherTerminal"),
          unknownTerminal: sum("unknownTerminal"),
          pending: sum("pending"),
          coverage: null as number | null,
          observedEligibleRatio:
            unknownEligibility || !eligiblePeople || missing[0]?.missing ? null : activeEligible / eligiblePeople,
          failureRate: sum("succeeded") + sum("failed") > 0 ? sum("failed") / (sum("succeeded") + sum("failed")) : null,
          confirmedOutcomes: null,
        },
        tokenQuality: {
          available: tokenUsage.available,
          metricVersion: "token-observed-v1",
          basis: "retained-model-calls-by-call-time",
          attribution: "unique-run-per-session-turn-current-roster",
          unattributed: tokenUsage.unattributed,
          nonHuman: tokenUsage.nonHuman,
          unregistered: sumTokenUsage(
            [...tokenUsage.byActor].filter(([id]) => !rosterIds.has(id)).map(([, usage]) => usage),
          ),
          excludedTest: sumTokenUsage(
            members.filter((m) => m.isTest).map((m) => tokenUsage.byActor.get(m.principalId) ?? emptyTokenUsage()),
          ),
          historyComplete: false,
        },
        quality: {
          historyComplete: false,
          coverageGaps: [
            {
              from: window.from,
              to: window.to,
              status: "unverified",
              reason: "retained history may omit prior deletions",
            },
          ],
          reconstructionStatus: missing[0]?.missing ? "backfilling" : "retained-records-caught-up",
          recomputeStatus: "computed-from-current-roster-and-projection",
          malformedRecords: Number(malformed[0]?.total ?? 0),
          unattributedRequests: Number(facts.find((f) => f.principal === null)?.requests ?? 0),
          projectionPending: Boolean(missing[0]?.missing),
          source: "retained-runs",
          unknownEligibility,
          unassignedDepartments: filtered.filter((m) => !m.department).length,
          unregisteredActors: unknownActors.length,
          unregisteredRequests: unknownActors.reduce((n, f) => n + Number(f.requests), 0),
          excludedTestMembers: members.filter((m) => m.isTest).length,
          sourceMissingRequests: sum("sourceMissing"),
          checkedAt: states[0] ? Number(states[0].checked_at) : null,
          oldestPendingCheck: stale[0]?.oldest ? Number(stale[0].oldest) : null,
        },
        generatedAt: Date.now(),
      };
    });
  }
  return {
    prepare,
    whenAvailable,
    roster,
    saveRoster,
    sync,
    report,
    ...scenarioWorker,
    async close() {
      try {
        await scenarioWorker.stopScenarios();
      } finally {
        await db.close();
      }
    },
  };
}
export type AdoptionStore = ReturnType<typeof createAdoptionStore>;
