export interface GrowthTask {
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

export interface GrowthParticipation {
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

export interface GrowthState {
  preferences: GrowthPreferences;
  tasks: Record<string, GrowthParticipation>;
  skippedDates: string[];
  reminderDates: string[];
}

export interface GrowthReward {
  key: string;
  runId: string;
  points: number;
  reason: string;
  at: number;
}

export interface GrowthEvidence {
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
