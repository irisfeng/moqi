export const DRAFT_PERSISTENCE_EVENT = "web-ui:draft-persistence";

const DRAFTS_STORAGE_KEY = "web-ui:drafts";
export const DRAFTS_EPOCH_KEY = "web-ui:drafts-epoch";
const DRAFTS_OWNER_KEY = "web-ui:drafts-owner";
const DRAFTS_LOGOUT_PENDING_KEY = "web-ui:drafts-logout-pending";
const DRAFTS_LOGOUT_PENDING_COOKIE_PREFIX = "coworker_drafts_logout_";
const DRAFTS_LOGOUT_PENDING_LEGACY_COOKIE = "coworker_drafts_logout_epoch";
const DRAFTS_LOGOUT_CHANNEL = "web-ui:drafts-logout";
const DRAFT_JOURNAL_PREFIX = "web-ui:draft-journal:";
const DRAFT_CONFLICT_PREFIX = "web-ui:draft-conflict:";
const SEND_KEY_PREFIX = "web-ui:draft-send:";
const ATTACHED_SEND_PREFIX = "web-ui:attached-send:";
const QUEUED_SEND_PREFIX = "web-ui:queued-send:";
const DRAFTS_CAP = 30;
const PERSIST_DEBOUNCE_MS = 400;

type DraftEntry = { text: string; revision: string | null };
type DraftMutation =
  | { kind: "set"; entry: DraftEntry }
  | { kind: "clear" }
  | { kind: "clear-if-revision"; revision: string }
  | { kind: "upgrade"; text: string; revision: string };
type StampedMutation = {
  key: string;
  mutation: DraftMutation;
  stamp: number;
  writer: string;
  epoch: string;
  committed?: boolean;
};

let persistenceFailed = false;
let persistTimer: ReturnType<typeof setTimeout> | null = null;
const pending = new Map<string, StampedMutation>();
let writeInFlight: Promise<void> = Promise.resolve();
let generation = 0;
let activeEpoch = readEpoch();
let lastKnownDurableEpoch = activeEpoch;
let activeOwner: string | null | undefined;
let cleanupPendingEpoch: string | null = null;
const writer = readWriter();
let lastStamp = 0;
let remoteSignOutHandler: (() => void) | null = null;
let logoutChannel: BroadcastChannel | null = null;

export function draftPersistenceFailed(): boolean {
  return persistenceFailed;
}

function setPersistenceFailed(failed: boolean): void {
  if (persistenceFailed === failed) return;
  persistenceFailed = failed;
  if (typeof window !== "undefined") window.dispatchEvent(new Event(DRAFT_PERSISTENCE_EVENT));
}

export function setRemoteDraftSignOutHandler(handler: () => void): void {
  remoteSignOutHandler = handler;
}

function readWriter(): string {
  return crypto.randomUUID();
}

function conflictKey(key: string, revision: string): string {
  return `${DRAFT_CONFLICT_PREFIX}${activeEpoch}:${encodeURIComponent(key)}:${encodeURIComponent(revision)}`;
}

function preserveConflict(key: string, entry: DraftEntry): boolean {
  if (!entry.text.trim() || !entry.revision || !currentEpoch()) return false;
  const storageKey = conflictKey(key, entry.revision);
  try {
    if (localStorage.getItem(`${storageKey}:dismissed`)) return true;
    const value = JSON.stringify({ ...entry, epoch: activeEpoch, key });
    if (localStorage.getItem(storageKey) !== value) localStorage.setItem(storageKey, value);
    if (localStorage.getItem(`${storageKey}:dismissed`)) localStorage.removeItem(storageKey);
    if (!currentEpoch()) {
      localStorage.removeItem(storageKey);
      return false;
    }
    return true;
  } catch {
    setPersistenceFailed(true);
    return false;
  }
}

type DraftConflict = { text: string; revision: string; archived: boolean };

