import { createChatSurface } from "./chat";
import { createComposerSurface, type ComposerOptions } from "./composer";
import { densityTierFor, type DensityTier } from "./density";
import { subscribeDeliveries, withBase } from "./core-bridge";
import { messageLocation } from "./message-location";
import { createNotificationCenter, type NotificationPage } from "./notification-center";
import { closeNotificationResult, openNotificationResult } from "./notification-result";
import { applySessionState } from "./session-list";
import { openSession, refreshSessions, renderList, sessionsState } from "./sessions";
import { blockUnsentAttachmentNavigation } from "./shell";
import { openAnnouncementById, refreshAnnouncements } from "./banner";
import { ensureContexts, openProjectDetail } from "./contexts";
import { appState } from "./shell-state";
import type { Conversation, ConvCtx, ConvHost } from "./conv-types";

const live = new Set<Conversation>();
let main: Conversation | null = null;

let notifications: ReturnType<typeof createNotificationCenter> | undefined;
const NO_THREADS: ReadonlySet<string> = new Set();
const ANNOUNCEMENT_PREFIX = "announcement:";
const PROJECT_JOIN_PREFIX = "project-join:";

export function unreadThreadRefs(): ReadonlySet<string> {
  return notifications?.unreadThreads() ?? NO_THREADS;
}

function notificationCenter() {
  return (notifications ??= createNotificationCenter({
    scope: appState.me ? JSON.stringify([appState.me.org, appState.me.user]) : undefined,
    readOnly: Boolean(appState.me?.impersonatedBy),
    async load(cursor) {
      const query = cursor ? `?cursor=${encodeURIComponent(cursor)}` : "";
      const response = await fetch(withBase(`/api/notifications${query}`));
      if (!response.ok) throw new Error("notification load failed");
      const page = (await response.json()) as NotificationPage;
      let deadline: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          Promise.allSettled(refreshingConversations),
          new Promise<void>((resolve) => {
            deadline = setTimeout(resolve, 1500);
          }),
        ]);
      } finally {
        clearTimeout(deadline);
      }
      return page;
    },
    async read(id) {
      if (appState.me?.impersonatedBy) return;
      const response = await fetch(withBase(`/api/notifications/${encodeURIComponent(id)}/read`), { method: "POST" });
      if (!response.ok) throw new Error("notification read failed");
      if (id.startsWith(ANNOUNCEMENT_PREFIX)) void refreshAnnouncements();
    },
    preferences: {
      async load() {
        const response = await fetch(withBase("/api/notification-preferences"));
        if (!response.ok) throw new Error("notification preferences failed");
        return (await response.json()) as { muteCompletions: boolean };
      },
      async save(preferences) {
        const response = await fetch(withBase("/api/notification-preferences"), {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(preferences),
        });
        if (!response.ok) throw new Error("notification preferences failed");
      },
    },
    async readAll() {
      const response = await fetch(withBase("/api/notifications/read-all"), { method: "POST" });
      if (!response.ok) throw new Error("notification read failed");
      void refreshAnnouncements();
    },
    changed: renderList,
    visible(item) {
      if (document.visibilityState === "hidden" || !document.hasFocus()) return false;
      if (item.kind === "done")
        return [...live].some((conv) => conv.mountedThreadRef() === item.threadRef && conv.isVisible());
      const location = messageLocation(item);
      if (!location) return false;
      return [...live].some((conv) => {
        if (conv.mountedThreadRef() !== item.threadRef || !conv.isVisible()) return false;
        const scroller = conv.state.host?.querySelector<HTMLElement>(".chat-scroll");
        if (!scroller) return false;
        const row = [...scroller.querySelectorAll<HTMLElement>(".message-row")].find(
          (entry) => entry.dataset.messageLocation === location,
        );
        if (!row) return false;
        const bounds = scroller.getBoundingClientRect();
        const rect = row.getBoundingClientRect();
        return (
          rect.height > 0 &&
          rect.bottom > Math.max(0, bounds.top) &&
          rect.top < Math.min(window.innerHeight, bounds.bottom)
        );
      });
    },
    async navigate(threadRef, target, signal) {
      if (threadRef.startsWith(ANNOUNCEMENT_PREFIX))
        return openAnnouncementById(threadRef.slice(ANNOUNCEMENT_PREFIX.length));
      if (threadRef.startsWith(PROJECT_JOIN_PREFIX)) {
        const scopeId = (target as { scopeId?: string }).scopeId;
        if (!scopeId || blockUnsentAttachmentNavigation()) return false;
        await ensureContexts(true);
        openProjectDetail(scopeId);
        return true;
      }
      if (target.deliveryId) return openNotificationResult(threadRef, target.deliveryId, signal);
      if (blockUnsentAttachmentNavigation()) return false;
      const before = sessionsState.openGeneration;
      const view = appState.viewRenderSeq;
      let session = sessionsState.list.find((s) => s.threadRef === threadRef);
      if (!session) {
        await refreshSessions({ silent: true });
        if (sessionsState.openGeneration !== before || appState.viewRenderSeq !== view) return false;
        session = sessionsState.list.find((s) => s.threadRef === threadRef);
      }
      if (!session) return false;
      const opening = openSession(session);
      const generation = sessionsState.openGeneration;
      await opening;
      for (let attempt = 0; attempt < 100; attempt++) {
        if (signal?.aborted || sessionsState.openGeneration !== generation || appState.currentView !== "chats")
          return false;
        const conv = [...live].find((c) => c.mountedThreadRef() === threadRef && c.isVisible());
        if (conv?.state.host?.querySelector(".chat-scroll")) return conv.showLatestMessages(target, signal);
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      return false;
    },
  }));
}

