import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  clearAllDrafts,
  clearDraft,
  clearDraftIfMatches,
  draftGeneration,
  draftPersisted,
  draftRevision,
  flushDrafts,
  newChatDraftKey,
  resumeDraftsAfterSignIn,
  saveDraft,
  storedDraft,
} from "../src/drafts.ts";

const store = new Map<string, string>();
const lockQueues = new Map<string, Promise<unknown>>();
let lockRequests = 0;
Object.defineProperty(globalThis, "navigator", {
  configurable: true,
  value: {
    locks: {
      request<T>(name: string, callback: () => T | Promise<T>): Promise<T> {
        lockRequests++;
        const result = (lockQueues.get(name) ?? Promise.resolve()).then(callback);
        lockQueues.set(
          name,
          result.then(
            () => undefined,
            () => undefined,
          ),
        );
        return result;
      },
    },
  },
});
let beforeDraftWrite: (() => void) | null = null;
let beforeJournalWrite: (() => void) | null = null;
let beforeDraftRead: (() => void) | null = null;
let draftReadsUntilHook = 0;
let failDraftWrites = false;
let failSendWrites = false;
let failEpochWrites = 0;
(globalThis as { localStorage?: unknown }).localStorage = {
  get length() {
    return store.size;
  },
  key: (i: number) => [...store.keys()][i] ?? null,
  getItem: (k: string) => {
    if (k === "web-ui:drafts" && beforeDraftRead && --draftReadsUntilHook === 0) {
      const action = beforeDraftRead;
      beforeDraftRead = null;
      action();
    }
    return store.get(k) ?? null;
  },
  setItem: (k: string, v: string) => {
    if (k === "web-ui:drafts-epoch" && failEpochWrites-- > 0) throw new Error("storage full");
    if (k.startsWith("web-ui:draft-journal:") && beforeJournalWrite) {
      const action = beforeJournalWrite;
      beforeJournalWrite = null;
      action();
    }
    if (failDraftWrites && (k === "web-ui:drafts" || k.startsWith("web-ui:draft-journal:")))
      throw new Error("storage full");
    if (failSendWrites && k.startsWith("web-ui:draft-send:")) throw new Error("storage full");
    if (k === "web-ui:drafts" && beforeDraftWrite) {
      const action = beforeDraftWrite;
      beforeDraftWrite = null;
      action();
    }
    store.set(k, v);
  },
  removeItem: (k: string) => void store.delete(k),
};

async function isolatedDrafts(tab: string): Promise<typeof import("../src/drafts.ts")> {
  return (await import(new URL(`../src/drafts.ts?${tab}`, import.meta.url).href)) as typeof import("../src/drafts.ts");
}

beforeEach(() => {
  lockQueues.clear();
  lockRequests = 0;
  beforeDraftWrite = null;
  beforeJournalWrite = null;
  beforeDraftRead = null;
  draftReadsUntilHook = 0;
  failDraftWrites = false;
  failSendWrites = false;
  failEpochWrites = 0;
  store.clear();
  clearAllDrafts();
  resumeDraftsAfterSignIn("alice");
});

test("a saved draft comes back for its conversation and not others", async () => {
  saveDraft("web:me:a", "half-typed thought");
  assert.equal(storedDraft("web:me:a"), "half-typed thought");
  assert.equal(storedDraft("web:me:b"), "");
});

test("saving updates in place and clearing or blanking removes the entry", async () => {
  saveDraft("web:me:a", "first");
  saveDraft("web:me:a", "second");
  assert.equal(storedDraft("web:me:a"), "second");
  saveDraft("web:me:a", "   ");
  assert.equal(storedDraft("web:me:a"), "");
  saveDraft("web:me:b", "kept");
  clearDraft("web:me:b");
  assert.equal(storedDraft("web:me:b"), "");
});

test("the store is LRU-capped: oldest drafts fall off, recently touched ones survive", async () => {
  for (let i = 0; i < 30; i++) saveDraft(`t${i}`, `draft ${i}`);
  saveDraft("t0", "still warm");
  saveDraft("t30", "newest");
  assert.equal(storedDraft("t1"), "");
  assert.equal(storedDraft("t0"), "still warm");
  assert.equal(storedDraft("t30"), "newest");
});

