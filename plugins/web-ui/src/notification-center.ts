import { brandName } from "./brand-name.ts";
import type { MessageLocation } from "./message-location.ts";
import { createMentionToast, type AlertKind } from "./mention-toast.ts";

export interface MessageNotification extends MessageLocation {
  id: string;
  sessionId: string;
  threadRef: string;
  title: string;
  at: number;
  kind: "message" | "mention" | "reply" | "done" | "announcement" | "added";
  unread?: boolean;
  scopeId?: string;
  unreadCount: number;
}

const KIND_LABEL: Record<MessageNotification["kind"], string> = {
  message: "Colleague message",
  mention: "Mentioned you",
  reply: "New reply",
  done: "Task finished",
  announcement: "Notice",
  added: "Added to a project",
};

type Alert = MessageNotification & { kind: AlertKind };

function unreadItems(items: readonly MessageNotification[]): MessageNotification[] {
  return items.filter((item) => item.unread !== false);
}

export interface NotificationPage {
  items: MessageNotification[];
  unreadCount: number;
  unreadThreads: number;
  nextCursor?: string;
}

interface NotificationActions {
  scope?: string;
  load(cursor?: string): Promise<NotificationPage>;
  read(id: string): Promise<void>;
  readAll(): Promise<void>;
  preferences: {
    load(): Promise<{ muteCompletions: boolean }>;
    save(preferences: { muteCompletions: boolean }): Promise<void>;
  };
  navigate(threadRef: string, target: MessageLocation, signal?: AbortSignal): Promise<boolean>;
  visible(item: MessageNotification): boolean;
  changed?(): void;
  readOnly?: boolean;
}

const BELL =
  '<svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" stroke-width="1.65" aria-hidden="true"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9"/><path d="M10 21h4"/></svg>';