export function draftConflicts(key: string, currentText: string): DraftConflict[] {
  if (!currentEpoch()) return [];
  const found = new Map<string, DraftConflict>();
  try {
    const prefix = `${DRAFT_CONFLICT_PREFIX}${activeEpoch}:${encodeURIComponent(key)}:`;
    for (let index = 0; index < localStorage.length; index++) {
      const storageKey = localStorage.key(index);
      if (
        !storageKey?.startsWith(prefix) ||
        storageKey.endsWith(":dismissed") ||
        localStorage.getItem(`${storageKey}:dismissed`)
      )
        continue;
      try {
        const entry = JSON.parse(localStorage.getItem(storageKey) ?? "null") as Partial<DraftEntry> & {
          key?: string;
          epoch?: string;
        };
        if (
          entry?.epoch !== activeEpoch ||
          entry.key !== key ||
          typeof entry.revision !== "string" ||
          typeof entry.text !== "string" ||
          !entry.text.trim() ||
          storageKey !== conflictKey(key, entry.revision)
        )
          continue;
        found.set(entry.revision, { text: entry.text, revision: entry.revision, archived: true });
      } catch {
        continue;
      }
    }
    const latest = loadDrafts().get(key);
    if (latest?.revision && !localStorage.getItem(`${conflictKey(key, latest.revision)}:dismissed`))
      found.set(latest.revision, { ...latest, revision: latest.revision, archived: false });
  } catch {
    setPersistenceFailed(true);
  }
  return currentEpoch() ? [...found.values()].filter((entry) => entry.text !== currentText) : [];
}

export function discardDraftConflict(key: string, revision: string): boolean {
  if (!currentEpoch()) return false;
  try {
    const storageKey = conflictKey(key, revision);
    localStorage.setItem(`${storageKey}:dismissed`, "1");
    localStorage.removeItem(storageKey);
    return currentEpoch();
  } catch {
    setPersistenceFailed(true);
    return false;
  }
}

export function restoreDraftConflict(key: string, revision: string, currentText: string): string | null {
  const selected = draftConflicts(key, currentText).find((entry) => entry.revision === revision);
  if (!selected || !currentEpoch()) return null;
  if (currentText.trim() && !preserveConflict(key, { text: currentText, revision: crypto.randomUUID() })) return null;
  saveDraft(key, selected.text);
  return selected.text;
}

function stampMutation(key: string, mutation: DraftMutation): void {
  const persistedStamp = readJournals().reduce((latest, entry) => Math.max(latest, entry.stamp), 0);
  lastStamp = Math.max(Date.now(), lastStamp + 1, persistedStamp + 1);
  const entry = { key, mutation, stamp: lastStamp, writer, epoch: activeEpoch };
  pending.set(key, entry);
  persistJournal([entry]);
}

function journalKey(entry: StampedMutation): string {
  return `${DRAFT_JOURNAL_PREFIX}${entry.writer}:${encodeURIComponent(entry.key)}${entry.mutation.kind === "clear-if-revision" ? ":clear-if-revision" : ""}`;
}

function readJournals(): StampedMutation[] {
  const entries: StampedMutation[] = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key?.startsWith(DRAFT_JOURNAL_PREFIX)) continue;
      let value: unknown;
      try {
        value = JSON.parse(localStorage.getItem(key) ?? "null");
      } catch {
        continue;
      }
      if (!value || typeof value !== "object") continue;
      const entry = value as Partial<StampedMutation>;
      const mutation = entry.mutation;
      if (
        entry.epoch !== activeEpoch ||
        typeof entry.key !== "string" ||
        typeof entry.writer !== "string" ||
        typeof entry.stamp !== "number" ||
        !Number.isFinite(entry.stamp) ||
        !mutation ||
        !(
          (mutation.kind === "set" &&
            typeof mutation.entry?.text === "string" &&
            typeof mutation.entry.revision === "string") ||
          mutation.kind === "clear" ||
          (mutation.kind === "clear-if-revision" && typeof mutation.revision === "string") ||
          (mutation.kind === "upgrade" && typeof mutation.text === "string" && typeof mutation.revision === "string")
        )
      )
        continue;
      entries.push(entry as StampedMutation);
    }
  } catch {
    return entries;
  }
  return entries;
}