test("corrupt storage is treated as empty rather than throwing", async () => {
  store.set("web-ui:drafts", "{not json");
  assert.equal(storedDraft("anything"), "");
  saveDraft("web:me:a", "recovers");
  assert.equal(storedDraft("web:me:a"), "recovers");
});

test("a long draft retains its complete text", async () => {
  saveDraft("big", "x".repeat(50_000));
  assert.equal(storedDraft("big"), "x".repeat(50_000));
});

test("the new-chat slot is scoped per user, so accounts on a shared browser don't cross", async () => {
  saveDraft(newChatDraftKey("alice"), "alice's unsent text");
  assert.equal(storedDraft(newChatDraftKey("alice")), "alice's unsent text");
  assert.equal(storedDraft(newChatDraftKey("bob")), "");
  clearDraft(newChatDraftKey("alice"));
  assert.equal(storedDraft(newChatDraftKey("alice")), "");
});

test("a draft intent survives a new tab and changes when the text is edited", async () => {
  saveDraft("web:me:a", "retry me");
  await flushDrafts();
  const revision = draftRevision("web:me:a")!;
  const otherTab = await isolatedDrafts("send-key-reload");
  assert.equal(otherTab.draftRevision("web:me:a"), revision);
  otherTab.saveDraft("web:me:a", "new message");
  assert.notEqual(otherTab.draftRevision("web:me:a"), revision);
  clearAllDrafts();
  assert.equal(otherTab.draftRevision("web:me:a"), null);
});

test("signing in again on the same page adopts the new draft epoch", async () => {
  saveDraft("web:me:old", "old account text");
  const otherTab = await isolatedDrafts("remote-signout-then-signin");
  otherTab.clearAllDrafts();
  saveDraft("web:me:blocked", "cannot save while signed out");
  assert.equal(storedDraft("web:me:blocked"), "");
  resumeDraftsAfterSignIn("alice");
  saveDraft("web:me:new", "new account text");
  await flushDrafts();
  assert.equal(storedDraft("web:me:old"), "");
  assert.equal(storedDraft("web:me:new"), "new account text");
  assert.ok(draftRevision("web:me:new"));
});

test("sign-out wipes every stored draft", async () => {
  saveDraft("web:me:a", "private half-thought");
  saveDraft(newChatDraftKey("me"), "more private text");
  clearAllDrafts();
  assert.equal(storedDraft("web:me:a"), "");
  assert.equal(storedDraft(newChatDraftKey("me")), "");
});

test("keystroke saves are read-your-writes but the storage write is debounced", async () => {
  saveDraft("web:me:hot", "typed fast");
  assert.equal(storedDraft("web:me:hot"), "typed fast");
  assert.equal(store.get("web-ui:drafts"), "[]", "only an empty compatibility marker is written synchronously");
  await flushDrafts();
  assert.match(store.get("web-ui:drafts") ?? "", /typed fast/, "flush lands the pending draft");
});

test("pagehide keeps the last edit recoverable while the shared-array lock is queued", async () => {
  let releaseLock: (() => void) | undefined;
  lockQueues.set("web-ui:drafts", new Promise<void>((resolve) => (releaseLock = resolve)));
  const listeners = new Map<string, (event?: StorageEvent) => void>();
  const oldWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const oldDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      addEventListener: (name: string, listener: (event?: StorageEvent) => void) => listeners.set(name, listener),
    },
  });
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: {
      addEventListener: (name: string, listener: (event?: StorageEvent) => void) => listeners.set(name, listener),
    },
  });
  let pendingWrite: Promise<void> | undefined;
  try {
    const tab = await isolatedDrafts("queued-pagehide");
    tab.saveDraft("web:me:a", "last keystroke");
    const revision = tab.draftRevision("web:me:a");
    listeners.get("pagehide")!();
    pendingWrite = tab.flushDrafts();
    assert.equal(store.get("web-ui:drafts"), "[]");
    assert.equal(tab.draftPersisted("web:me:a", revision), true);
    const reloaded = await isolatedDrafts("queued-pagehide-reload");
    assert.equal(reloaded.storedDraft("web:me:a"), "last keystroke");
    store.set("web-ui:drafts", JSON.stringify([["web:me:a", "stale old tab"]]));
    assert.equal(reloaded.storedDraft("web:me:a"), "last keystroke");
    const oldValue = store.get("web-ui:drafts")!;
    store.delete("web-ui:drafts");
    listeners.get("storage")!({ key: "web-ui:drafts", oldValue, newValue: null } as unknown as StorageEvent);
    assert.equal(reloaded.storedDraft("web:me:a"), "");
  } finally {
    releaseLock?.();
    await pendingWrite;
    if (oldWindow) Object.defineProperty(globalThis, "window", oldWindow);
    else delete (globalThis as { window?: unknown }).window;
    if (oldDocument) Object.defineProperty(globalThis, "document", oldDocument);
    else delete (globalThis as { document?: unknown }).document;
  }
});

