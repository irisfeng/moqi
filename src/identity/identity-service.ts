import { randomUUID } from "node:crypto";
import type { ActorAssertion, Principal } from "../types.ts";
import { createMemoryMap, type DurableMap } from "../persistence/durable-map.ts";
import { canonicalPerson, foldPrincipalId, personIds, personKey } from "../directory/person.ts";
import { externalMemberActive, type ExternalMember } from "./external-members.ts";

interface IdentityProvider {
  resolve(actor: ActorAssertion): Principal;
  classify(externalId: string, isExternalGuest?: boolean): Principal;
}

type DeactivationSource = "manual" | "directory-sync";

export interface DeactivationRecord {
  principalId: string;
  source: DeactivationSource;
  at: number;
  revision?: string;
}

interface DirectorySyncOutcome {
  deactivated: string[];
  reactivated: string[];
}

export interface IdentityService extends IdentityProvider {
  isActive(externalId: string): Promise<boolean>;
  isInternal(p: Principal): boolean;
  audienceIsAllInternal(audience: Principal[]): boolean;
  deactivate(externalId: string, source?: DeactivationSource): Promise<void>;
  deactivationSource(externalId: string): DeactivationSource | undefined;
  reactivate(externalId: string): Promise<void>;
  recordDirectorySync(removedIds: string[], presentIds: string[]): Promise<DirectorySyncOutcome>;
  listExternalMembers(): Promise<ExternalMember[]>;
  externalMember(principalId: string): ExternalMember | undefined;
  putExternalMember(m: ExternalMember): Promise<void>;
  removeExternalMember(principalId: string): Promise<void>;
  hydrate(): Promise<void>;
  refresh(force?: boolean): Promise<void>;
}

export function actorAssertionActive(
  identity: Pick<IdentityService, "classify" | "isInternal">,
  actor: ActorAssertion | undefined,
): boolean {
  return !!actor?.externalId && identity.isInternal(identity.classify(actor.externalId, actor.isExternalGuest));
}

