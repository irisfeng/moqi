import { createHash, randomUUID } from "node:crypto";
import type { SessionStore } from "../sessions/session-store.ts";
import type { RunStore } from "../runs/run-store.ts";
import type { GrowthStore } from "./growth-store.ts";
import type {
  GrowthEvidence,
  GrowthParticipation,
  GrowthPreferences,
  GrowthReward,
  GrowthSnapshot,
  GrowthState,
  GrowthTask,
  GrowthTaskView,
} from "./growth.ts";

export class GrowthError extends Error {}

export interface GrowthConfig {
  onboarding: Omit<GrowthTask, "key" | "kind">;
  daily: Array<Omit<GrowthTask, "key" | "kind">>;
}

export interface GrowthAction {
  action?: unknown;
  key?: unknown;
  runId?: unknown;
  preferences?: unknown;
}

export function growthCalendar(now: number, timeZone: string): { date: string; time: string; workday: boolean } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(now));
  const at = (type: string) => parts.find((p) => p.type === type)!.value;
  return {
    date: `${at("year")}-${at("month")}-${at("day")}`,
    time: `${at("hour")}:${at("minute")}`,
    workday: !["Sat", "Sun"].includes(at("weekday")),
  };
}

export function parseGrowthConfig(value: unknown): GrowthConfig | null {
  if (!value || typeof value !== "object") return null;
  const c = value as Partial<GrowthConfig>;
  const valid = (t: unknown): boolean => {
    if (!t || typeof t !== "object") return false;
    const v = t as Record<string, unknown>;
    return (
      ["title", "description", "prompt"].every(
        (k) => typeof v[k] === "string" && (v[k] as string).trim().length > 0 && (v[k] as string).length <= 12000,
      ) &&
      typeof v.revisionPrompt === "string" &&
      v.revisionPrompt.length <= 12000 &&
      Array.isArray(v.steps) &&
      v.steps.length === 5 &&
      v.steps.every((s) => typeof s === "string") &&
      Number.isInteger(v.firstPoints) &&
      Number(v.firstPoints) > 0 &&
      Number(v.firstPoints) <= 100 &&
      Number.isInteger(v.revisionPoints) &&
      Number(v.revisionPoints) >= 0 &&
      Number(v.revisionPoints) <= 100
    );
  };
  return valid(c.onboarding) &&
    Number(c.onboarding?.revisionPoints) > 0 &&
    Boolean(c.onboarding?.revisionPrompt.trim()) &&
    Array.isArray(c.daily) &&
    c.daily.length > 0 &&
    c.daily.length <= 30 &&
    c.daily.every((task) => valid(task) && task.revisionPoints === 0 && task.firstPoints <= 30)
    ? (c as GrowthConfig)
    : null;
}

function checkedPreferences(value: unknown): GrowthPreferences {
  const p = value as GrowthPreferences | null;
  if (
    !p ||
    typeof p.enabled !== "boolean" ||
    typeof p.time !== "string" ||
    !/^([01]\d|2[0-3]):[0-5]\d$/.test(p.time) ||
    typeof p.timeZone !== "string" ||
    p.timeZone.length > 80
  )
    throw new GrowthError("Reminder settings are not in the right format");
  try {
    growthCalendar(Date.now(), p.timeZone);
  } catch {
    throw new GrowthError("Choose a valid time zone");
  }
  return { enabled: p.enabled, time: p.time, timeZone: p.timeZone };
}

function taskForDay(config: GrowthConfig, date: string): GrowthTask {
  const day = Math.floor(Date.parse(`${date}T00:00:00Z`) / 86400000);
  return { ...config.daily[day % config.daily.length]!, key: `daily:${date}`, kind: "daily" };
}

