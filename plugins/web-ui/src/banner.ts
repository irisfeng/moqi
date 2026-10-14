import { appendNotification } from "./notification-region.ts";
import { html, render } from "lit";
import { openAnnouncementReader } from "./announcement-reader.ts";
import { reportHomeEvent } from "./home-config.ts";
import { brandName } from "./brand-name.ts";

export type AnnouncementLevel = "notice" | "maintenance" | "incident";

export interface Announcement {
  id: string;
  level: AnnouncementLevel;
  popup?: boolean;
  title: string;
  body: string;
  startsAt: string;
  endsAt: string | null;
}

export interface AnnouncementsDoc {
  announcements: Announcement[];
  dismissed: string[];
}

export interface ResponseLike {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}

export type FetchLike = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; signal?: AbortSignal },
) => Promise<ResponseLike>;

export const ANNOUNCEMENT_LEVEL_LABEL: Record<AnnouncementLevel, string> = {
  notice: "Notice",
  maintenance: "Maintenance",
  incident: "Incident",
};

const ANNOUNCEMENT_LEVELS: readonly AnnouncementLevel[] = ["notice", "maintenance", "incident"];
const ARCHIVE_CAP = 20;

function coerceLevel(value: unknown): AnnouncementLevel {
  return ANNOUNCEMENT_LEVELS.includes(value as AnnouncementLevel) ? (value as AnnouncementLevel) : "notice";
}

function coerceIso(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    const date = new Date(value);
    return Number.isFinite(date.getTime()) ? date.toISOString() : null;
  }
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function coerceAnnouncement(value: unknown): Announcement | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  if (typeof row.id !== "string" || !row.id.trim()) return null;
  if (typeof row.title !== "string" || !row.title.trim()) return null;
  return {
    id: row.id,
    level: coerceLevel(row.level),
    ...(row.popup === true ? { popup: true } : {}),
    title: row.title,
    body: typeof row.body === "string" ? row.body : "",
    startsAt: coerceIso(row.startsAt) ?? "",
    endsAt: coerceIso(row.endsAt),
  };
}

export function parseAnnouncementsDoc(body: unknown): AnnouncementsDoc | null {
  if (!body || typeof body !== "object") return null;
  const doc = body as Record<string, unknown>;
  if (!Array.isArray(doc.announcements)) return null;
  const announcements = doc.announcements.map(coerceAnnouncement).filter((a): a is Announcement => a !== null);
  const dismissed = Array.isArray(doc.dismissed) ? doc.dismissed.filter((d): d is string => typeof d === "string") : [];
  return { announcements, dismissed };
}

export function announcementActive(a: Announcement, now: Date): boolean {
  const at = now.getTime();
  const start = Date.parse(a.startsAt);
  if (Number.isFinite(start) && start > at) return false;
  if (a.endsAt !== null) {
    const end = Date.parse(a.endsAt);
    if (Number.isFinite(end) && end <= at) return false;
  }
  return true;
}

export interface BannerState {
  doc: AnnouncementsDoc | null;
  localHidden: string[];
  expanded: string[];
}

export function visibleBannerRows(state: BannerState, now: Date): Announcement[] {
  const doc = state.doc;
  if (!doc) return [];
  const hidden = new Set([...doc.dismissed, ...state.localHidden]);
  return doc.announcements.filter((a) => !hidden.has(a.id) && announcementActive(a, now));
}

export function archiveRows(state: BannerState, now: Date): Announcement[] {
  const doc = state.doc;
  if (!doc) return [];
  const visible = new Set(visibleBannerRows(state, now).map((a) => a.id));
  return doc.announcements
    .filter((a) => !visible.has(a.id) && !(Date.parse(a.startsAt) > now.getTime()))
    .sort((a, b) => {
      const aStart = Number.isFinite(Date.parse(a.startsAt)) ? Date.parse(a.startsAt) : 0;
      const bStart = Number.isFinite(Date.parse(b.startsAt)) ? Date.parse(b.startsAt) : 0;
      return bStart - aStart || b.id.localeCompare(a.id);
    })
    .slice(0, ARCHIVE_CAP);
}

export function unseenRows(rows: Announcement[], seen: readonly string[]): Announcement[] {
  const known = new Set(seen);
  return rows.filter((a) => !known.has(a.id));
}