test("tabs without Web Locks preserve unrelated drafts through their journals", async () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: {} });
  try {
    const first = await isolatedDrafts("no-lock-first");
    const second = await isolatedDrafts("no-lock-second");
    first.saveDraft("web:me:a", "from first tab");
    second.saveDraft("web:me:b", "from second tab");
    await Promise.all([first.flushDrafts(), second.flushDrafts()]);
    assert.equal(first.storedDraft("web:me:a"), "from first tab");
    assert.equal(first.storedDraft("web:me:b"), "from second tab");
  } finally {
    if (previous) Object.defineProperty(globalThis, "navigator", previous);
    else delete (globalThis as { navigator?: unknown }).navigator;
  }
});

test("a delayed locked tab cannot overwrite a newer edit after its journal was committed", async () => {
  const first = await isolatedDrafts("locked-delay-first");
  const second = await isolatedDrafts("locked-delay-second");
  first.saveDraft("web:me:a", "older edit");
  second.saveDraft("web:me:a", "newer edit");
  await second.flushDrafts();
  await first.flushDrafts();
  assert.equal(first.storedDraft("web:me:a"), "newer edit");
  assert.equal(second.storedDraft("web:me:a"), "newer edit");
  assert.ok(lockRequests >= 2);
});

test("an old-version tab can edit and clear a committed draft without Web Locks", async () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: {} });
  try {
    store.clear();
    const upgradedTab = await isolatedDrafts("no-lock-old-version");
    upgradedTab.saveDraft("web:me:a", "new tab draft");
    await upgradedTab.flushDrafts();
    store.set("web-ui:drafts", JSON.stringify([["web:me:a", "old tab edit"]]));
    assert.equal(upgradedTab.storedDraft("web:me:a"), "old tab edit");
    upgradedTab.saveDraft("web:me:b", "another new tab draft");
    await upgradedTab.flushDrafts();
    assert.equal(upgradedTab.storedDraft("web:me:a"), "old tab edit");
    store.set("web-ui:drafts", "[]");
    assert.equal(upgradedTab.storedDraft("web:me:a"), "");
    assert.equal(upgradedTab.storedDraft("web:me:b"), "");
    const reloadedTab = await isolatedDrafts("no-lock-old-version-reload");
    assert.equal(reloadedTab.storedDraft("web:me:a"), "");
    assert.equal(reloadedTab.storedDraft("web:me:b"), "");
  } finally {
    if (previous) Object.defineProperty(globalThis, "navigator", previous);
    else delete (globalThis as { navigator?: unknown }).navigator;
  }
});

test("failed local writes are reported before a draft is sent", async () => {
  failDraftWrites = true;
  saveDraft("web:me:a", "unsent text");
  const revision = draftRevision("web:me:a");
  await flushDrafts();
  assert.equal(draftPersisted("web:me:a", revision), false);
  failDraftWrites = false;
  await flushDrafts();
  assert.equal(draftPersisted("web:me:a", revision), true);
});

test("another writer's storage update wins over a stale cache once flushed", async () => {
  saveDraft("web:me:tab1", "mine");
  await flushDrafts();
  store.set(
    "web-ui:drafts",
    JSON.stringify([["web:me:tab2", "other tab", "tab2-revision", store.get("web-ui:drafts-epoch")]]),
  );
  assert.equal(storedDraft("web:me:tab2"), "other tab");
});

