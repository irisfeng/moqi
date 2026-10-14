import { appendNotification } from "./notification-region.ts";
import type { MessageLocation } from "./message-location.ts";
export type AlertKind = "message" | "mention" | "reply" | "done" | "added";

const ALERT_EYEBROW: Record<AlertKind, string> = {
  message: "New message",
  mention: "Mentioned you",
  reply: "New reply",
  done: "Task finished",
  added: "Added to a project",
};

export function createMentionToast(
  navigate: (threadRef: string, target: MessageLocation, signal?: AbortSignal) => Promise<boolean>,
) {
  const queue: {
    threadRef: string;
    title: string;
    target: MessageLocation;
    kind: AlertKind;
    onOpened?: () => Promise<void>;
  }[] = [];
  const root = document.createElement("div");
  root.className = "mention-toast";
  root.hidden = true;
  const action = document.createElement("button");
  action.type = "button";
  action.className = "mention-toast-action";
  const icon = document.createElement("span");
  icon.className = "mention-toast-icon";
  icon.setAttribute("aria-hidden", "true");
  icon.innerHTML =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M20 11.5a7.5 7.5 0 0 1-7.5 7.5H5l-3 3V11.5A7.5 7.5 0 0 1 9.5 4h3a7.5 7.5 0 0 1 7.5 7.5Z"/><path d="M7 10h8M7 14h5"/></svg>';
  const copy = document.createElement("span");
  copy.className = "mention-toast-copy";
  const eyebrow = document.createElement("span");
  eyebrow.className = "mention-toast-eyebrow";
  const title = document.createElement("span");
  title.className = "mention-toast-title";
  const link = document.createElement("span");
  link.className = "mention-toast-link";
  copy.append(eyebrow, title, link);
  action.append(icon, copy);
  const dismiss = document.createElement("button");
  dismiss.type = "button";
  dismiss.className = "mention-toast-dismiss";
  dismiss.textContent = "×";
  dismiss.setAttribute("aria-label", "Dismiss alert (unread is kept)");
  const status = document.createElement("span");
  status.className = "mention-toast-status";
  status.setAttribute("role", "status");
  const announcement = document.createElement("span");
  announcement.className = "notification-sr-only";
  announcement.setAttribute("role", "status");
  root.append(action, dismiss, status, announcement);
  appendNotification(root);
  let pending: AbortController | undefined;
  let busy = false;
  let failed = false;
  let disposed = false;
  function render() {
    if (disposed) return;
    const item = queue[0];
    root.hidden = !item;
    root.classList.toggle("show", !!item);
    root.classList.toggle("mention", item?.kind === "mention");
    root.classList.toggle("completion", item?.kind === "done" || item?.kind === "reply");
    eyebrow.textContent = ALERT_EYEBROW[item?.kind ?? "message"];
    dismiss.hidden = item?.kind === "mention" && !failed;
    title.textContent = item?.title ?? "";
    title.title = item?.title ?? "";
    link.textContent = "View message →";
    if (failed) link.textContent = "Retry opening →";
    if (busy) link.textContent = "Opening…";
    action.setAttribute("aria-label", `${item?.title ?? "New message"}, ${link.textContent}`);
    root.dataset.state = failed ? "error" : "idle";
    if (busy) root.dataset.state = "loading";
    root.setAttribute("aria-busy", String(busy));
    action.disabled = busy;
    dismiss.disabled = false;
    status.textContent = "";
    announcement.textContent = item ? `${item.title} has a new message` : "";
    if (queue.length > 1) status.textContent = `${queue.length - 1} more conversations`;
    if (failed) status.textContent = "Could not open the message. It stays unread. Dismiss the alert and retry.";
  }
  function remove() {
    if (queue[0]?.kind === "mention" && !failed) return;
    pending?.abort();
    pending = undefined;
    busy = false;
    queue.shift();
    failed = false;
    render();
  }
  action.onclick = async () => {
    const item = queue[0];
    if (!item || busy) return;
    const request = new AbortController();
    pending = request;
    busy = true;
    failed = false;
    render();
    try {
      if (await navigate(item.threadRef, item.target, request.signal)) {
        if (disposed || request.signal.aborted) return;
        if (item.onOpened) await item.onOpened();
        const index = queue.indexOf(item);
        if (index >= 0) queue.splice(index, 1);
      } else if (!request.signal.aborted) failed = true;
    } catch {
      if (!request.signal.aborted) failed = true;
    } finally {
      if (pending === request) {
        pending = undefined;
        busy = false;
        render();
      }
    }
  };
  dismiss.onclick = remove;
  return {
    notify(
      threadRef: string,
      title: string,
      target: MessageLocation = {},
      onOpened?: () => Promise<void>,
      kind: AlertKind = "message",
    ) {
      if (disposed) return false;
      const waiting = queue.find((item, index) => item.threadRef === threadRef && !(busy && index === 0));
      if (waiting) {
        if (kind !== "mention" || waiting.kind === "mention") return false;
        Object.assign(waiting, { title, target, kind, ...(onOpened ? { onOpened } : {}) });
        render();
        return true;
      }
      if (queue.length >= 5) return false;
      queue.push({ threadRef, title, target, kind, ...(onOpened ? { onOpened } : {}) });
      render();
      return true;
    },
    retain(threads: Set<string>) {
      for (let index = queue.length - 1; index >= 0; index--) {
        if (!threads.has(queue[index]!.threadRef)) queue.splice(index, 1);
      }
      if (!queue.length) failed = false;
      render();
    },
    dispose() {
      pending?.abort();
      disposed = true;
      queue.length = 0;
      root.remove();
    },
  };
}