function persistJournal(entries: Iterable<StampedMutation> = pending.values()): boolean {
  if (!currentEpoch()) return false;
  try {
    for (const entry of entries) {
      const latest = readJournals().filter((current) => current.key === entry.key);
      if (latest.some((current) => current.stamp > entry.stamp)) {
        if (entry.mutation.kind === "set" && !preserveConflict(entry.key, entry.mutation.entry)) return false;
        continue;
      }
      for (const current of latest) {
        if (
          current.writer !== entry.writer &&
          current.mutation.kind === "set" &&
          !(
            entry.mutation.kind === "clear-if-revision" && entry.mutation.revision === current.mutation.entry.revision
          ) &&
          !(entry.mutation.kind === "set" && entry.mutation.entry.revision === current.mutation.entry.revision) &&
          !preserveConflict(entry.key, current.mutation.entry)
        )
          return false;
      }
      const key = journalKey(entry);
      localStorage.setItem(key, JSON.stringify(entry));
      if (!currentEpoch()) {
        localStorage.removeItem(key);
        return false;
      }
    }
    return true;
  } catch {
    setPersistenceFailed(true);
    return false;
  }
}

function readEpoch(): string {
  return readReadableEpoch() ?? "";
}

function readReadableEpoch(): string | null {
  try {
    return localStorage.getItem(DRAFTS_EPOCH_KEY) ?? "";
  } catch {
    return null;
  }
}

function readOwner(): string {
  try {
    return localStorage.getItem(DRAFTS_OWNER_KEY) ?? "";
  } catch {
    return "";
  }
}

function cleanupMarker(epoch: string): string {
  return `epoch:${epoch}`;
}

function cleanupCookieName(epoch: string): string {
  let suffix = "legacy";
  if (epoch) {
    suffix = /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(epoch) ? epoch.replaceAll("-", "") : "invalid";
  }
  return `${DRAFTS_LOGOUT_PENDING_COOKIE_PREFIX}${suffix}`;
}

function readCleanupCookie(epoch: string): boolean {
  try {
    return document.cookie.split(";").some((part) => part.trim().startsWith(`${cleanupCookieName(epoch)}=`));
  } catch {
    return false;
  }
}

function readLegacyCleanupCookie(epoch: string): boolean {
  try {
    const pair = document.cookie
      .split(";")
      .map((part) => part.trim())
      .find((part) => part.startsWith(`${DRAFTS_LOGOUT_PENDING_LEGACY_COOKIE}=`));
    return pair
      ? decodeURIComponent(pair.slice(DRAFTS_LOGOUT_PENDING_LEGACY_COOKIE.length + 1)) === cleanupMarker(epoch)
      : false;
  } catch {
    return false;
  }
}

function readCleanupSessionMarker(): string | null {
  try {
    return sessionStorage.getItem(DRAFTS_LOGOUT_PENDING_KEY);
  } catch {
    return null;
  }
}

function cleanupPendingForEpoch(epoch: string): boolean {
  const marker = cleanupMarker(epoch);
  if (cleanupPendingEpoch === marker || readCleanupCookie(epoch) || readLegacyCleanupCookie(epoch)) return true;
  return readCleanupSessionMarker() === marker;
}

function setCleanupPending(epoch: string): void {
  const marker = cleanupMarker(epoch);
  cleanupPendingEpoch = marker;
  try {
    sessionStorage.setItem(DRAFTS_LOGOUT_PENDING_KEY, marker);
  } catch {
    void 0;
  }
  try {
    const secure = typeof location !== "undefined" && location.protocol === "https:" ? "; Secure" : "";
    document.cookie = `${cleanupCookieName(epoch)}=1; Path=/; Max-Age=31536000; SameSite=Strict${secure}`;
  } catch {
    void 0;
  }
  try {
    logoutChannel?.postMessage({ epoch });
  } catch {
    void 0;
  }
}

function clearCleanupPending(epoch: string): void {
  const marker = cleanupMarker(epoch);
  if (cleanupPendingEpoch === marker) cleanupPendingEpoch = null;
  try {
    if (readCleanupSessionMarker() === marker) sessionStorage.removeItem(DRAFTS_LOGOUT_PENDING_KEY);
  } catch {
    void 0;
  }
  try {
    document.cookie = `${cleanupCookieName(epoch)}=; Path=/; Max-Age=0; SameSite=Strict`;
  } catch {
    void 0;
  }
}

function currentEpoch(): boolean {
  const epoch = readReadableEpoch();
  return (
    epoch !== null &&
    activeEpoch === epoch &&
    !cleanupPendingForEpoch(epoch) &&
    (activeOwner === undefined || (activeOwner !== null && activeOwner === readOwner()))
  );
}