test("a send acknowledgement clears only the draft it submitted", async () => {
  saveDraft("web:me:a", "first");
  const generation = draftGeneration();
  const firstRevision = draftRevision("web:me:a");
  saveDraft("web:me:a", "new work");
  await clearDraftIfMatches("web:me:a", "first", generation, firstRevision);
  assert.equal(storedDraft("web:me:a"), "new work");
  await clearDraftIfMatches("web:me:a", "new work", generation, draftRevision("web:me:a"));
  assert.equal(storedDraft("web:me:a"), "");
});

test("an acknowledgement cannot clear a draft written after sign-out", async () => {
  saveDraft("web:me:a", "same text");
  const oldGeneration = draftGeneration();
  const oldRevision = draftRevision("web:me:a");
  clearAllDrafts();
  resumeDraftsAfterSignIn("alice");
  saveDraft("web:me:a", "same text");
  await clearDraftIfMatches("web:me:a", "same text", oldGeneration, oldRevision);
  assert.equal(storedDraft("web:me:a"), "same text");
});

test("a successful long send clears its capped local draft copy", async () => {
  const text = "x".repeat(25_000);
  const generation = draftGeneration();
  saveDraft("web:me:a", text);
  await clearDraftIfMatches("web:me:a", text, generation, draftRevision("web:me:a"));
  assert.equal(storedDraft("web:me:a"), "");
});

test("a late acknowledgement leaves a newer identical draft in another tab", async () => {
  saveDraft("web:me:a", "same text");
  await flushDrafts();
  const generation = draftGeneration();
  const revision = draftRevision("web:me:a");
  const otherTab = await isolatedDrafts("independent-aba");
  otherTab.saveDraft("web:me:a", "same text");
  await otherTab.flushDrafts();
  await clearDraftIfMatches("web:me:a", "same text", generation, revision);
  assert.equal(storedDraft("web:me:a"), "same text");
  assert.equal(draftRevision("web:me:a"), otherTab.draftRevision("web:me:a"));
  assert.notEqual(draftRevision("web:me:a"), revision);
});

test("a late acknowledgement cannot erase an edit the other tab has not flushed to the shared array", async () => {
  saveDraft("web:me:a", "first send");
  await flushDrafts();
  const generation = draftGeneration();
  const revision = draftRevision("web:me:a");
  const otherTab = await isolatedDrafts("unflushed-newer-edit");
  otherTab.saveDraft("web:me:a", "newer local edit");
  await clearDraftIfMatches("web:me:a", "first send", generation, revision);
  assert.equal(storedDraft("web:me:a"), "newer local edit");
  await otherTab.flushDrafts();
  assert.equal(storedDraft("web:me:a"), "newer local edit");
});

test("another tab's sign-out prevents a pending write from restoring private text", async () => {
  saveDraft("web:me:a", "private thought");
  const otherTab = await isolatedDrafts("independent-signout");
  otherTab.clearAllDrafts();
  await flushDrafts();
  assert.equal(storedDraft("web:me:a"), "");
  saveDraft("web:me:a", "late old-tab edit");
  assert.equal(storedDraft("web:me:a"), "");
  assert.equal(store.has("web-ui:drafts"), false);
});

test("a late write from an old tab remains unreadable after sign-out", async () => {
  saveDraft("web:me:a", "private thought");
  await flushDrafts();
  const oldRaw = store.get("web-ui:drafts")!;
  clearAllDrafts();
  store.set("web-ui:drafts", oldRaw);
  assert.equal(storedDraft("web:me:a"), "");
});

