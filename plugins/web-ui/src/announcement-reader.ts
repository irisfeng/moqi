import { UI_BASE } from "./deep-link.ts";
import { Marked } from "marked";
import DOMPurify from "dompurify";
import type { Announcement } from "./banner.ts";
import { brandName } from "./brand-name.ts";

const markdown = new Marked({ gfm: true, breaks: true });

export function announcementMarkup(body: string): string {
  const clean = DOMPurify.sanitize(markdown.parse(body, { async: false }), {
    ALLOWED_TAGS: [
      "img",
      "p",
      "br",
      "strong",
      "em",
      "del",
      "h1",
      "h2",
      "h3",
      "h4",
      "ul",
      "ol",
      "li",
      "blockquote",
      "pre",
      "code",
      "a",
      "hr",
      "table",
      "thead",
      "tbody",
      "tr",
      "th",
      "td",
    ],
    ALLOWED_ATTR: ["href", "title", "start", "src", "alt"],
  });
  const template = document.createElement("template");
  template.innerHTML = clean;
  let imageCount = 0;
  for (const img of template.content.querySelectorAll("img")) {
    if (++imageCount > 6 || !/^\/api\/announcement-images\/[a-f0-9]{32}$/.test(img.getAttribute("src") ?? "")) {
      img.replaceWith(document.createTextNode(img.alt || "[See the image uploaded with the notice]"));
      continue;
    }
    img.decoding = "async";
    img.loading = "lazy";
  }
  return template.innerHTML;
}

export function renderAnnouncementBody(mount: HTMLElement, body: string, assetBase = UI_BASE): void {
  mount.innerHTML = announcementMarkup(body);
  for (const image of mount.querySelectorAll("img")) image.src = assetBase + image.getAttribute("src");
  for (const link of mount.querySelectorAll("a")) {
    link.target = "_blank";
    link.rel = "noopener noreferrer";
  }
}

function announcementDate(iso: string | null): string {
  if (!iso) return "No end date";
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return "";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

export function openAnnouncementReader(
  a: Announcement,
  options: { onDismiss?: () => Promise<boolean>; onClosed?: () => void; assetBase?: string } = {},
): HTMLDialogElement {
  document.querySelector<HTMLDialogElement>(".announcement-reader")?.close();
  const previous = document.activeElement;
  const dialog = document.createElement("dialog");
  dialog.className = "announcement-reader";
  dialog.setAttribute("aria-labelledby", "announcement-reader-title");
  const head = document.createElement("header");
  head.className = "announcement-reader-head";
  const eyebrow = document.createElement("div");
  eyebrow.className = "announcement-reader-eyebrow";
  eyebrow.textContent = `${brandName()} / ${{ notice: "Product news", incident: "Service issue", maintenance: "Maintenance notice" }[a.level]}`;
  const title = document.createElement("h1");
  title.id = "announcement-reader-title";
  title.textContent = a.title;
  const meta = document.createElement("p");
  meta.className = "announcement-reader-meta";
  meta.textContent = `${announcementDate(a.startsAt)} published · ${a.endsAt ? `${announcementDate(a.endsAt)} ends` : "No end date"}`;
  const close = document.createElement("button");
  close.className = "announcement-reader-close";
  close.type = "button";
  close.setAttribute("aria-label", "Close notice");
  close.textContent = "×";

  head.append(eyebrow, title, meta);
  const body = document.createElement("article");
  body.className = "announcement-prose";
  renderAnnouncementBody(body, a.body || "No content.", options.assetBase);
  const foot = document.createElement("footer");
  foot.className = "announcement-reader-foot";
  const hint = document.createElement("span");
  hint.textContent = "Make every working day a little calmer.";
  const done = document.createElement("button");
  done.type = "button";
  done.textContent = options.onDismiss ? "Got it" : "Back to workspace";
  if (options.onDismiss) hint.textContent = "After closing, you can read it again in the growth guide.";
  hint.setAttribute("role", "status");
  let saving = false;
  const dismiss = async () => {
    if (saving) return;
    if (!options.onDismiss) {
      dialog.close();
      return;
    }
    saving = true;
    close.disabled = done.disabled = true;
    hint.textContent = "Saving your dismissal…";
    let ok: boolean;
    try {
      ok = await options.onDismiss();
    } catch {
      ok = false;
    }
    if (!dialog.isConnected) return;
    saving = false;
    close.disabled = done.disabled = false;
    if (ok) dialog.close();
    else hint.textContent = "Could not save your dismissal. Try again.";
  };
  close.onclick = done.onclick = () => void dismiss();
  if (options.onDismiss)
    dialog.addEventListener("cancel", (event) => {
      event.preventDefault();
      void dismiss();
    });
  foot.append(hint, done);
  const scroll = document.createElement("div");
  scroll.className = "announcement-reader-scroll";
  scroll.tabIndex = 0;
  scroll.setAttribute("aria-label", "Notice content");
  scroll.append(head, body, foot);
  const controls = document.createElement("div");
  controls.className = "announcement-reader-controls";
  controls.append(close);
  dialog.append(controls, scroll);
  dialog.addEventListener(
    "close",
    () => {
      dialog.remove();
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
      options.onClosed?.();
    },
    { once: true },
  );
  document.body.appendChild(dialog);
  dialog.showModal();
  close.focus();
  return dialog;
}