function resultHash(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export function createGrowthService(deps: {
  store: GrowthStore;
  sessions: SessionStore;
  runs: RunStore;
  now?: () => number;
}) {
  async function evidence(
    principal: string,
    p: GrowthParticipation,
    awardedRunId?: string,
  ): Promise<{ sessionId: string | null; evidence: GrowthEvidence | null }> {
    const session = await deps.sessions.getByThread(p.threadRef);
    if (
      !session ||
      session.type !== "dm" ||
      session.forkedFrom ||
      session.scopeId !== `personal:${principal}` ||
      !(await deps.sessions.participantsOf(session.id)).includes(principal)
    )
      return { sessionId: null, evidence: null };
    const awarded = awardedRunId ? await deps.runs.get(awardedRunId) : null;
    let rows = awarded ? [awarded] : [];
    if (!awardedRunId)
      rows = (await deps.runs.list({ threadRef: p.threadRef, limit: 100 })).filter((r) => r.sessionId === p.threadRef);
    if (rows.some((r) => r.status === "pending" || r.status === "running"))
      return { sessionId: session.id, evidence: null };
    const candidates = rows.filter(
      (r) =>
        r.sessionId === p.threadRef &&
        r.createdAt >= (p.firstAcceptedAt ?? p.startedAt) &&
        r.request.actor.id === principal &&
        r.request.origin.kind === "human",
    );
    const run = candidates[0];
    const text = run?.result?.reply?.trim() ?? "";
    const firstHash = p.firstHash;
    if (
      !run ||
      run.status !== "done" ||
      run.result?.status !== "ok" ||
      run.result.sessionId !== session.id ||
      run.result.stopped ||
      text.length < 40 ||
      !run.finishedAt ||
      run.request.text.trim().length < 8 ||
      run.id === p.firstRunId ||
      (firstHash && resultHash(text) === firstHash)
    )
      return { sessionId: session.id, evidence: null };
    const visible = await deps.sessions.visibleEntries(session.id, principal);
    if (!visible.some((entry) => entry.type === "assistant" && entry.seq === run.result?.sourceAssistantEntrySeq))
      return { sessionId: session.id, evidence: null };
    return {
      sessionId: session.id,
      evidence: { runId: run.id, text, hash: resultHash(text), finishedAt: run.finishedAt },
    };
  }

  async function taskView(
    principal: string,
    task: GrowthTask,
    state: GrowthState,
    skipped: boolean,
    rewards: GrowthReward[],
  ): Promise<GrowthTaskView> {
    const participation = state.tasks[task.key] ?? null;
    const finalKey = task.kind === "daily" ? task.key : `${task.key}:revision`;
    const awardedRunId = participation?.completedAt ? rewards.find((r) => r.key === finalKey)?.runId : undefined;
    const found = participation
      ? await evidence(principal, participation, awardedRunId)
      : { sessionId: null, evidence: null };
    if (participation?.completedAt && !awardedRunId) found.evidence = null;
    let status: GrowthTaskView["status"] = "available";
    if (participation) status = "working";
    if (participation?.firstAcceptedAt) status = "revise";
    if (found.evidence) status = "review";
    if (skipped) status = "skipped";
    if (participation?.completedAt) status = "complete";
    return { ...task, participation, ...found, status };
  }

  async function snapshot(
    principal: string,
    config: GrowthConfig,
    state: GrowthState,
    rewards: GrowthReward[],
    now: number,
  ): Promise<GrowthSnapshot> {
    const calendar = growthCalendar(now, state.preferences.timeZone);
    const onboarding = await taskView(
      principal,
      state.tasks["onboarding-v1"]?.task ?? { ...config.onboarding, key: "onboarding-v1", kind: "onboarding" },
      state,
      false,
      rewards,
    );
    const dailyTask = taskForDay(config, calendar.date);
    const daily =
      calendar.workday && onboarding.status === "complete"
        ? await taskView(
            principal,
            state.tasks[dailyTask.key]?.task ?? dailyTask,
            state,
            state.skippedDates.includes(calendar.date),
            rewards,
          )
        : null;
    const points = rewards.reduce((sum, r) => sum + r.points, 0);
    const levels = [
      { name: "New Partner", at: 0 },
      { name: "Quick Starter", at: 50 },
      { name: "Skilled Collaborator", at: 150 },
      { name: "Efficiency Explorer", at: 300 },
    ];
    const level = [...levels].reverse().find((l) => points >= l.at)!;
    const due =
      state.preferences.enabled &&
      daily &&
      !["complete", "skipped"].includes(daily.status) &&
      calendar.time >= state.preferences.time;
    if (due && !state.reminderDates.includes(calendar.date))
      state.reminderDates = [...state.reminderDates.slice(-30), calendar.date];
    return {
      points,
      level: level.name,
      nextLevelAt: levels.find((l) => l.at > points)?.at ?? null,
      badges: [
        onboarding.participation?.firstAcceptedAt ? "First Result" : "",
        onboarding.status === "complete" ? "Always Refining" : "",
        rewards.filter((r) => r.key.startsWith("daily:")).length >= 5 ? "Five-Day Practice" : "",
      ].filter(Boolean),
      onboarding,
      daily,
      preferences: state.preferences,
      reminder: due ? { key: daily.key, title: daily.title } : null,
      history: rewards.slice(0, 20),
      date: calendar.date,
    };
  }

  return {
    async execute(principal: string, config: GrowthConfig, action: GrowthAction = {}): Promise<GrowthSnapshot> {
      return deps.store.transact(principal, async (state, rewards, award) => {
        const now = deps.now?.() ?? Date.now();
        if (action.action === "preferences") {
          const next = checkedPreferences(action.preferences);
          if (
            next.timeZone !== state.preferences.timeZone &&
            rewards.some((r) => r.key.startsWith("daily:") && now - r.at < 86400000)
          )
            throw new GrowthError("Keep your time zone for 24 hours after claiming daily points to avoid date clashes");
          state.preferences = next;
        }
        const date = growthCalendar(now, state.preferences.timeZone).date;
        let view = await snapshot(principal, config, state, rewards, now);
        const task = [view.onboarding, view.daily].find((candidate) => candidate?.key === action.key);
        if (action.action === "skip") {
          if (!task || task.kind !== "daily") throw new GrowthError("Choose today's challenge");
          state.skippedDates = [...new Set([...state.skippedDates.slice(-30), date])];
        } else if (["start", "prepare", "accept"].includes(String(action.action))) {
          if (!task || task.status === "skipped") throw new GrowthError("Task unavailable. Refresh the growth guide");
          if (action.action === "start" && !task.participation) {
            const { participation: _p, sessionId: _s, evidence: _e, status: _status, ...definition } = task;
            state.tasks[task.key] = {
              task: definition,
              threadRef: `web:${principal}:${randomUUID()}`,
              startedAt: now,
              prepared: false,
              firstRunId: null,
              firstHash: null,
              firstAcceptedAt: null,
              completedAt: null,
            };
          } else if (action.action === "prepare") {
            if (!task.participation) throw new GrowthError("Start the task first");
            state.tasks[task.key]!.prepared = true;
          } else if (action.action === "accept") {
            const p = state.tasks[task.key];
            if (!p || !p.prepared) throw new GrowthError("Prepare materials, then finish in the dedicated session");
            if (p.completedAt || p.firstRunId === action.runId) return snapshot(principal, config, state, rewards, now);
            const e = task.evidence;
            if (!e || action.runId !== e.runId) throw new GrowthError("No new result to accept; finish and refresh");
            const revision = p.firstAcceptedAt !== null;
            const key = task.kind === "daily" ? task.key : `${task.key}:${revision ? "revision" : "first"}`;
            let reason = revision ? "Revised result and confirmed" : "Confirmed first result";
            if (task.kind === "daily") reason = `Daily challenge: ${task.title}`;
            award({
              key,
              runId: e.runId,
              points: revision ? task.revisionPoints : task.firstPoints,
              reason,
              at: now,
            });
            if (revision || task.kind === "daily" || !task.revisionPoints) p.completedAt = now;
            else {
              p.firstRunId = e.runId;
              p.firstHash = e.hash;
              p.firstAcceptedAt = now;
            }
          }
        } else if (action.action !== undefined && action.action !== "preferences")
          throw new GrowthError("Unsupported growth action");
        const keep = Object.entries(state.tasks).filter(
          ([key]) =>
            key === "onboarding-v1" || key >= `daily:${new Date(now - 31 * 86400000).toISOString().slice(0, 10)}`,
        );
        state.tasks = Object.fromEntries(keep);
        view = await snapshot(principal, config, state, rewards, now);
        return view;
      });
    },
  };
}
