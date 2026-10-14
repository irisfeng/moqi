import type { Run, RunStore } from "../runs/run-store.ts";
import { echoesCronContextMarkers } from "./scheduler.ts";

function isCronRun(run: Run, threadRef: string, fireKey: string): boolean {
  if (run.sessionId !== threadRef || run.request.conversation.threadRef !== threadRef || run.request.surface !== "cron")
    return false;
  const expectedKey = run.request.scopeVersion ? `${fireKey}:project-${run.request.scopeVersion}` : fireKey;
  return run.dedupKey === expectedKey;
}

export async function findCronRun(
  runs: Pick<RunStore, "getByDedupKey" | "findByDedupKeyPrefix">,
  threadRef: string,
  fireKey: string,
): Promise<Run | null> {
  const exact = await runs.getByDedupKey(fireKey);
  const candidates = exact ? [exact] : await runs.findByDedupKeyPrefix(`${fireKey}:project-`, 3);
  return candidates.find((run) => isCronRun(run, threadRef, fireKey)) ?? null;
}

export function safeCronReply(reply: string): string {
  return echoesCronContextMarkers(reply) ? "[reply echoed cron runtime context; omitted]" : reply;
}