export function createIdentityService(
  backing?: DurableMap<DeactivationRecord>,
  opts: {
    isOverridden?: (externalId: string) => boolean;
    directorySyncProtected?: readonly string[];
    externalMembers?: DurableMap<ExternalMember>;
    principalLinks?: { refresh(force?: boolean): Promise<void> };
    revokeSessions?: (principalId: string) => Promise<void>;
  } = {},
): IdentityService {
  const store = backing ?? createMemoryMap<DeactivationRecord>();
  const externalStore = opts.externalMembers ?? createMemoryMap<ExternalMember>();
  const deactivated = new Map<string, DeactivationRecord>();
  const pendingDeactivations = new Map<string, DeactivationRecord>();
  const externals = new Map<string, ExternalMember>();
  const directorySyncProtected = opts.directorySyncProtected ?? [];
  const REFRESH_TTL_MS = 10_000;
  const LOAD_ATTEMPTS = 3;
  let mutation = 0;
  let refreshedAt = 0;
  let refreshP: Promise<void> | null = null;
  let hydrateP: Promise<void> | null = null;

  const keptByDirectorySync = (key: string): boolean =>
    directorySyncProtected.some((id) => personKey(id) === key) || externals.has(key);
  const storeKeys = (externalId: string): string[] => [
    ...new Set(personIds(externalId).map(foldPrincipalId).filter(Boolean)),
  ];
  const recordFor = (key: string): DeactivationRecord | undefined =>
    pendingDeactivations.get(key) ?? deactivated.get(key);
  const strongest = (records: DeactivationRecord[]): DeactivationRecord | undefined =>
    records.find((r) => r.source === "manual") ?? records[0];
  const sameRecord = (a: DeactivationRecord, b: DeactivationRecord): boolean =>
    a.source === b.source && a.at === b.at && a.revision === b.revision;

  async function revoke(externalId: string): Promise<void> {
    if (!opts.revokeSessions) return;
    for (const id of storeKeys(externalId)) await opts.revokeSessions(id);
  }

  async function load(overwrite: boolean): Promise<boolean> {
    await opts.principalLinks?.refresh(true);
    for (let attempt = 0; attempt < LOAD_ATTEMPTS; attempt++) {
      const started = mutation;
      const [deactivations, members] = await Promise.all([store.all(), externalStore.all()]);
      if (started !== mutation) continue;
      if (overwrite) {
        deactivated.clear();
        externals.clear();
      }
      for (const r of deactivations) {
        const key = personKey(r.principalId);
        if (deactivated.get(key)?.source !== "manual" && (r.source === "manual" || overwrite || !deactivated.has(key)))
          deactivated.set(key, r);
      }
      for (const m of members) {
        const key = personKey(m.email);
        if (overwrite || !externals.has(key)) externals.set(key, m);
      }
      return true;
    }
    return false;
  }

  async function readPrincipal(
    externalId: string,
  ): Promise<{ record: DeactivationRecord | undefined; stored: Map<string, DeactivationRecord> }> {
    const key = personKey(externalId);
    const started = mutation;
    const stored = new Map<string, DeactivationRecord>();
    for (const storeKey of storeKeys(externalId)) {
      const found = await store.get(storeKey);
      if (found) stored.set(storeKey, found);
    }
    const record = pendingDeactivations.get(key) ?? strongest([...stored.values()]);
    if (started === mutation) {
      if (record) deactivated.set(key, record);
      else deactivated.delete(key);
    }
    return { record, stored };
  }

  function classify(externalId: string, isExternalGuest?: boolean): Principal {
    const id = canonicalPerson(externalId);
    if (opts.isOverridden?.(externalId)) return { id, type: "internal" };
    const key = personKey(externalId);
    const record = recordFor(key);
    const external = externals.get(key);
    const inactive =
      record?.source === "manual" ||
      (record?.source === "directory-sync" && !keptByDirectorySync(key)) ||
      (external !== undefined && !externalMemberActive(external));
    const type: Principal["type"] = inactive || isExternalGuest ? "guest" : "internal";
    return { id, type };
  }

  async function deactivate(externalId: string, source: DeactivationSource = "manual"): Promise<void> {
    const key = personKey(externalId);
    const storeKey = foldPrincipalId(externalId);
    const record: DeactivationRecord = { principalId: externalId, source, at: Date.now(), revision: randomUUID() };
    mutation++;
    deactivated.set(key, record);
    pendingDeactivations.set(key, record);
    let persisted: DeactivationRecord | null = null;
    try {
      if (!store.update) throw new Error("identity store requires atomic update");
      for (let attempt = 0; attempt < 3 && !persisted; attempt++) {
        await store.putIfAbsent(storeKey, record);
        persisted = await store.update(storeKey, (current) =>
          current.source === "manual" && source === "directory-sync" ? current : record,
        );
      }
      if (!persisted) throw new Error("identity changed repeatedly during deactivation");
      await revoke(externalId);
    } finally {
      mutation++;
      if (persisted && pendingDeactivations.get(key) === record) {
        deactivated.set(key, persisted);
        pendingDeactivations.delete(key);
      }
    }
    await readPrincipal(externalId);
  }

  async function reactivateFrom(externalId: string, source?: DeactivationSource): Promise<boolean> {
    const key = personKey(externalId);
    const { record, stored } = await readPrincipal(externalId);
    if (!record || (source && record.source !== source)) return false;
    mutation++;
    try {
      if (!store.deleteIf) throw new Error("identity store requires conditional delete");
      await revoke(externalId);
      let removed = true;
      for (const [storeKey, seen] of stored)
        if (!(await store.deleteIf(storeKey, (current) => sameRecord(current, seen)))) removed = false;
      if (removed) {
        mutation++;
        if (pendingDeactivations.get(key) === record) pendingDeactivations.delete(key);
        deactivated.delete(key);
      }
      return removed;
    } finally {
      mutation++;
      await readPrincipal(externalId);
    }
  }

  async function refresh(force = false): Promise<void> {
    const now = Date.now();
    if (refreshP) return refreshP;
    if (!force && now - refreshedAt < REFRESH_TTL_MS) return;
    refreshP = load(true)
      .then((applied) => {
        if (applied) refreshedAt = Date.now();
      })
      .finally(() => {
        refreshP = null;
      });
    return refreshP;
  }

  return {
    classify,
    deactivate,
    async isActive(externalId: string): Promise<boolean> {
      await readPrincipal(externalId);
      return classify(externalId).type === "internal";
    },
    deactivationSource(externalId: string): DeactivationSource | undefined {
      return recordFor(personKey(externalId))?.source;
    },
    async reactivate(externalId: string): Promise<void> {
      await reactivateFrom(externalId);
    },
    async recordDirectorySync(removedIds: string[], presentIds: string[]): Promise<DirectorySyncOutcome> {
      const outcome: DirectorySyncOutcome = { deactivated: [], reactivated: [] };
      await refresh(true);
      const errors: unknown[] = [];
      const removed = new Set<string>();
      for (const id of removedIds) {
        const key = personKey(id);
        if (removed.has(key) || keptByDirectorySync(key)) continue;
        removed.add(key);
        try {
          const existing = (await readPrincipal(id)).record;
          await deactivate(id, "directory-sync");
          if (!existing) outcome.deactivated.push(id);
        } catch (error) {
          errors.push(error);
        }
      }
      if (errors.length) throw new AggregateError(errors, "directory deactivation incomplete");
      const present = new Set<string>();
      for (const id of presentIds) {
        const key = personKey(id);
        if (present.has(key) || recordFor(key)?.source !== "directory-sync") continue;
        present.add(key);
        if (await reactivateFrom(id, "directory-sync")) outcome.reactivated.push(id);
      }
      return outcome;
    },
    async listExternalMembers(): Promise<ExternalMember[]> {
      await refresh();
      return [...externals.values()];
    },
    externalMember(principalId: string): ExternalMember | undefined {
      return externals.get(personKey(principalId));
    },
    async putExternalMember(m: ExternalMember): Promise<void> {
      externals.set(personKey(m.email), m);
      await externalStore.put(foldPrincipalId(m.email), m);
    },
    async removeExternalMember(principalId: string): Promise<void> {
      externals.delete(personKey(principalId));
      for (const key of storeKeys(principalId)) await externalStore.delete(key);
    },
    hydrate(): Promise<void> {
      hydrateP ??= load(false).then(() => undefined);
      return hydrateP;
    },
    refresh,
    resolve(actor: ActorAssertion): Principal {
      const p = classify(actor.externalId, actor.isExternalGuest);
      return {
        ...p,
        ...(actor.teamIds ? { teamIds: actor.teamIds } : {}),
        ...(actor.displayName ? { displayName: actor.displayName } : {}),
      };
    },
    isInternal(p: Principal): boolean {
      return p.type === "internal";
    },
    audienceIsAllInternal(audience: Principal[]): boolean {
      return audience.length > 0 && audience.every((p) => p.type === "internal");
    },
  };
}