export function shortDate(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  const d = new Date(t);
  return `${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export async function postDismissAnnouncement(id: string, fetchImpl: FetchLike): Promise<boolean> {
  try {
    const res = await fetchImpl(`/api/announcements/${encodeURIComponent(id)}/dismiss`, {
      method: "POST",
      signal: AbortSignal.timeout(10000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

const announcementListeners = new Set<() => void>();

export function subscribeAnnouncements(listener: () => void): () => void {
  announcementListeners.add(listener);
  return () => {
    announcementListeners.delete(listener);
  };
}

const state: BannerState = { doc: null, localHidden: [], expanded: [] };

let bannerUserKey = "";
let bannerFetch: FetchLike = (url, init) => fetch(url, init);
let bannerNow: () => Date = () => new Date();
let bannerStore: Storage | null = null;
let bannerMount: HTMLElement | null = null;
let bannerRefreshing = false;
let bannerFocusBound = false;
let bannerGeneration = 0;
let popupDialog: HTMLDialogElement | null = null;
let popupId: string | null = null;
let popupObserver: MutationObserver | null = null;
let bannerTimer: ReturnType<typeof setTimeout> | undefined;

function seenStorageKey(): string {
  return `web-ui:ann-seen:${bannerUserKey}`;
}

function loadSeen(): string[] {
  try {
    const raw = bannerStore?.getItem(seenStorageKey());
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}

function saveSeen(ids: string[]): void {
  try {
    bannerStore?.setItem(seenStorageKey(), JSON.stringify(ids));
  } catch {
    void 0;
  }
}

export async function openAnnouncementById(id: string): Promise<boolean> {
  const find = (): Announcement | undefined => state.doc?.announcements.find((a) => a.id === id);
  if (!find()) await refreshAnnouncements();
  const announcement = find();
  if (!announcement) return false;
  openAnnouncementReader(announcement);
  return true;
}

export function currentArchiveList(): Announcement[] {
  return archiveRows(state, bannerNow());
}

export function unmountAnnouncementBanner(): void {
  bannerGeneration += 1;
  popupObserver?.disconnect();
  popupObserver = null;
  popupDialog?.close();
  popupDialog = null;
  popupId = null;
  bannerRefreshing = false;
  clearTimeout(bannerTimer);
  bannerMount = null;
  state.doc = null;
  state.localHidden = [];
  document.querySelector(".home-toast-stack")?.remove();
  document.querySelector<HTMLDialogElement>(".announcement-reader")?.close();
}

export function mountAnnouncementBanner(opts: {
  userKey: string;
  mount: HTMLElement | null;
  fetchImpl?: FetchLike;
  now?: () => Date;
  store?: Storage | null;
}): void {
  bannerGeneration += 1;
  popupObserver?.disconnect();
  popupObserver = null;
  popupDialog?.close();
  popupDialog = null;
  popupId = null;
  bannerRefreshing = false;
  state.doc = null;
  state.localHidden = [];
  state.expanded = [];
  clearTimeout(bannerTimer);
  document.querySelector(".home-toast-stack")?.remove();
  document.querySelector<HTMLDialogElement>(".announcement-reader")?.close();
  bannerUserKey = opts.userKey;
  bannerFetch = opts.fetchImpl ?? ((url, init) => fetch(url, init));
  bannerNow = opts.now ?? (() => new Date());
  bannerStore = opts.store ?? (typeof localStorage === "undefined" ? null : localStorage);
  bannerMount = opts.mount;
  if (!bannerFocusBound && typeof window !== "undefined") {
    bannerFocusBound = true;
    window.addEventListener("focus", () => void refreshAnnouncements());
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) void refreshAnnouncements();
    });
  }
  popupObserver = new window.MutationObserver(() => showPendingPopup());
  popupObserver.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["open"] });
  drawBanner();
  void refreshAnnouncements();
}

let bannerRefresh: Promise<void> | null = null;

export function refreshAnnouncements(): Promise<void> {
  if (bannerRefresh) return bannerRefresh;
  bannerRefresh = runAnnouncementRefresh().finally(() => {
    bannerRefresh = null;
  });
  return bannerRefresh;
}

async function runAnnouncementRefresh(): Promise<void> {
  if (bannerRefreshing || !bannerMount) return;
  bannerRefreshing = true;
  const generation = bannerGeneration;
  try {
    const res = await bannerFetch("/api/announcements", { signal: AbortSignal.timeout(10000) });
    if (!res.ok) return;
    const doc = parseAnnouncementsDoc(await res.json());
    if (!doc || generation !== bannerGeneration) return;
    state.doc = { ...doc, dismissed: [...new Set([...doc.dismissed, ...(state.doc?.dismissed ?? [])])] };
    const rows = visibleBannerRows(state, bannerNow());
    const seen = loadSeen();
    const fresh = unseenRows(rows, seen);
    if (fresh.length > 0) {
      saveSeen([...seen, ...fresh.map((a) => a.id)]);
      for (const a of fresh) if (!a.popup) showToast(a);
    }
    drawBanner();
  } catch {
    void 0;
  } finally {
    if (generation === bannerGeneration) {
      bannerRefreshing = false;
      clearTimeout(bannerTimer);
      const now = bannerNow().getTime();
      const boundaries =
        state.doc?.announcements
          .flatMap((a) => [Date.parse(a.startsAt), Date.parse(a.endsAt ?? "")])
          .filter((at) => at > now) ?? [];
      const delay = Math.max(100, Math.min(60000, ...boundaries.map((at) => at - now)));
      bannerTimer = setTimeout(() => {
        drawBanner();
        void refreshAnnouncements();
      }, delay);
    }
  }
}

function drawBanner(): void {
  const mount = bannerMount;
  if (!mount) return;
  const rows = visibleBannerRows(state, bannerNow());
  const active = new Set(rows.map((a) => a.id));
  for (const toast of document.querySelectorAll<HTMLElement>(".home-toast[data-ann-id]")) {
    if (!active.has(toast.dataset.annId ?? "")) toast.remove();
  }
  mount.hidden = rows.length === 0;
  render(html`${rows.map(bannerItem)}`, mount);
  for (const listener of announcementListeners) listener();
  showPendingPopup();
}

function showPendingPopup(): void {
  if (!bannerMount || !state.doc) return;
  const rows = visibleBannerRows(state, bannerNow()).filter((a) => a.popup);
  if (popupDialog) {
    if (rows.some((a) => a.id === popupId)) return;
    popupDialog.close();
    popupDialog = null;
    popupId = null;
  }
  if (document.hidden || document.querySelector("dialog[open], [role=dialog][aria-modal=true]")) return;
  const next = rows[0];
  if (!next) return;
  const generation = bannerGeneration;
  const fetchImpl = bannerFetch;
  popupId = next.id;
  const dialog = openAnnouncementReader(next, {
    onDismiss: async () => {
      if (generation !== bannerGeneration) return false;
      const ok = await postDismissAnnouncement(next.id, fetchImpl);
      if (generation !== bannerGeneration) return false;
      if (ok && state.doc) {
        state.doc.dismissed = [...new Set([...state.doc.dismissed, next.id])];
      }
      return ok;
    },
    onClosed: () => {
      if (generation !== bannerGeneration) return;
      if (popupDialog === dialog) {
        popupDialog = null;
        popupId = null;
      }
      drawBanner();
    },
  });
  popupDialog = dialog;
}

function bannerItem(a: Announcement) {
  return html`
    <article class="home-banner-item ${a.level}" data-ann-id=${a.id}>
      <div class="home-banner-emblem" aria-hidden="true">✦</div>
      <div class="home-banner-copy">
        <div class="home-banner-eyebrow">
          ${brandName()} · ${a.level === "notice" ? "Product news" : ANNOUNCEMENT_LEVEL_LABEL[a.level]}
        </div>
        <h2 class="home-banner-text">${a.title}</h2>
        <div class="home-banner-meta">
          ${shortDate(a.startsAt)} published · ${a.endsAt ? `${shortDate(a.endsAt)} ends` : "No end date"}
        </div>
      </div>
      <button class="home-banner-more" type="button" @click=${() => openAnnouncementReader(a)}>
        Read notice <span aria-hidden="true">↗</span>
      </button>
      <button
        class="home-banner-close"
        type="button"
        aria-label="Dismiss this notice"
        title="You can read it again in the growth guide"
        @click=${() => dismissAnnouncementRow(a)}
      >
        ×
      </button>
    </article>
  `;
}

function dismissAnnouncementRow(a: Announcement): void {
  const generation = bannerGeneration;
  state.localHidden = [...state.localHidden, a.id];
  drawBanner();
  void postDismissAnnouncement(a.id, bannerFetch).then((ok) => {
    if (generation !== bannerGeneration) return;
    state.localHidden = state.localHidden.filter((id) => id !== a.id);
    if (ok && state.doc) state.doc = { ...state.doc, dismissed: [...state.doc.dismissed, a.id] };
    drawBanner();
    if (!ok) {
      const alert = document.createElement("div");
      alert.className = "home-toast";
      alert.setAttribute("role", "alert");
      alert.textContent = "Could not dismiss the notice. Try again later.";
      toastStack().appendChild(alert);
      window.setTimeout(() => alert.remove(), 6000);
    }
  });
}

function toastStack(): HTMLElement {
  let stack = document.querySelector<HTMLElement>(".home-toast-stack");
  if (!stack) {
    stack = document.createElement("div");
    stack.className = "home-toast-stack";
    appendNotification(stack);
  }
  return stack;
}

function showToast(a: Announcement): void {
  if (typeof document === "undefined") return;
  const stack = toastStack();
  const duplicate = [...stack.children].some((el) => (el as HTMLElement).dataset.annId === a.id);
  if (duplicate) return;
  const toast = document.createElement("div");
  toast.className = "home-toast";
  toast.dataset.annId = a.id;
  render(
    html`
      <div class="home-toast-tag">New notice · ${ANNOUNCEMENT_LEVEL_LABEL[a.level]}</div>
      <div class="home-toast-title">${a.title}</div>
      <div class="home-toast-actions">
        <button class="home-toast-view" type="button" @click=${() => openAnnouncementFromToast(a.id, toast)}>
          View
        </button>
        <button class="home-toast-close" type="button" title="Close alert" @click=${() => toast.remove()}>✕</button>
      </div>
    `,
    toast,
  );
  stack.appendChild(toast);
}

function openAnnouncementFromToast(id: string, toast: HTMLElement): void {
  reportHomeEvent("announced_toast_open", id);
  const announcement = state.doc?.announcements.find((a) => a.id === id);
  if (announcement) openAnnouncementReader(announcement);
  toast.remove();
}
