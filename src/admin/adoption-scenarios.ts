import { randomUUID } from "node:crypto";
import type { PgPool, PoolClient } from "../persistence/pg-pool.ts";
import { withPgTransaction } from "../persistence/pg-pool.ts";
import { personKey } from "../directory/person.ts";
import { resolveTurnOrigin } from "../core/turn-origin.ts";
import type { OrchestratorInput } from "../core/orchestrator.ts";
import {
  ADOPTION_SCENARIO_CATEGORIES,
  ADOPTION_SCENARIO_CLASSIFIER,
  ADOPTION_SCENARIO_STATUS_LABELS,
  ADOPTION_SCENARIO_SYSTEM,
  ADOPTION_SCENARIO_TAXONOMY,
  adoptionScenarioNeedsContext,
  classifyAdoptionScenario,
  prepareAdoptionScenario,
  type AdoptionScenarioLabel,
  type AdoptionScenarioOptions,
  type AdoptionScenarioStatus,
} from "./adoption-scenario-classifier.ts";

const DAY = 86400000;
const OFFSET = 28800000;
const DAILY_CALL_LIMIT = 1000;
const MODEL_TIMEOUT = 30000;
const MAX_ATTEMPTS = 3;

export const ADOPTION_SCENARIO_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS adoption_scenario_jobs (
    org TEXT NOT NULL, run_id TEXT NOT NULL, taxonomy_version TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','running','done')),
    attempts INT NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 3),
    available_at BIGINT NOT NULL, lease_token TEXT, lease_until BIGINT,
    created_at BIGINT NOT NULL, updated_at BIGINT NOT NULL,
    PRIMARY KEY(org,run_id,taxonomy_version))`,
  `CREATE INDEX IF NOT EXISTS adoption_scenario_jobs_claim
    ON adoption_scenario_jobs(org,taxonomy_version,state,available_at,created_at)`,
  `CREATE TABLE IF NOT EXISTS adoption_scenario_labels (
    org TEXT NOT NULL, run_id TEXT NOT NULL, taxonomy_version TEXT NOT NULL,
    classifier_version TEXT NOT NULL,
    category TEXT CHECK(category IN ('research','writing','business','data','presentation','media','engineering','coordination')),
    status TEXT NOT NULL,
    source TEXT NOT NULL CHECK(source IN ('rule','model','none','manual')),
    processed_at BIGINT NOT NULL,
    CHECK((status='classified')=(category IS NOT NULL)),
    PRIMARY KEY(org,run_id,taxonomy_version))`,
  `CREATE TABLE IF NOT EXISTS adoption_scenario_budget (
    org TEXT NOT NULL, day BIGINT NOT NULL, model_calls INT NOT NULL,
    call_limit INT NOT NULL DEFAULT 1000 CHECK(call_limit BETWEEN 1000 AND 1500),
    CONSTRAINT adoption_scenario_budget_calls_within_limit_check CHECK(model_calls BETWEEN 0 AND call_limit),
    input_chars BIGINT NOT NULL DEFAULT 0 CHECK(input_chars>=0), PRIMARY KEY(org,day))`,
  `ALTER TABLE adoption_scenario_budget ADD COLUMN IF NOT EXISTS call_limit INT NOT NULL DEFAULT 1000`,
  `DO $migration$ BEGIN
    IF EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='adoption_scenario_budget'::regclass
      AND conname='adoption_scenario_budget_model_calls_check') THEN
      IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='adoption_scenario_budget'::regclass
        AND conname='adoption_scenario_budget_model_calls_check'
        AND pg_get_constraintdef(oid)='CHECK (((model_calls >= 0) AND (model_calls <= 1000)))') THEN
        RAISE EXCEPTION 'unexpected adoption scenario budget constraint';
      END IF;
      ALTER TABLE adoption_scenario_budget DROP CONSTRAINT adoption_scenario_budget_model_calls_check;
    END IF;
    IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='adoption_scenario_budget'::regclass
      AND conname='adoption_scenario_budget_call_limit_check') THEN
      ALTER TABLE adoption_scenario_budget ADD CONSTRAINT adoption_scenario_budget_call_limit_check
        CHECK(call_limit BETWEEN 1000 AND 1500);
    END IF;
    IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='adoption_scenario_budget'::regclass
      AND conname='adoption_scenario_budget_calls_within_limit_check') THEN
      ALTER TABLE adoption_scenario_budget ADD CONSTRAINT adoption_scenario_budget_calls_within_limit_check
        CHECK(model_calls BETWEEN 0 AND call_limit);
    END IF;
  END $migration$`,
  `CREATE TABLE IF NOT EXISTS adoption_scenario_control (
    org TEXT PRIMARY KEY, lease_token TEXT NOT NULL, lease_until BIGINT NOT NULL, next_at BIGINT NOT NULL,
    dispatch_slot INT NOT NULL DEFAULT 0 CHECK(dispatch_slot BETWEEN 0 AND 3))`,
  `ALTER TABLE adoption_scenario_control ADD COLUMN IF NOT EXISTS dispatch_slot INT NOT NULL DEFAULT 0
    CHECK(dispatch_slot BETWEEN 0 AND 3)`,
];

export const ADOPTION_SCENARIO_TAXONOMY_RENAME = ["adoption_scenario_labels", "adoption_scenario_jobs"].flatMap(
  (table) => [
    `UPDATE ${table} renamed SET taxonomy_version='scenes-v1'
      WHERE renamed.taxonomy_version LIKE '%-scenes-v1'
      AND NOT EXISTS(SELECT 1 FROM ${table} kept WHERE kept.org=renamed.org AND kept.run_id=renamed.run_id
        AND kept.taxonomy_version='scenes-v1')`,
    `DELETE FROM ${table} WHERE taxonomy_version LIKE '%-scenes-v1'`,
  ],
);

interface Membership {
  keys: Map<string, string>;
  members: { principalId: string; isTest: boolean }[];
}

function requestObject(raw: unknown): Partial<OrchestratorInput> | null {
  try {
    const value: unknown = JSON.parse(String(raw));
    return value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value as Partial<OrchestratorInput>)
      : null;
  } catch {
    return null;
  }
}

function isHuman(request: Partial<OrchestratorInput> | null): boolean {
  return request !== null && request.proactiveOpener !== true && resolveTurnOrigin(request).kind === "human";
}

function requestText(request: Partial<OrchestratorInput>): string {
  if (typeof request.displayText === "string") return request.displayText;
  if (typeof request.text === "string") return request.text;
  return "";
}

function memberAliases(membership: Membership) {
  const members = new Set(membership.members.filter((m) => !m.isTest).map((m) => m.principalId));
  const keys = new Map(membership.keys);
  for (const id of members) if (!keys.has(id)) keys.set(id, id);
  return { members, keys, aliases: [...keys].filter(([, canonical]) => members.has(canonical)) };
}

export function createAdoptionScenarios(
  db: PgPool,
  org: string,
  ready: () => Promise<void>,
  membership: () => Promise<Membership>,
  options: AdoptionScenarioOptions = {},
) {
  let stopped = false;
  let active: Promise<unknown> | null = null;
  let controller: AbortController | null = null;
  const paused = () => stopped || options.enabled === false;

  async function transaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    return withPgTransaction(await db.pool(), async (client) => {
      await client.query("SET LOCAL statement_timeout = '10s'");
      return fn(client);
    });
  }

  async function query(text: string, params: unknown[] = []) {
    return (await transaction((client) => client.query(text, params))).rows as Record<string, unknown>[];
  }

  async function release(job: Record<string, unknown>) {
    await query(
      `UPDATE adoption_scenario_jobs SET state='pending',lease_token=NULL,lease_until=NULL,
      attempts=GREATEST(0,attempts-1),available_at=$5,updated_at=$5
      WHERE org=$1 AND run_id=$2 AND taxonomy_version=$3 AND lease_token=$4 AND state='running'`,
      [org, job.run_id, ADOPTION_SCENARIO_TAXONOMY, job.lease_token, Date.now()],
    );
  }

  async function finish(
    job: Record<string, unknown>,
    label: AdoptionScenarioLabel,
    nextAt?: number,
    preserveAttempt = false,
  ) {
    await transaction(async (client) => {
      const current = await client.query(
        `SELECT lease_token,lease_until FROM adoption_scenario_jobs
        WHERE org=$1 AND run_id=$2 AND taxonomy_version=$3 FOR UPDATE`,
        [org, job.run_id, ADOPTION_SCENARIO_TAXONOMY],
      );
      const now = Date.now();
      if (current.rows[0]?.lease_token !== job.lease_token || Number(current.rows[0]?.lease_until) <= now) return;
      const owned = await client.query(
        `UPDATE adoption_scenario_jobs SET state=$5,lease_token=NULL,lease_until=NULL,updated_at=$6,
        available_at=$7,attempts=CASE WHEN $8 THEN GREATEST(0,attempts-1) ELSE attempts END
        WHERE org=$1 AND run_id=$2 AND taxonomy_version=$3 AND lease_token=$4 AND lease_until>$6
        RETURNING run_id`,
        [
          org,
          job.run_id,
          ADOPTION_SCENARIO_TAXONOMY,
          job.lease_token,
          nextAt === undefined ? "done" : "pending",
          now,
          nextAt ?? now,
          preserveAttempt,
        ],
      );
      if (!owned.rowCount) return;
      await client.query(
        `INSERT INTO adoption_scenario_labels(org,run_id,taxonomy_version,classifier_version,category,status,source,processed_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8)
        ON CONFLICT(org,run_id,taxonomy_version) DO UPDATE SET classifier_version=EXCLUDED.classifier_version,
        category=EXCLUDED.category,status=EXCLUDED.status,source=EXCLUDED.source,processed_at=EXCLUDED.processed_at
        WHERE adoption_scenario_labels.source<>'manual'`,
        [
          org,
          job.run_id,
          ADOPTION_SCENARIO_TAXONOMY,
          ADOPTION_SCENARIO_CLASSIFIER,
          label.category,
          label.status,
          label.source,
          now,
        ],
      );
    });
  }

  async function processOne() {
    if (paused()) return { processed: 0 };
    await ready();
    const binding = await query("SELECT org FROM adoption_source_binding WHERE singleton=true");
    if (binding[0]?.org !== org) throw new Error("adoption scenario source organization mismatch");
    const now = Date.now();
    const controlToken = randomUUID();
    const control = await query(
      `INSERT INTO adoption_scenario_control(org,lease_token,lease_until,next_at) VALUES($1,$2,$3,0)
      ON CONFLICT(org) DO UPDATE SET lease_token=EXCLUDED.lease_token,lease_until=EXCLUDED.lease_until
      WHERE adoption_scenario_control.lease_until<$4 AND adoption_scenario_control.next_at<=$4 RETURNING org`,
      [org, controlToken, now + 60000, now],
    );
    if (!control.length) return { processed: 0 };
    try {
      const day = Math.floor((now + OFFSET) / DAY);
      const budget = await query(
        "SELECT model_calls,call_limit FROM adoption_scenario_budget WHERE org=$1 AND day=$2",
        [org, day],
      );
      if (Number(budget[0]?.model_calls ?? 0) >= Number(budget[0]?.call_limit ?? DAILY_CALL_LIMIT)) {
        await query("UPDATE adoption_scenario_control SET next_at=$3 WHERE org=$1 AND lease_token=$2", [
          org,
          controlToken,
          (day + 1) * DAY - OFFSET,
        ]);
        return { processed: 0 };
      }
      const selected = memberAliases(await membership());
      if (!selected.aliases.length) return { processed: 0 };
      await query(
        `INSERT INTO adoption_scenario_jobs(org,run_id,taxonomy_version,available_at,created_at,updated_at)
        SELECT f.org,f.run_id,$3,$4,f.created_at,$4 FROM adoption_run_facts f
        WHERE f.org=$1 AND f.origin='human' AND f.principal=ANY($2::text[]) AND f.created_at>=$5
        AND NOT EXISTS(SELECT 1 FROM adoption_scenario_jobs j WHERE j.org=f.org AND j.run_id=f.run_id AND j.taxonomy_version=$3)
        ORDER BY f.created_at DESC,f.run_id DESC LIMIT 500 ON CONFLICT DO NOTHING`,
        [org, selected.aliases.map(([alias]) => alias), ADOPTION_SCENARIO_TAXONOMY, now, now - 28 * DAY],
      );
      await query(
        `WITH exhausted AS (UPDATE adoption_scenario_jobs SET state='done',lease_token=NULL,lease_until=NULL,updated_at=$3
        WHERE org=$1 AND taxonomy_version=$2 AND state='running' AND lease_until<$3 AND attempts>=3 RETURNING run_id)
        INSERT INTO adoption_scenario_labels(org,run_id,taxonomy_version,classifier_version,category,status,source,processed_at)
        SELECT $1,run_id,$2,$4,NULL,'processing_exhausted','none',$3 FROM exhausted ON CONFLICT DO NOTHING`,
        [org, ADOPTION_SCENARIO_TAXONOMY, now, ADOPTION_SCENARIO_CLASSIFIER],
      );
      const claimed = await transaction(async (client) => {
        const control = await client.query(
          "SELECT lease_token,lease_until,dispatch_slot FROM adoption_scenario_control WHERE org=$1 FOR UPDATE",
          [org],
        );
        const claimedAt = Date.now();
        if (
          paused() ||
          control.rows[0]?.lease_token !== controlToken ||
          Number(control.rows[0]?.lease_until) <= claimedAt
        )
          return undefined;
        const budget = await client.query(
          "SELECT model_calls,call_limit FROM adoption_scenario_budget WHERE org=$1 AND day=$2 FOR UPDATE",
          [org, Math.floor((claimedAt + OFFSET) / DAY)],
        );
        if (Number(budget.rows[0]?.model_calls ?? 0) >= Number(budget.rows[0]?.call_limit ?? DAILY_CALL_LIMIT)) {
          await client.query("UPDATE adoption_scenario_control SET next_at=$3 WHERE org=$1 AND lease_token=$2", [
            org,
            controlToken,
            (Math.floor((claimedAt + OFFSET) / DAY) + 1) * DAY - OFFSET,
          ]);
          return undefined;
        }
        const extraOnly = Number(budget.rows[0]?.model_calls ?? 0) >= DAILY_CALL_LIMIT;
        const recentSlot = Number(control.rows[0].dispatch_slot) !== 3;
        const result = await client.query(
          `WITH selected AS (SELECT run_id FROM adoption_scenario_jobs
          WHERE org=$1 AND taxonomy_version=$2 AND attempts<3 AND available_at<=$3
          AND created_at>=$6 AND (NOT $8::boolean OR created_at>=$7)
          AND (state='pending' OR (state='running' AND lease_until<$3))
          ORDER BY CASE WHEN (created_at>=$7)=$9 THEN 0 ELSE 1 END,
          CASE WHEN created_at>=$7 AND attempts=0 THEN 0 ELSE 1 END,
          CASE WHEN created_at>=$7 THEN -created_at ELSE created_at END,run_id
          FOR UPDATE SKIP LOCKED LIMIT 1)
          UPDATE adoption_scenario_jobs j SET state='running',attempts=j.attempts+1,lease_token=$4,lease_until=$5,updated_at=$3
          FROM selected s WHERE j.org=$1 AND j.taxonomy_version=$2 AND j.run_id=s.run_id RETURNING j.*`,
          [
            org,
            ADOPTION_SCENARIO_TAXONOMY,
            claimedAt,
            randomUUID(),
            claimedAt + 55000,
            claimedAt - 28 * DAY,
            Math.floor((claimedAt + OFFSET) / DAY) * DAY - OFFSET - 6 * DAY,
            extraOnly,
            recentSlot,
          ],
        );
        if (result.rowCount)
          await client.query(
            "UPDATE adoption_scenario_control SET lease_until=$3,dispatch_slot=(dispatch_slot+1)%4 WHERE org=$1 AND lease_token=$2",
            [org, controlToken, claimedAt + 60000],
          );
        return result.rows[0] as Record<string, unknown> | undefined;
      });
      if (!claimed) return { processed: 0 };
      const rows = await query(
        `SELECT r.id,r.session_id,r.created_at,r.seq,r.request,f.principal FROM runs r
        JOIN adoption_run_facts f ON f.org=$1 AND f.run_id=r.id WHERE r.id=$2 AND f.origin='human'`,
        [org, claimed.run_id],
      );
      const row = rows[0];
      if (!row) {
        await finish(claimed, { category: null, status: "source_missing", source: "none" });
        return { processed: 1 };
      }
      const request = requestObject(row.request);
      if (!request || !isHuman(request) || request.actor?.type !== "internal" || typeof request.actor.id !== "string") {
        await finish(claimed, { category: null, status: "invalid_source", source: "none" });
        return { processed: 1 };
      }
      const actor = personKey(request.actor.id);
      const canonical = selected.keys.get(actor) ?? actor;
      const factActor = personKey(String(row.principal ?? ""));
      if (!selected.members.has(canonical) || (selected.keys.get(factActor) ?? factActor) !== canonical) {
        await finish(claimed, { category: null, status: "excluded", source: "none" });
        return { processed: 1 };
      }
      const text = requestText(request);
      const aliases = selected.aliases.filter(([, key]) => key === canonical).map(([alias]) => alias);
      const prior = adoptionScenarioNeedsContext(text)
        ? await query(
            `SELECT r.request FROM runs r JOIN adoption_run_facts f ON f.run_id=r.id AND f.org=$1
        WHERE r.session_id=$2 AND f.origin='human' AND f.principal=ANY($3::text[])
        AND (r.created_at<$4 OR (r.created_at=$4 AND r.seq<$5))
        ORDER BY r.created_at DESC,r.seq DESC LIMIT 2`,
            [org, row.session_id, aliases, row.created_at, row.seq],
          )
        : [];
      const previous = prior
        .flatMap((p) => {
          const input = requestObject(p.request);
          if (!input || !isHuman(input) || input.actor?.type !== "internal" || typeof input.actor.id !== "string")
            return [];
          const id = personKey(input.actor.id);
          return (selected.keys.get(id) ?? id) === canonical ? [requestText(input)] : [];
        })
        .reverse();
      const prepared = prepareAdoptionScenario(text, previous);
      if (prepared.label) {
        await finish(claimed, prepared.label);
        return { processed: 1 };
      }
      if (paused()) {
        await finish(claimed, { category: null, status: "worker_paused", source: "none" }, Date.now() + 60000, true);
        return { processed: 1 };
      }
      let model;
      try {
        let providerTimer: ReturnType<typeof setTimeout> | undefined;
        try {
          model = await Promise.race([
            options.resolveModel?.(),
            new Promise<null>((resolve) => {
              providerTimer = setTimeout(() => resolve(null), 5000);
            }),
          ]);
        } finally {
          clearTimeout(providerTimer);
        }
      } catch {
        model = null;
      }
      if (!model) {
        await finish(
          claimed,
          { category: null, status: "model_unavailable", source: "none" },
          Date.now() + 3600000,
          true,
        );
        return { processed: 1 };
      }
      if (paused()) {
        await finish(claimed, { category: null, status: "worker_paused", source: "none" }, Date.now() + 60000, true);
        return { processed: 1 };
      }
      const prompt = prepared.prompt!;
      let reservation;
      try {
        reservation = await transaction(async (client) => {
          const control = await client.query(
            "SELECT lease_token,lease_until FROM adoption_scenario_control WHERE org=$1 FOR UPDATE",
            [org],
          );
          const job = await client.query(
            `SELECT lease_token,lease_until,state FROM adoption_scenario_jobs
            WHERE org=$1 AND run_id=$2 AND taxonomy_version=$3 FOR UPDATE`,
            [org, claimed.run_id, ADOPTION_SCENARIO_TAXONOMY],
          );
          const reservedAt = Date.now();
          const day = Math.floor((reservedAt + OFFSET) / DAY);
          if (
            paused() ||
            control.rows[0]?.lease_token !== controlToken ||
            Number(control.rows[0]?.lease_until) <= reservedAt ||
            job.rows[0]?.lease_token !== claimed.lease_token ||
            job.rows[0]?.state !== "running" ||
            Number(job.rows[0]?.lease_until) <= reservedAt
          )
            return { authorized: false, budget: false, leaseUntil: 0, day };
          const leaseUntil = reservedAt + 55000;
          await client.query("UPDATE adoption_scenario_control SET lease_until=$3 WHERE org=$1 AND lease_token=$2", [
            org,
            controlToken,
            reservedAt + 60000,
          ]);
          await client.query(
            `UPDATE adoption_scenario_jobs SET lease_until=$5,updated_at=$6
            WHERE org=$1 AND run_id=$2 AND taxonomy_version=$3 AND lease_token=$4`,
            [org, claimed.run_id, ADOPTION_SCENARIO_TAXONOMY, claimed.lease_token, leaseUntil, reservedAt],
          );
          const budget = await client.query(
            `INSERT INTO adoption_scenario_budget(org,day,model_calls,input_chars) VALUES($1,$2,1,$3)
        ON CONFLICT(org,day) DO UPDATE SET model_calls=adoption_scenario_budget.model_calls+1,
        input_chars=adoption_scenario_budget.input_chars+EXCLUDED.input_chars
        WHERE adoption_scenario_budget.model_calls<adoption_scenario_budget.call_limit
        AND (adoption_scenario_budget.model_calls<1000 OR $4::bigint>=$5)
        RETURNING model_calls,call_limit`,
            [
              org,
              day,
              ADOPTION_SCENARIO_SYSTEM.length + prompt.length,
              Number(claimed.created_at),
              day * DAY - OFFSET - 6 * DAY,
            ],
          );
          if (!budget.rowCount || Number(budget.rows[0].model_calls) >= Number(budget.rows[0].call_limit))
            await client.query("UPDATE adoption_scenario_control SET next_at=$3 WHERE org=$1 AND lease_token=$2", [
              org,
              controlToken,
              (day + 1) * DAY - OFFSET,
            ]);
          return { authorized: true, budget: Boolean(budget.rowCount), leaseUntil, day };
        });
      } catch (error) {
        await release(claimed);
        throw error;
      }
      if (!reservation.authorized) {
        await release(claimed);
        return { processed: 0 };
      }
      if (!reservation.budget) {
        await finish(
          claimed,
          { category: null, status: "budget_exhausted", source: "none" },
          (reservation.day + 1) * DAY - OFFSET,
          true,
        );
        return { processed: 1 };
      }
      if (reservation.leaseUntil - Date.now() <= MODEL_TIMEOUT) {
        await release(claimed);
        return { processed: 0 };
      }
      if (paused()) {
        await finish(claimed, { category: null, status: "worker_paused", source: "none" }, Date.now() + 60000, true);
        return { processed: 1 };
      }
      controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const expired = new Promise<AdoptionScenarioLabel>((resolve) => {
        timer = setTimeout(() => {
          controller?.abort();
          resolve({ category: null, status: "model_timeout", source: "none" });
        }, MODEL_TIMEOUT);
      });
      let label: AdoptionScenarioLabel;
      try {
        label = await Promise.race([classifyAdoptionScenario(model, prompt, controller.signal), expired]);
      } finally {
        clearTimeout(timer);
        controller = null;
      }
      const retryable = ["model_timeout", "model_error", "invalid_output"].includes(label.status);
      const retryAt =
        retryable && Number(claimed.attempts) < MAX_ATTEMPTS
          ? Date.now() + Number(claimed.attempts) * 60000
          : undefined;
      await finish(claimed, label, retryAt);
      return { processed: 1 };
    } finally {
      await query(
        "UPDATE adoption_scenario_control SET lease_until=0,next_at=GREATEST(next_at,$3) WHERE org=$1 AND lease_token=$2",
        [org, controlToken, Date.now() + 1000],
      );
    }
  }

  function processScenarios() {
    if (active) return active;
    active = processOne().finally(() => {
      active = null;
    });
    return active;
  }

  async function stopScenarios() {
    stopped = true;
    controller?.abort();
    try {
      await active;
    } finally {
      stopped = false;
    }
  }

  return { processScenarios, stopScenarios };
}

export async function readAdoptionScenarios(
  client: PoolClient,
  org: string,
  window: { from: number; to: number },
  selectedTo: number,
  members: { principalId: string; department: string | null }[],
  keys: Map<string, string>,
  allMembers: { principalId: string; isTest: boolean }[],
) {
  const base = `WITH projected AS (
    SELECT f.run_id,f.created_at,COALESCE(a.canonical,f.principal) AS actor FROM adoption_run_facts f
    LEFT JOIN unnest($4::text[],$5::text[]) a(alias,canonical) ON a.alias=f.principal
    WHERE f.org=$1 AND f.origin='human' AND f.created_at>=$2 AND f.created_at<$3
  ), scoped AS (
    SELECT p.created_at,p.actor,m.department,COALESCE(l.category,'unclassified') AS category,
    COALESCE(l.status,'pending') AS status,l.processed_at,j.state AS job_state,j.attempts,j.lease_until>$10 AS lease_active
    FROM projected p
    JOIN unnest($6::text[],$7::text[]) m(actor,department) ON p.actor=m.actor
    LEFT JOIN adoption_scenario_labels l ON l.org=$1 AND l.run_id=p.run_id
    AND l.taxonomy_version=$8 AND l.classifier_version=$9
    LEFT JOIN adoption_scenario_jobs j ON j.org=$1 AND j.run_id=p.run_id AND j.taxonomy_version=$8
  )`;
  const now = Date.now();
  const params = [
    org,
    window.from,
    window.to,
    [...keys.keys()],
    [...keys.values()],
    members.map((m) => m.principalId),
    members.map((m) => m.department ?? "No dept"),
    ADOPTION_SCENARIO_TAXONOMY,
    ADOPTION_SCENARIO_CLASSIFIER,
    now,
  ];
  const summary = (
    await client.query(
      `${base} SELECT COUNT(*)::int AS total,COUNT(*) FILTER(WHERE status='classified')::int AS classified,
    COUNT(*) FILTER(WHERE status<>'classified' AND
      (job_state IN ('pending','running') OR (job_state IS NULL AND processed_at IS NULL)))::int AS pending,
    COUNT(*) FILTER(WHERE status<>'classified' AND job_state='running' AND lease_active)::int AS running,
    COUNT(*) FILTER(WHERE status<>'classified' AND
      ((job_state='pending' AND attempts>0) OR (job_state='running' AND attempts>1)))::int AS retry,
    MAX(created_at) FILTER(WHERE status='classified') AS classified_through,MAX(processed_at) AS processed_at FROM scoped`,
      params,
    )
  ).rows[0];
  const categoryRows = (
    await client.query(
      `${base} SELECT category,COUNT(*)::int AS requests,COUNT(DISTINCT actor)::int AS people FROM scoped GROUP BY category`,
      params,
    )
  ).rows;
  const day = Math.floor((now + OFFSET) / DAY);
  const budgetRow = (
    await client.query("SELECT model_calls,call_limit FROM adoption_scenario_budget WHERE org=$1 AND day=$2", [
      org,
      day,
    ])
  ).rows[0];
  const controlRow = (
    await client.query("SELECT lease_until,next_at FROM adoption_scenario_control WHERE org=$1", [org])
  ).rows[0];
  const workRow = (
    await client.query(
      `SELECT COUNT(*)::int AS pending,
    COUNT(*) FILTER(WHERE state='running' AND lease_until>$4)::int AS running,
    MIN(available_at) FILTER(WHERE state='pending') AS available_at
    FROM adoption_scenario_jobs WHERE org=$1 AND taxonomy_version=$2 AND created_at>=$3
    AND state IN ('pending','running')`,
      [org, ADOPTION_SCENARIO_TAXONOMY, now - 28 * DAY, now],
    )
  ).rows[0];
  const organizationMembers = new Set(
    allMembers.filter((member) => !member.isTest).map((member) => member.principalId),
  );
  const unqueuedRow = (
    await client.query(
      `SELECT EXISTS(SELECT 1 FROM adoption_run_facts f
      WHERE f.org=$1 AND f.origin='human' AND f.created_at>=$3 AND f.created_at<=$4
      AND f.principal=ANY($5::text[])
      AND NOT EXISTS(SELECT 1 FROM adoption_scenario_jobs j
        WHERE j.org=f.org AND j.run_id=f.run_id AND j.taxonomy_version=$2)
      AND NOT EXISTS(SELECT 1 FROM adoption_scenario_labels l
        WHERE l.org=f.org AND l.run_id=f.run_id AND l.taxonomy_version=$2 AND l.classifier_version=$6)) AS pending`,
      [
        org,
        ADOPTION_SCENARIO_TAXONOMY,
        now - 28 * DAY,
        now,
        [...keys].filter(([, canonical]) => organizationMembers.has(canonical)).map(([alias]) => alias),
        ADOPTION_SCENARIO_CLASSIFIER,
      ],
    )
  ).rows[0];
  const departmentRows = (
    await client.query(
      `${base} SELECT department,category,COUNT(*)::int AS requests,COUNT(DISTINCT actor)::int AS people FROM scoped GROUP BY department,category`,
      params,
    )
  ).rows;
  const dayRows = (
    await client.query(
      `${base} SELECT ((created_at+28800000)/86400000)*86400000-28800000 AS at,category,
    COUNT(*)::int AS requests,COUNT(DISTINCT actor)::int AS people FROM scoped GROUP BY at,category ORDER BY at`,
      params,
    )
  ).rows;
  const statusRows = (
    await client.query(
      `${base} SELECT status,COUNT(*)::int AS requests FROM scoped GROUP BY status ORDER BY status`,
      params,
    )
  ).rows;
  const all = [...ADOPTION_SCENARIO_CATEGORIES, { id: "unclassified", label: "Unclassified" }];
  const totalRequests = Number(summary?.total ?? 0);
  const classifiedRequests = Number(summary?.classified ?? 0);
  const pendingRequests = Number(summary?.pending ?? 0);
  const used = Number(budgetRow?.model_calls ?? 0);
  const limit = Number(budgetRow?.call_limit ?? DAILY_CALL_LIMIT);
  const hasWork = Number(workRow?.pending ?? 0) > 0 || unqueuedRow?.pending === true;
  const running = Number(workRow?.running ?? 0) > 0 && Number(controlRow?.lease_until ?? 0) > now;
  let state: "running" | "budget_exhausted" | "waiting" | "idle" = "idle";
  if (running) state = "running";
  else if (hasWork && used >= limit) state = "budget_exhausted";
  else if (hasWork) state = "waiting";
  const future = Math.max(Number(controlRow?.next_at ?? 0), Number(workRow?.available_at ?? 0));
  let nextResumeAt: number | null = null;
  if (state === "budget_exhausted") nextResumeAt = (day + 1) * DAY - OFFSET;
  else if (state === "waiting" && future > now) nextResumeAt = future;
  const categoryMap = new Map(categoryRows.map((r) => [String(r.category), r]));
  const categories = all.map((c) => {
    const row = categoryMap.get(c.id);
    const requests = Number(row?.requests ?? 0);
    return { ...c, requests, people: Number(row?.people ?? 0), share: totalRequests ? requests / totalRequests : null };
  });
  const departmentMap = new Map(departmentRows.map((r) => [JSON.stringify([r.department, r.category]), r]));
  const departments = [...new Set(members.map((m) => m.department ?? "No dept"))].sort().map((department) => ({
    department,
    categories: all.map((c) => {
      const row = departmentMap.get(JSON.stringify([department, c.id]));
      return { id: c.id, requests: Number(row?.requests ?? 0), people: Number(row?.people ?? 0) };
    }),
  }));
  const dayMap = new Map(dayRows.map((r) => [JSON.stringify([Number(r.at), r.category]), r]));
  const trend = [];
  for (let at = Math.floor((window.from + OFFSET) / DAY) * DAY - OFFSET; at < selectedTo; at += DAY)
    trend.push({
      at,
      categories: all.map((c) => {
        const row = dayMap.get(JSON.stringify([at, c.id]));
        return { id: c.id, requests: Number(row?.requests ?? 0), people: Number(row?.people ?? 0) };
      }),
    });
  return {
    taxonomyVersion: ADOPTION_SCENARIO_TAXONOMY,
    classifierVersion: ADOPTION_SCENARIO_CLASSIFIER,
    estimated: true,
    totalRequests,
    classifiedRequests,
    unclassifiedRequests: totalRequests - classifiedRequests,
    coverage: totalRequests ? classifiedRequests / totalRequests : null,
    classifiedThrough: summary?.classified_through == null ? null : Number(summary.classified_through),
    processedAt: summary?.processed_at == null ? null : Number(summary.processed_at),
    processing: {
      state,
      budget: { used, limit, day: new Date(day * DAY).toISOString().slice(0, 10) },
      nextResumeAt,
      pendingRequests,
      runningRequests: Number(summary?.running ?? 0),
      retryRequests: Number(summary?.retry ?? 0),
      unresolvedRequests: totalRequests - classifiedRequests - pendingRequests,
    },
    categories,
    departments,
    trend,
    statuses: statusRows.map((r) => ({
      status: String(r.status),
      label: ADOPTION_SCENARIO_STATUS_LABELS[r.status as AdoptionScenarioStatus] ?? "Unclassified",
      requests: Number(r.requests),
    })),
  };
}
