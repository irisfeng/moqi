import { personKey } from "../directory/person.ts";

export interface FirstWebTurnRecord {
  kind: "human" | "opener" | "reset";
  threadRef: string;
  createdAt: number;
  openerGeneration?: string;
}

export function firstWebTurnLockKey(actorId: string): string {
  return `web-first-turn:${personKey(actorId)}`;
}

export function defaultOpenerKey(actorId: string): string {
  return `web:${encodeURIComponent(actorId)}:server:proactive-opener:v1`;
}

export function openerKeyFor(actorId: string, record: FirstWebTurnRecord | null): string {
  const base = defaultOpenerKey(actorId);
  return record?.openerGeneration ? `${base}:${record.openerGeneration}` : base;
}