test("the new draft format remains readable and writable by an old tab before sign-out", async () => {
  store.clear();
  const upgradedTab = await isolatedDrafts("mixed-version");
  upgradedTab.saveDraft("web:me:new", "new tab draft");
  await upgradedTab.flushDrafts();
  const oldTab = new Map<string, string>(
    (JSON.parse(store.get("web-ui:drafts") ?? "[]") as unknown[][])
      .filter((pair): pair is [string, string] => typeof pair[0] === "string" && typeof pair[1] === "string")
      .map(([key, value]) => [key, value]),
  );
  assert.equal(oldTab.get("web:me:new"), "new tab draft");
  oldTab.set("web:me:old", "old tab draft");
  store.set("web-ui:drafts", JSON.stringify([...oldTab]));
  assert.equal(upgradedTab.storedDraft("web:me:old"), "old tab draft");
  assert.equal(upgradedTab.storedDraft("web:me:new"), "new tab draft");
  const migratedRevision = upgradedTab.draftRevision("web:me:old");
  assert.ok(migratedRevision);
  await upgradedTab.clearDraftIfMatches("web:me:old", "old tab draft", upgradedTab.draftGeneration(), migratedRevision);
  assert.equal(upgradedTab.storedDraft("web:me:old"), "");
  assert.equal(upgradedTab.storedDraft("web:me:new"), "new tab draft");
});

test("an old-version tab can edit and clear a draft after the new write is acknowledged", async () => {
  store.clear();
  const upgradedTab = await isolatedDrafts("old-edit-after-ack");
  upgradedTab.saveDraft("web:me:a", "new tab draft");
  await upgradedTab.flushDrafts();
  assert.equal(upgradedTab.storedDraft("web:me:a"), "new tab draft");
  store.set("web-ui:drafts", JSON.stringify([["web:me:a", "old tab edit"]]));
  assert.equal(upgradedTab.storedDraft("web:me:a"), "old tab edit");
  store.set("web-ui:drafts", "[]");
  assert.equal(upgradedTab.storedDraft("web:me:a"), "");
});

test("an old tab cannot hide new-epoch drafts or restore signed-out text", async () => {
  const upgradedTab = await isolatedDrafts("post-signout-old-writer");
  upgradedTab.saveDraft("web:me:fresh", "written after sign-in");
  await upgradedTab.flushDrafts();
  store.set(
    "web-ui:drafts",
    JSON.stringify([
      ["web:me:old", "private before sign-out"],
      ["web:me:fresh", "old snapshot"],
    ]),
  );
  assert.equal(upgradedTab.storedDraft("web:me:fresh"), "written after sign-in");
  assert.equal(upgradedTab.storedDraft("web:me:old"), "");
  upgradedTab.saveDraft("web:me:next", "another new draft");
  await upgradedTab.flushDrafts();
  store.set("web-ui:drafts", "[]");
  assert.equal(upgradedTab.storedDraft("web:me:fresh"), "written after sign-in");
  assert.equal(upgradedTab.storedDraft("web:me:next"), "another new draft");
  assert.equal(upgradedTab.storedDraft("web:me:old"), "");
});

test("sign-out retries epoch rotation after reclaiming draft storage", async () => {
  const oldTab = await isolatedDrafts("quota-signout-old-tab");
  oldTab.saveDraft("web:me:private", "private before sign-out");
  await oldTab.flushDrafts();
  const formerEpoch = store.get("web-ui:drafts-epoch");
  failEpochWrites = 1;
  assert.equal(clearAllDrafts(), true);
  assert.notEqual(store.get("web-ui:drafts-epoch"), formerEpoch);
  oldTab.saveDraft("web:me:late", "private before sign-out");
  await oldTab.flushDrafts();
  assert.equal(storedDraft("web:me:private"), "");
  assert.equal(storedDraft("web:me:late"), "");
});

test("sign-out fails closed when a durable epoch cannot be written", async () => {
  saveDraft("web:me:private", "private before sign-out");
  await flushDrafts();
  failEpochWrites = 2;
  assert.equal(clearAllDrafts(), false);
  assert.equal(storedDraft("web:me:private"), "");
  saveDraft("web:me:late", "private after failed sign-out");
  assert.equal(storedDraft("web:me:late"), "");
  failEpochWrites = 0;
  assert.equal(clearAllDrafts(), true);
  assert.equal(storedDraft("web:me:private"), "");
});

test("a racing journal writer removes private text after another tab signs out", async () => {
  const otherTab = await isolatedDrafts("journal-race-signout");
  beforeJournalWrite = () => otherTab.clearAllDrafts();
  saveDraft("web:me:private", "private before sign-out");
  await flushDrafts();
  assert.equal(storedDraft("web:me:private"), "");
  assert.equal(
    [...store.entries()].filter(
      ([key, value]) => key.startsWith("web-ui:draft-journal:") && value.includes("private before sign-out"),
    ).length,
    0,
  );
});