function ensureLegacyDraftSlot(): void {
  try {
    if (localStorage.getItem(DRAFTS_STORAGE_KEY) === null) localStorage.setItem(DRAFTS_STORAGE_KEY, "[]");
  } catch {
    void 0;
  }
}

export function newChatDraftKey(user: string | null | undefined): string {
  return `__new-chat__:${user ?? "anon"}`;
}

export function clearAllDrafts(): boolean {
  const observedEpoch = readReadableEpoch();
  const previousEpoch = observedEpoch ?? lastKnownDurableEpoch;
  if (observedEpoch !== null) lastKnownDurableEpoch = observedEpoch;
  generation++;
  dropPendingPersist();
  pending.clear();
  const nextEpoch = crypto.randomUUID();
  const rotate = (): boolean => {
    try {
      localStorage.setItem(DRAFTS_EPOCH_KEY, nextEpoch);
      return localStorage.getItem(DRAFTS_EPOCH_KEY) === nextEpoch;
    } catch {
      return false;
    }
  };
  const clearStoredState = (): void => {
    try {
      localStorage.removeItem(DRAFTS_STORAGE_KEY);
      localStorage.removeItem(DRAFTS_OWNER_KEY);
      const keys = Array.from({ length: localStorage.length }, (_, i) => localStorage.key(i)).filter(
        (key): key is string =>
          key?.startsWith(SEND_KEY_PREFIX) === true ||
          key?.startsWith(ATTACHED_SEND_PREFIX) === true ||
          key?.startsWith(QUEUED_SEND_PREFIX) === true ||
          key?.startsWith(DRAFT_JOURNAL_PREFIX) === true ||
          key?.startsWith(DRAFT_CONFLICT_PREFIX) === true,
      );
      for (const key of keys) localStorage.removeItem(key);
    } catch {
      void 0;
    }
  };
  let rotated = rotate();
  if (!rotated) {
    clearStoredState();
    rotated = rotate();
  }
  if (rotated) clearStoredState();
  activeEpoch = nextEpoch;
  if (rotated) lastKnownDurableEpoch = nextEpoch;
  if (activeOwner !== undefined) activeOwner = null;
  if (rotated) clearCleanupPending(previousEpoch);
  else setCleanupPending(previousEpoch);
  if (rotated) setPersistenceFailed(false);
  return rotated;
}

export function resumeDraftsAfterSignIn(user: string): void {
  if (!user) {
    activeOwner = null;
    return;
  }
  if (cleanupPendingForEpoch(readEpoch()) || readOwner() !== user) {
    if (!clearAllDrafts()) {
      activeOwner = null;
      return;
    }
    try {
      localStorage.setItem(DRAFTS_OWNER_KEY, user);
      if (readOwner() !== user) {
        activeOwner = null;
        return;
      }
    } catch {
      activeOwner = null;
      return;
    }
  }
  const epoch = readReadableEpoch();
  if (epoch === null) {
    activeOwner = null;
    return;
  }
  lastKnownDurableEpoch = epoch;
  if (activeEpoch !== epoch) {
    generation++;
    dropPendingPersist();
    pending.clear();
    activeEpoch = epoch;
  }
  activeOwner = user;
}

function parseDrafts(raw: string | null): Map<string, DraftEntry> {
  const drafts = new Map<string, DraftEntry>();
  try {
    const parsed: unknown = JSON.parse(raw ?? "[]");
    if (!Array.isArray(parsed)) return drafts;
    const pairs = parsed.filter(
      (p): p is [string, string, string?, string?] =>
        Array.isArray(p) && typeof p[0] === "string" && typeof p[1] === "string",
    );
    for (const [key, value, revision, epoch] of pairs) {
      if ((typeof epoch === "string" ? epoch : "") !== activeEpoch) continue;
      drafts.set(key, { text: value, revision: typeof revision === "string" ? revision : null });
    }
    while (drafts.size > DRAFTS_CAP) drafts.delete(drafts.keys().next().value as string);
  } catch {
    void 0;
  }
  return drafts;
}

function isLegacyDrafts(raw: string | null): boolean {
  if (raw === null) return false;
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) && parsed.every((entry) => Array.isArray(entry) && entry.length === 2);
  } catch {
    return false;
  }
}