export function mountNotifications(container: HTMLElement): void {
  notificationCenter().mount(container);
}

export function createConversation(host: ConvHost, composerOptions?: ComposerOptions): Conversation {
  const ctx = { ...host } as ConvCtx;
  ctx.chat = createChatSurface(ctx);
  ctx.composer = createComposerSurface(ctx, composerOptions);
  const conv = ctx.chat as Conversation;
  conv.composer = ctx.composer;
  live.add(conv);
  return conv;
}

export function disposeConversation(conv: Conversation): void {
  live.delete(conv);
  if (main === conv) main = null;
  conv.composer.dispose();
  conv.dispose();
}

export function allConversations(): Conversation[] {
  return [...live];
}

export function isLiveConversation(conv: Conversation): boolean {
  return live.has(conv);
}

export function mainConversation(): Conversation {
  main ??= createConversation({
    pane: false,
    ownsUrl: true,
    container: () => appState.mainEl,
    claimContainer: () => {
      exitCanvas();
      return appState.mainEl;
    },
    visible: () => appState.currentView === "chats",
    density: () => "full" as DensityTier,
    onDensityChange: () => {},
    ensureDeliveryStream,
  });
  return main;
}

export function paneDensity(el: HTMLElement): DensityTier | null {
  const r = el.getBoundingClientRect();
  const width = r.width || el.clientWidth;
  const height = r.height || el.clientHeight;
  return width > 0 && height > 0 ? densityTierFor(width, height) : null;
}

let exitCanvas: () => void = () => {};

export function onExitCanvas(fn: () => void): void {
  exitCanvas = fn;
}

let inboxItemHandler: ((event: { loopId: string; itemId: string; op: string }) => void) | null = null;

export function onInboxItemEvent(fn: (event: { loopId: string; itemId: string; op: string }) => void): void {
  inboxItemHandler = fn;
}

let inboxResyncHandler: (() => void) | null = null;

export function onInboxResync(fn: () => void): void {
  inboxResyncHandler = fn;
}

const refreshingConversations = new Set<Promise<void>>();

function refreshConversation(conv: Conversation, threadRef: string): Promise<void> {
  const pending = conv.onDelivery(threadRef);
  refreshingConversations.add(pending);
  const done = () => {
    refreshingConversations.delete(pending);
  };
  void pending.then(done, done);
  return pending;
}

function refreshMountedConversations(includeStreaming: boolean): Promise<unknown> {
  return Promise.allSettled(
    [...live].map((conv) => {
      const threadRef = conv.mountedThreadRef();
      if (!threadRef || (!includeStreaming && conv.state.agent?.state.isStreaming)) return Promise.resolve();
      return refreshConversation(conv, threadRef);
    }),
  );
}

let deliveryStreamOpen = false;
let closeDeliveryStream: (() => void) | undefined;
let deliveryTimer: ReturnType<typeof setInterval> | undefined;

function onDeliveryVisibility(): void {
  if (document.visibilityState !== "visible") return;
  for (const conv of live) conv.resumeIfIdle();
  void refreshMountedConversations(true);
}

export function resetNotifications(): void {
  closeNotificationResult();
  refreshingConversations.clear();
  closeDeliveryStream?.();
  closeDeliveryStream = undefined;
  deliveryStreamOpen = false;
  clearInterval(deliveryTimer);
  deliveryTimer = undefined;
  document.removeEventListener("visibilitychange", onDeliveryVisibility);
  notifications?.dispose();
  notifications = undefined;
}

export function ensureDeliveryStream(): void {
  if (deliveryStreamOpen) return;
  deliveryStreamOpen = true;
  const center = notificationCenter();
  center.start();
  closeDeliveryStream = subscribeDeliveries(
    (threadRef) => {
      void refreshSessions({ silent: true });
      void Promise.allSettled([...live].map((conv) => refreshConversation(conv, threadRef))).then(() =>
        center.refresh(),
      );
    },
    (event) => {
      if (event.state === "metadata") {
        void refreshSessions({ silent: true });
        return;
      }
      const { list, matched } = applySessionState(sessionsState.list, { ...event, state: event.state });
      if (matched) {
        sessionsState.list = list;
        renderList();
        const parentId = list.find((session) => session.threadRef === event.threadRef)?.parentSessionId;
        if (parentId) for (const conv of live) if (conv.state.sessionId === parentId) conv.redraw();
      } else {
        void refreshSessions({ silent: true });
      }
      if (event.state === "idle" && matched) void refreshSessions({ silent: true });
      if (event.state === "working") for (const conv of live) conv.resumeIfIdle();
      else for (const conv of live) void refreshConversation(conv, event.threadRef);
    },
    () => {
      void refreshSessions({ silent: true });
      void refreshMountedConversations(true).then(() => center.refresh());
    },
    (event) => inboxItemHandler?.(event),
    () => inboxResyncHandler?.(),
  );
  document.addEventListener("visibilitychange", onDeliveryVisibility);
  deliveryTimer = setInterval(() => {
    if (document.visibilityState !== "visible") return;
    void refreshSessions({ silent: true });
    void refreshMountedConversations(false);
  }, 15000);
  (deliveryTimer as { unref?: () => void }).unref?.();
}