test("saving a blank value for a missing draft does not create a tombstone", async () => {
  for (let index = 0; index < 100; index++) saveDraft(`web:me:missing-${index}`, "");
  await flushDrafts();
  assert.equal([...store.keys()].filter((key) => key.startsWith("web-ui:draft-journal:")).length, 0);
});

test("committed journals stay bounded while old-version overwrites cannot erase recent drafts", async () => {
  for (let index = 0; index < 100; index++) {
    saveDraft(`web:me:${index}`, "x".repeat(20_000));
    await flushDrafts();
  }
  const journals = [...store.keys()].filter((key) => key.startsWith("web-ui:draft-journal:"));
  assert.ok(journals.length <= 30, `retained ${journals.length} journals`);
  store.set("web-ui:drafts", "[]");
  assert.equal(storedDraft("web:me:99"), "x".repeat(20_000));
  assert.equal(storedDraft("web:me:0"), "");
});

test("a clock rollback cannot evict a newly saved draft from another tab", async () => {
  const originalNow = Date.now;
  try {
    Date.now = () => 2_000_000_000_000;
    for (let index = 0; index < 30; index++) saveDraft(`web:me:${index}`, `draft ${index}`);
    await flushDrafts();
    Date.now = () => 1_000_000_000_000;
    const newTab = await isolatedDrafts("clock-rollback-new-tab");
    newTab.saveDraft("web:me:fresh", "new after clock rollback");
    assert.equal(newTab.storedDraft("web:me:fresh"), "new after clock rollback");
    await newTab.flushDrafts();
    assert.equal(storedDraft("web:me:fresh"), "new after clock rollback");
  } finally {
    Date.now = originalNow;
  }
});

test("a later same-text save survives an earlier conditional clear", async () => {
  saveDraft("web:me:a", "same text");
  await flushDrafts();
  const generation = draftGeneration();
  const revision = draftRevision("web:me:a");
  await clearDraftIfMatches("web:me:a", "same text", generation, revision);
  const otherTab = await isolatedDrafts("after-clear");
  otherTab.saveDraft("web:me:a", "same text");
  await otherTab.flushDrafts();
  await flushDrafts();
  assert.equal(storedDraft("web:me:a"), "same text");
  assert.equal(draftRevision("web:me:a"), otherTab.draftRevision("web:me:a"));
});

test("a sign-out between persistence validation and write removes the late private write", async () => {
  const otherTab = await isolatedDrafts("interleaved-signout");
  saveDraft("web:me:a", "private thought");
  beforeDraftWrite = () => otherTab.clearAllDrafts();
  await flushDrafts();
  assert.equal(store.has("web-ui:drafts"), false);
  assert.equal(storedDraft("web:me:a"), "");
});

test("a newer revision arriving between local clear and persistence is retained", async () => {
  saveDraft("web:me:a", "same text");
  await flushDrafts();
  const generation = draftGeneration();
  const revision = draftRevision("web:me:a");
  const otherTab = await isolatedDrafts("during-clear");
  let otherWrite: Promise<void> | null = null;
  draftReadsUntilHook = 2;
  beforeDraftRead = () => {
    otherTab.saveDraft("web:me:a", "same text");
    otherWrite = otherTab.flushDrafts();
  };
  await clearDraftIfMatches("web:me:a", "same text", generation, revision);
  if (otherWrite) await otherWrite;
  assert.ok(lockRequests >= 2);
  assert.equal(storedDraft("web:me:a"), "same text");
  assert.equal(draftRevision("web:me:a"), otherTab.draftRevision("web:me:a"));
});

test("a pending local edit merges with another tab's unrelated draft", async () => {
  const otherTab = await isolatedDrafts("parallel-keys");
  saveDraft("web:me:a", "my edit");
  otherTab.saveDraft("web:me:b", "their edit");
  await otherTab.flushDrafts();
  await flushDrafts();
  assert.equal(storedDraft("web:me:a"), "my edit");
  assert.equal(storedDraft("web:me:b"), "their edit");
});