export function createNotificationCenter(actions: NotificationActions) {
  const triggers = new Set<HTMLButtonElement>();
  const panel = document.createElement("section");
  panel.className = "notification-center";
  panel.id = "notification-center";
  panel.hidden = true;
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-modal", "false");
  panel.setAttribute("aria-label", "New messages");
  const header = document.createElement("header");
  const heading = document.createElement("h2");
  heading.textContent = "New messages";
  const close = document.createElement("button");
  close.type = "button";
  close.className = "notification-close";
  close.textContent = "×";
  close.setAttribute("aria-label", "Close messages panel");
  const readAll = document.createElement("button");
  readAll.type = "button";
  readAll.className = "notification-read-all";
  readAll.textContent = "Mark all as read";
  header.append(heading, readAll, close);
  const status = document.createElement("p");
  status.className = "notification-status";
  status.setAttribute("role", "status");
  const list = document.createElement("div");
  list.className = "notification-list";
  const footer = document.createElement("footer");
  const retry = document.createElement("button");
  retry.type = "button";
  retry.textContent = "Check again";
  const more = document.createElement("button");
  more.type = "button";
  more.textContent = "Load more";
  more.hidden = true;
  footer.append(retry, more);
  const desktopButton = document.createElement("button");
  desktopButton.type = "button";
  desktopButton.className = "notification-desktop";
  const muteButton = document.createElement("button");
  muteButton.type = "button";
  muteButton.className = "notification-desktop notification-mute";
  muteButton.hidden = actions.readOnly === true;
  panel.append(header, desktopButton, muteButton, status, list, footer);
  document.body.append(panel);
  const toast = createMentionToast(actions.navigate);
  let page: NotificationPage = { items: [], unreadCount: 0, unreadThreads: 0 };
  let unread: ReadonlySet<string> = new Set();
  let error = "";
  let active: HTMLButtonElement | null = null;
  let pending: Promise<void> | null = null;
  let timer: ReturnType<typeof setInterval> | undefined;
  let disposed = false;
  let opening = false;
  let loadedPages = 1;
  let renderedItems = "";
  const announced = new Map<string, string>();
  const baseTitle = document.title;
  const desktopKey = `coworker:desktop:${actions.scope ?? ""}`;
  const desktopSupported = !!actions.scope && "Notification" in window;
  const desktopOpen = new Set<Notification>();
  let desktopEnabled = false;
  let desktopError = "";
  try {
    desktopEnabled = localStorage.getItem(desktopKey) === "1";
  } catch {
    void 0;
  }

  let muteCompletions = false;
  let muteError = "";
  const isCompletion = (item: MessageNotification) => item.kind === "done" || item.kind === "reply";
  function muteLabel() {
    muteButton.setAttribute("aria-pressed", String(muteCompletions));
    muteButton.textContent =
      muteError ||
      (muteCompletions
        ? "Task alerts muted · finished tasks still appear in this list · click to turn on"
        : "Task alerts on · click to mute pop-ups for finished tasks");
  }
  muteButton.onclick = async () => {
    const next = !muteCompletions;
    try {
      await actions.preferences.save({ muteCompletions: next });
      if (disposed) return;
      muteCompletions = next;
      muteError = "";
      toast.retain(new Set(alerting(page.items).map((item) => item.threadRef)));
    } catch {
      muteError = "Could not save this setting. Try again later.";
    }
    muteLabel();
  };
  void actions.preferences
    .load()
    .then((saved) => {
      muteCompletions = saved.muteCompletions;
      muteLabel();
    })
    .catch(() => muteLabel());
  muteLabel();

  function desktopLabel() {
    desktopButton.disabled = !desktopSupported || Notification.permission === "denied";
    let label = "Turn on desktop alerts (works when you switch tabs)";
    if (!desktopSupported) label = "This browser does not support desktop alerts. Unread messages stay here";
    else if (Notification.permission === "denied") label = "Desktop alerts are blocked. Allow them in site settings";
    else if (desktopEnabled && Notification.permission === "granted") label = "Desktop alerts on · click to turn off";
    if (desktopError) label = desktopError;
    desktopButton.textContent = label;
  }
  desktopButton.onclick = async () => {
    if (!desktopSupported) return;
    try {
      desktopError = "";
      if (desktopEnabled && Notification.permission === "granted") desktopEnabled = false;
      else desktopEnabled = (await Notification.requestPermission()) === "granted";
      if (disposed) return;
      localStorage.setItem(desktopKey, desktopEnabled ? "1" : "0");
      desktopLabel();
      void refresh();
    } catch {
      desktopEnabled = false;
      desktopError = "Could not save desktop alert settings. Check browser storage and retry. Unread is kept";
      desktopLabel();
    }
  };
  async function notifyDesktop(item: MessageNotification) {
    if (
      !desktopSupported ||
      !desktopEnabled ||
      Notification.permission !== "granted" ||
      document.visibilityState !== "hidden"
    )
      return;
    const announce = async () => {
      if (disposed || localStorage.getItem(desktopKey) !== "1" || document.visibilityState !== "hidden") return;
      const key = `${desktopKey}:seen`;
      let saved: unknown;
      const stored = localStorage.getItem(key);
      try {
        saved = JSON.parse(stored ?? "[]");
      } catch {
        saved = [];
      }
      const seen = Array.isArray(saved) ? saved.filter((id): id is string => typeof id === "string").slice(-499) : [];
      if (seen.includes(item.id)) return;
      const notification = new Notification(`${brandName()} · ${KIND_LABEL[item.kind]}`, {
        body: `Click to return to ${brandName()}. Unread messages are kept.`,
        tag: `${desktopKey}:${item.id}`,
        requireInteraction: true,
      });
      desktopOpen.add(notification);
      notification.onclose = () => desktopOpen.delete(notification);
      try {
        localStorage.setItem(key, JSON.stringify([...seen, item.id]));
      } catch (error) {
        notification.close();
        throw error;
      }
      notification.onclick = () => {
        notification.close();
        window.focus();
        if (!disposed) void open(item);
      };
    };
    try {
      if (navigator.locks) await navigator.locks.request(desktopKey, announce);
      else await announce();
    } catch {
      desktopEnabled = false;
      desktopError = "Desktop alerts unavailable. Check browser storage and retry. Unread is kept";
      desktopLabel();
    }
  }
  const onStorage = (event: StorageEvent) => {
    if (event.key !== desktopKey) return;
    desktopEnabled = event.newValue === "1";
    desktopError = "";
    desktopLabel();
  };
  desktopLabel();

  function collapse(restoreFocus = false) {
    panel.hidden = true;
    loadedPages = 1;
    for (const trigger of triggers) trigger.setAttribute("aria-expanded", "false");
    if (restoreFocus) active?.focus();
  }

  async function read(item: MessageNotification) {
    if (disposed) return;
    await actions.read(item.id);
  }

  async function open(item: MessageNotification) {
    if (opening) return;
    opening = true;
    panel.setAttribute("aria-busy", "true");
    try {
      if (!(await actions.navigate(item.threadRef, item))) throw new Error("Could not locate the message");
      if (disposed) return;
      if (item.unread !== false) await read(item);
      error = "";
      collapse();
      await refresh();
    } catch {
      error = "Could not open or confirm the message. It stays unread. Try again later.";
      render();
    } finally {
      opening = false;
      panel.removeAttribute("aria-busy");
    }
  }

  function render() {
    if (disposed) return;
    const unreadRows = page.unreadThreads;
    document.title = unreadRows ? `(${unreadRows > 99 ? "99+" : unreadRows} unread) ${baseTitle}` : baseTitle;
    readAll.hidden = unreadRows === 0 || actions.readOnly === true;
    desktopLabel();
    for (const trigger of triggers) {
      const count = trigger.querySelector<HTMLElement>(".notification-count")!;
      count.hidden = unreadRows === 0 && !error;
      const label = unreadRows > 99 ? "99+" : String(unreadRows);
      count.textContent = error ? "!" : label;
      trigger.setAttribute("aria-label", error ? "Messages, offline" : `Messages, ${unreadRows} unread`);
      trigger.title = error || (unreadRows ? `${unreadRows} chats with unread messages` : "New messages");
    }
    status.textContent = error || (unreadRows ? `${unreadRows} chats with unread messages` : "No unread");
    more.hidden = !page.nextCursor;
    const signature = JSON.stringify(page.items);
    if (signature === renderedItems) return;
    renderedItems = signature;
    unread = new Set(unreadItems(page.items).map((item) => item.threadRef));
    actions.changed?.();
    const focused = document.activeElement?.closest<HTMLElement>(".notification-item")?.dataset.notificationId;
    list.replaceChildren();
    for (const item of page.items) {
      const row = document.createElement("article");
      row.className = item.unread === false ? "notification-item read" : "notification-item";
      row.dataset.notificationId = item.id;
      const go = document.createElement("button");
      go.type = "button";
      go.className = "notification-open";
      const meta = document.createElement("span");
      meta.className = "notification-meta";
      meta.textContent =
        item.unread === false ? KIND_LABEL[item.kind] : `${KIND_LABEL[item.kind]} · ${item.unreadCount} unread`;
      const title = document.createElement("strong");
      title.textContent = item.title;
      const time = document.createElement("time");
      time.dateTime = new Date(item.at).toISOString();
      time.textContent = new Date(item.at).toLocaleString("zh-CN", {
        month: "numeric",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      });
      time.title = new Date(item.at).toLocaleString("zh-CN");
      go.append(meta, title, time);
      go.onclick = () => void open(item);
      row.append(go);
      list.append(row);
    }
    if (focused) {
      const row = [...list.querySelectorAll<HTMLElement>(".notification-item")].find(
        (item) => item.dataset.notificationId === focused,
      );
      (row?.querySelector<HTMLButtonElement>("button") ?? close).focus();
    }
    more.hidden = !page.nextCursor;
  }

  function alerting(items: readonly MessageNotification[]): Alert[] {
    return unreadItems(items).filter(
      (item): item is Alert => item.kind !== "announcement" && !(muteCompletions && isCompletion(item)),
    );
  }

  async function sync() {
    try {
      let next = await actions.load();
      for (let index = 1; index < loadedPages && next.nextCursor; index++) {
        const extra = await actions.load(next.nextCursor);
        const current = new Map(next.items.map((item) => [item.sessionId, item]));
        for (const item of extra.items) if (!current.has(item.sessionId)) current.set(item.sessionId, item);
        next = { ...extra, items: [...current.values()] };
      }
      if (disposed) return;
      if (document.visibilityState !== "hidden") {
        const visible = unreadItems(next.items).filter((item) => item.kind !== "announcement" && actions.visible(item));
        for (const item of visible) await read(item);
        if (visible.length) {
          next = await actions.load();
          loadedPages = 1;
        }
      }
      if (disposed) return;
      page = next;
      error = "";
      render();
      if (document.visibilityState === "hidden") {
        for (const item of alerting(page.items).reverse()) await notifyDesktop(item);
        return;
      }
      const keep = new Set(alerting(page.items).map((item) => item.threadRef));
      toast.retain(keep);
      for (const key of announced.keys()) if (!keep.has(key)) announced.delete(key);
      for (const item of alerting(page.items).reverse()) {
        if (announced.get(item.threadRef) === item.id || actions.visible(item)) continue;
        const accepted = toast.notify(
          item.threadRef,
          item.title,
          item,
          async () => {
            await read(item);
            void refresh();
          },
          item.kind,
        );
        if (accepted) announced.set(item.threadRef, item.id);
      }
    } catch {
      if (disposed) return;
      error = "Message alerts are unavailable. Unread records reload once the connection is back.";
      render();
    }
  }

  function refresh(): Promise<void> {
    if (disposed) return Promise.resolve();
    if (pending) return pending;
    pending = sync().finally(() => {
      pending = null;
    });
    return pending;
  }

  const onVisibility = () => {
    if (document.visibilityState !== "hidden") void refresh();
  };
  const onOutside = (event: Event) => {
    const target = event.target as Node | null;
    if (target && !panel.contains(target) && ![...triggers].some((button) => button.contains(target))) collapse();
  };
  const onResize = () => collapse(true);
  const onKey = (event: KeyboardEvent) => {
    if (event.key === "Escape" && !panel.hidden) {
      event.preventDefault();
      collapse(true);
    }
  };
  close.onclick = () => collapse(true);
  readAll.onclick = async () => {
    readAll.disabled = true;
    try {
      await actions.readAll();
      error = "";
      await refresh();
    } catch {
      error = "Could not mark everything as read. Try again later.";
      render();
    } finally {
      readAll.disabled = false;
    }
  };
  retry.onclick = () => void refresh();
  more.onclick = () => {
    const cursor = page.nextCursor;
    if (!cursor || pending) return;
    pending = (async () => {
      try {
        const next = await actions.load(cursor);
        if (disposed) return;
        const current = new Map(page.items.map((item) => [item.sessionId, item]));
        for (const item of next.items) if (!current.has(item.sessionId)) current.set(item.sessionId, item);
        page = { ...next, items: [...current.values()] };
        loadedPages++;
        error = "";
      } catch {
        error = "Could not load more messages. Try again.";
      }
      render();
    })().finally(() => {
      pending = null;
    });
  };
  document.addEventListener("visibilitychange", onVisibility);
  document.addEventListener("pointerdown", onOutside);
  document.addEventListener("keydown", onKey);
  window.addEventListener("online", onVisibility);
  window.addEventListener("storage", onStorage);
  window.addEventListener("resize", onResize);
  return {
    mount(container: HTMLElement) {
      for (const trigger of triggers) if (!trigger.isConnected) triggers.delete(trigger);
      const trigger = document.createElement("button");
      trigger.type = "button";
      trigger.className = "notification-trigger icon-btn subtle";
      trigger.innerHTML = BELL + '<span class="notification-count" hidden></span>';
      trigger.setAttribute("aria-controls", panel.id);
      trigger.setAttribute("aria-haspopup", "dialog");
      trigger.setAttribute("aria-expanded", "false");
      trigger.onclick = () => {
        if (!panel.hidden) {
          collapse(true);
          return;
        }
        active = trigger;
        panel.hidden = false;
        for (const button of triggers) button.setAttribute("aria-expanded", "true");
        const rect = trigger.getBoundingClientRect();
        const width = Math.min(380, window.innerWidth - 24);
        panel.style.left = `${Math.max(12, Math.min(rect.left, window.innerWidth - width - 12))}px`;
        const top = Math.max(12, Math.min(rect.bottom + 10, window.innerHeight - 160));
        panel.style.top = `${top}px`;
        panel.style.setProperty("--notification-top", `${top}px`);
        render();
        close.focus();
        void refresh();
      };
      triggers.add(trigger);
      container.replaceChildren(trigger);
      render();
    },
    start() {
      if (!timer) {
        timer = setInterval(() => void refresh(), 5000);
        (timer as { unref?: () => void }).unref?.();
      }
      void refresh();
    },
    refresh,
    unreadThreads: (): ReadonlySet<string> => unread,
    dispose() {
      disposed = true;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
      document.removeEventListener("pointerdown", onOutside);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("online", onVisibility);
      window.removeEventListener("storage", onStorage);
      for (const notification of desktopOpen) notification.close();
      desktopOpen.clear();
      document.title = baseTitle;
      window.removeEventListener("resize", onResize);
      toast.dispose();
      panel.remove();
      for (const trigger of triggers) trigger.remove();
      triggers.clear();
    },
  };
}
