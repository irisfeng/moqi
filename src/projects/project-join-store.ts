import type { DurableMap } from "../persistence/durable-map.ts";

interface Joined {
  name: string;
  scopeId: string;
  addedBy: string;
  addedAt: number;
  seenAt: number | null;
}

export type ProjectJoinRecord = Record<string, Joined>;

export interface ProjectJoinStore {
  record(memberId: string, projectId: string, join: Omit<Joined, "seenAt">): Promise<void>;
  remove(memberId: string, projectId: string): Promise<void>;
  list(memberId: string): Promise<Array<Joined & { projectId: string }>>;
  markSeen(memberId: string, projectId: string, at: number): Promise<boolean>;
  markAllSeen(memberId: string, at: number): Promise<number>;
}

export function createProjectJoinStore(map: DurableMap<ProjectJoinRecord>): ProjectJoinStore {
  async function change(memberId: string, next: (record: ProjectJoinRecord) => ProjectJoinRecord): Promise<void> {
    if (!map.update) throw new Error("project joins require atomic update");
    await map.putIfAbsent(memberId, {});
    await map.update(memberId, next);
  }
  return {
    async record(memberId, projectId, join) {
      await change(memberId, (record) => ({ ...record, [projectId]: { ...join, seenAt: null } }));
    },
    async remove(memberId, projectId) {
      await change(memberId, (record) => {
        if (!(projectId in record)) return record;
        const { [projectId]: _left, ...rest } = record;
        return rest;
      });
    },
    async list(memberId) {
      return Object.entries((await map.get(memberId)) ?? {})
        .map(([projectId, joined]) => ({ projectId, ...joined }))
        .sort((a, b) => b.addedAt - a.addedAt);
    },
    async markSeen(memberId, projectId, at) {
      let found = false;
      await change(memberId, (record) => {
        const joined = record[projectId];
        if (!joined) return record;
        found = true;
        return joined.seenAt === null ? { ...record, [projectId]: { ...joined, seenAt: at } } : record;
      });
      return found;
    },
    async markAllSeen(memberId, at) {
      let marked = 0;
      await change(memberId, (record) => {
        marked = 0;
        const next: ProjectJoinRecord = {};
        for (const [projectId, joined] of Object.entries(record)) {
          if (joined.seenAt === null) marked += 1;
          next[projectId] = joined.seenAt === null ? { ...joined, seenAt: at } : joined;
        }
        return next;
      });
      return marked;
    },
  };
}
