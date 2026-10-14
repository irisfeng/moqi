import { ApiError, api } from "./core-bridge.ts";

interface GrowthTask {
  key: string;
  kind: "onboarding" | "daily";
  title: string;
  description: string;
  prompt: string;
  revisionPrompt: string;
  steps: string[];
  firstPoints: number;
  revisionPoints: number;
}

interface GrowthParticipation {
  task: GrowthTask;
  threadRef: string;
  startedAt: number;
  prepared: boolean;
  firstRunId: string | null;
  firstHash: string | null;
  firstAcceptedAt: number | null;
  completedAt: number | null;
}

export interface GrowthPreferences {
  enabled: boolean;
  time: string;
  timeZone: string;
}

interface GrowthReward {
  key: string;
  runId: string;
  points: number;
  reason: string;
  at: number;
}

interface GrowthEvidence {
  runId: string;
  text: string;
  hash: string;
  finishedAt: number;
}

export interface GrowthTaskView extends GrowthTask {
  participation: GrowthParticipation | null;
  sessionId: string | null;
  evidence: GrowthEvidence | null;
  status: "available" | "working" | "review" | "revise" | "complete" | "skipped";
}

export interface GrowthSnapshot {
  points: number;
  level: string;
  nextLevelAt: number | null;
  badges: string[];
  onboarding: GrowthTaskView;
  daily: GrowthTaskView | null;
  preferences: GrowthPreferences;
  reminder: { key: string; title: string } | null;
  history: GrowthReward[];
  date: string;
}

export interface GrowthAction {
  action: "start" | "prepare" | "accept" | "skip" | "preferences";
  key?: string;
  runId?: string;
  preferences?: GrowthPreferences;
}

class GrowthUnavailableError extends Error {
  readonly status = 503;

  constructor() {
    super("The growth service is unavailable. Try again later.");
    this.name = "GrowthUnavailableError";
  }
}

let current: GrowthSnapshot | null = null;
const listeners = new Set<(snapshot: GrowthSnapshot | null) => void>();
let refreshInFlight: { mutation: number; promise: Promise<GrowthSnapshot> } | null = null;
let actionQueue: Promise<void> = Promise.resolve();
let mutation = 0;
let pollingStarted = false;

export function currentGrowthSnapshot(): GrowthSnapshot | null {
  return current;
}

export function subscribeGrowth(listener: (snapshot: GrowthSnapshot | null) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function publish(snapshot: GrowthSnapshot): GrowthSnapshot {
  if (!snapshot?.onboarding) throw new GrowthUnavailableError();
  current = snapshot;
  for (const listener of listeners) listener(snapshot);
  return snapshot;
}

export async function refreshGrowthSnapshot(): Promise<GrowthSnapshot> {
  const requestMutation = mutation;
  if (refreshInFlight?.mutation === requestMutation) return refreshInFlight.promise;
  const request = api<GrowthSnapshot>("/api/growth")
    .catch((error: unknown) => {
      if (error instanceof ApiError && error.status === 503) throw new GrowthUnavailableError();
      throw error;
    })
    .then((snapshot) => {
      if (requestMutation !== mutation) return current ?? snapshot;
      return publish(snapshot);
    });
  const settled = request.finally(() => {
    if (refreshInFlight?.promise === settled) refreshInFlight = null;
  });
  refreshInFlight = { mutation: requestMutation, promise: settled };
  return settled;
}

async function submitGrowthActionNow(action: GrowthAction): Promise<GrowthSnapshot> {
  const requestMutation = ++mutation;
  try {
    const snapshot = await api<GrowthSnapshot>("/api/growth/action", {
      method: "POST",
      body: JSON.stringify(action),
    });
    if (requestMutation !== mutation) return current ?? snapshot;
    mutation++;
    return publish(snapshot);
  } catch (error) {
    if (error instanceof ApiError && error.status === 503) throw new GrowthUnavailableError();
    throw error;
  }
}

export function submitGrowthAction(action: GrowthAction): Promise<GrowthSnapshot> {
  const run = actionQueue.then(() => submitGrowthActionNow(action));
  actionQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

function visible(): boolean {
  return typeof document === "undefined" || document.visibilityState === "visible";
}

export function startGrowthPolling(): void {
  if (pollingStarted || typeof window === "undefined") return;
  pollingStarted = true;
  void refreshGrowthSnapshot().catch(() => {});
  window.setInterval(() => {
    if (visible()) void refreshGrowthSnapshot().catch(() => {});
  }, 60_000);
  document.addEventListener("visibilitychange", () => {
    if (visible()) void refreshGrowthSnapshot().catch(() => {});
  });
}

export function growthStatusLabel(status: GrowthTaskView["status"]): string {
  switch (status) {
    case "available":
      return "Not started";
    case "working":
      return "In progress";
    case "review":
      return "Awaiting acceptance";
    case "revise":
      return "Needs revision";
    case "complete":
      return "Done";
    case "skipped":
      return "Skipped today";
  }
}

export function growthStageIndex(task: GrowthTaskView): number {
  if (task.status === "complete") return 5;
  if (task.kind === "daily" && task.status === "review") return 3;
  if (task.status === "review") {
    return task.participation?.firstAcceptedAt === null || !task.participation ? 2 : 4;
  }
  if (task.status === "revise") return 3;
  if (task.participation?.prepared) return 2;
  if (task.participation) return 1;
  return 0;
}

export function growthErrorMessage(error: unknown): string {
  if (error instanceof GrowthUnavailableError) return error.message;
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error && error.message.trim()) return error.message;
  return "Could not load growth status. Try again later.";
}