function mutationsForDrafts(raw: string | null, mutations: StampedMutation[]): StampedMutation[] {
  return isLegacyDrafts(raw) && !activeEpoch ? mutations.filter((entry) => !entry.committed) : mutations;
}

function applyMutations(drafts: Map<string, DraftEntry>, mutations: StampedMutation[]): Map<string, DraftEntry> {
  for (const { key, mutation } of mutations.sort((a, b) => a.stamp - b.stamp || a.writer.localeCompare(b.writer))) {
    if (mutation.kind === "set") {
      drafts.delete(key);
      drafts.set(key, mutation.entry);
    } else if (mutation.kind === "clear") drafts.delete(key);
    else if (mutation.kind === "clear-if-revision") {
      if (drafts.get(key)?.revision === mutation.revision) drafts.delete(key);
    } else if (drafts.get(key)?.text === mutation.text && drafts.get(key)?.revision === null)
      drafts.set(key, { text: mutation.text, revision: mutation.revision });
  }
  while (drafts.size > DRAFTS_CAP) drafts.delete(drafts.keys().next().value as string);
  return drafts;
}

function loadDrafts(): Map<string, DraftEntry> {
  if (!currentEpoch()) {
    dropPendingPersist();
    pending.clear();
    return new Map();
  }
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(DRAFTS_STORAGE_KEY);
  } catch {
    void 0;
  }
  return applyMutations(parseDrafts(raw), mutationsForDrafts(raw, [...readJournals(), ...pending.values()]));
}

function persistNow(): Promise<void> {
  dropPendingPersist();
  if (!currentEpoch()) {
    pending.clear();
    return Promise.resolve();
  }
  if (!pending.size) return writeInFlight;
  if (!persistJournal()) return writeInFlight;
  const write = writeInFlight.then(async () => {
    const commit = (): void => {
      if (!currentEpoch() || !pending.size) return;
      const mutations = new Map(pending);
      let persisted = false;
      try {
        const journals = readJournals();
        const previousRaw = localStorage.getItem(DRAFTS_STORAGE_KEY);
        const legacyBase = isLegacyDrafts(previousRaw);
        const drafts = applyMutations(
          parseDrafts(previousRaw),
          mutationsForDrafts(previousRaw, [...journals, ...mutations.values()]),
        );
        for (const journal of journals) {
          if (
            journal.mutation.kind === "set" &&
            drafts.has(journal.key) &&
            drafts.get(journal.key)?.revision !== journal.mutation.entry.revision &&
            !preserveConflict(journal.key, journal.mutation.entry)
          )
            return;
        }
        const raw = JSON.stringify(
          [...drafts].map(([key, entry]) => [key, entry.text, entry.revision ?? crypto.randomUUID(), activeEpoch]),
        );
        localStorage.setItem(DRAFTS_STORAGE_KEY, raw);
        persisted = true;
        for (const [key, mutation] of mutations) if (pending.get(key) === mutation) pending.delete(key);
        if (currentEpoch() && localStorage.getItem(DRAFTS_STORAGE_KEY) === raw) {
          for (const journal of journals) {
            if (journal.writer !== writer) continue;
            const key = journalKey(journal);
            if (localStorage.getItem(key) !== JSON.stringify(journal)) continue;
            let revision: string | null = null;
            if (journal.mutation.kind === "set") revision = journal.mutation.entry.revision;
            else if (journal.mutation.kind === "upgrade") revision = journal.mutation.revision;
            const retainedByClear =
              revision !== null &&
              journals.some(
                (entry) =>
                  entry.key === journal.key &&
                  entry.mutation.kind === "clear-if-revision" &&
                  entry.mutation.revision === revision,
              );
            if (!drafts.has(journal.key) && revision !== null && !retainedByClear) localStorage.removeItem(key);
            else if (legacyBase && journal.committed && !activeEpoch) localStorage.removeItem(key);
            else localStorage.setItem(key, JSON.stringify({ ...journal, committed: true }));
          }
        }
        if (!currentEpoch()) {
          if (localStorage.getItem(DRAFTS_STORAGE_KEY) === raw) localStorage.removeItem(DRAFTS_STORAGE_KEY);
        }
      } catch {
        if (!persisted) setPersistenceFailed(true);
      }
      if (persisted && currentEpoch()) setPersistenceFailed(false);
    };
    if (typeof navigator !== "undefined" && navigator.locks) await navigator.locks.request(DRAFTS_STORAGE_KEY, commit);
    else commit();
  });
  writeInFlight = write.catch(() => setPersistenceFailed(true));
  return write;
}

function schedulePersist(): void {
  if (persistTimer !== null) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    void persistNow();
  }, PERSIST_DEBOUNCE_MS);
  (persistTimer as { unref?: () => void }).unref?.();
}

function dropPendingPersist(): void {
  if (persistTimer === null) return;
  clearTimeout(persistTimer);
  persistTimer = null;
}

export function flushDrafts(): Promise<void> {
  return persistTimer !== null || pending.size > 0 ? persistNow() : writeInFlight;
}

export function draftPersisted(key: string, revision: string | null): boolean {
  if (!revision || !currentEpoch()) return false;
  try {
    const raw = localStorage.getItem(DRAFTS_STORAGE_KEY);
    return applyMutations(parseDrafts(raw), mutationsForDrafts(raw, readJournals())).get(key)?.revision === revision;
  } catch {
    return false;
  }
}

if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
  if (typeof window.BroadcastChannel !== "undefined") {
    try {
      logoutChannel = new window.BroadcastChannel(DRAFTS_LOGOUT_CHANNEL);
      logoutChannel.onmessage = (event: MessageEvent<{ epoch?: string }>) => {
        if (event.data?.epoch !== activeEpoch) return;
        cleanupPendingEpoch = cleanupMarker(activeEpoch);
        remoteSignOutHandler?.();
      };
    } catch {
      logoutChannel = null;
    }
  }
  window.addEventListener("storage", (event: StorageEvent) => {
    if (event.key === DRAFTS_STORAGE_KEY && event.oldValue !== null && event.newValue === null && currentEpoch()) {
      clearAllDrafts();
      remoteSignOutHandler?.();
    }
  });
  window.addEventListener("pagehide", () => {
    persistJournal();
    void flushDrafts();
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") {
      persistJournal();
      void flushDrafts();
    }
  });
}

export function storedDraft(key: string): string {
  return loadDrafts().get(key)?.text ?? "";
}

export function saveDraft(key: string, text: string, revision: string = crypto.randomUUID()): void {
  if (!currentEpoch()) {
    setPersistenceFailed(true);
    return;
  }
  const drafts = loadDrafts();
  if (text.trim()) {
    ensureLegacyDraftSlot();
    const entry = { text, revision };
    stampMutation(key, { kind: "set", entry });
    drafts.delete(key);
    drafts.set(key, entry);
  } else {
    if (!drafts.has(key)) return;
    stampMutation(key, { kind: "clear" });
    drafts.delete(key);
  }
  while (drafts.size > DRAFTS_CAP) drafts.delete(drafts.keys().next().value as string);
  schedulePersist();
}

export function clearDraft(key: string): void {
  if (!currentEpoch()) return;
  const drafts = loadDrafts();
  if (!drafts.delete(key)) return;
  stampMutation(key, { kind: "clear" });
  schedulePersist();
}

export function draftGeneration(): string {
  return `${generation}:${readEpoch()}`;
}

export function draftRevision(key: string): string | null {
  const entry = loadDrafts().get(key);
  if (!entry || entry.revision) return entry?.revision ?? null;
  const revision = crypto.randomUUID();
  stampMutation(key, { kind: "upgrade", text: entry.text, revision });
  schedulePersist();
  return revision;
}

export async function clearDraftIfMatches(
  key: string,
  text: string,
  expectedGeneration: string,
  expectedRevision: string | null,
): Promise<void> {
  await flushDrafts();
  if (!currentEpoch() || draftGeneration() !== expectedGeneration || !expectedRevision) return;
  const drafts = loadDrafts();
  const entry = drafts.get(key);
  if (entry?.text !== text || entry.revision !== expectedRevision) return;
  if (!discardDraftConflict(key, expectedRevision)) return;
  stampMutation(key, { kind: "clear-if-revision", revision: expectedRevision });
  drafts.delete(key);
  await persistNow();
}
