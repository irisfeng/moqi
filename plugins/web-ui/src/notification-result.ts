import "./marked-dedupe";
import "@mariozechner/mini-lit/dist/MarkdownBlock.js";
import { escapeLoneDollars } from "./markdown-dollars";
import { installMarkdownSanitizer } from "./markdown-sanitize";
import { withBase } from "./core-bridge";

installMarkdownSanitizer();
let active: (() => void) | undefined;

export function closeNotificationResult(): void {
  active?.();
}

export async function openNotificationResult(
  threadRef: string,
  deliveryId: string,
  signal?: AbortSignal,
): Promise<boolean> {
  if (signal?.aborted) return false;
  closeNotificationResult();
  const controller = new AbortController();
  const requestSignal = AbortSignal.any([controller.signal, AbortSignal.timeout(15000), ...(signal ? [signal] : [])]);
  const previous = document.activeElement;
  const dialog = document.createElement("dialog");
  dialog.className = "notification-result";
  dialog.setAttribute("aria-labelledby", "notification-result-title");
  const header = document.createElement("header");
  const title = document.createElement("h2");
  title.id = "notification-result-title";
  title.textContent = "Message details";
  const close = document.createElement("button");
  close.type = "button";
  close.className = "btn";
  close.textContent = "Close";
  const content = document.createElement("div");
  content.className = "notification-result-content";
  content.textContent = "Loading result…";
  content.setAttribute("aria-live", "polite");
  header.append(title, close);
  dialog.append(header, content);
  const dispose = (): void => {
    controller.abort();
    dialog.remove();
    signal?.removeEventListener("abort", dispose);
    if (active === dispose) active = undefined;
    if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
  };
  active = dispose;
  close.onclick = dispose;
  dialog.oncancel = (event) => {
    event.preventDefault();
    dispose();
  };
  signal?.addEventListener("abort", dispose, { once: true });
  document.body.append(dialog);
  dialog.showModal();
  try {
    const response = await fetch(
      withBase(`/api/notifications/${encodeURIComponent(`delivery:${deliveryId}`)}/result`),
      { signal: requestSignal },
    );
    if (!response.ok)
      throw new Error(
        response.status === 404 ? "Result unavailable or access removed." : "Load failed. Try again later.",
      );
    const result = (await response.json()) as {
      threadRef: string;
      title: string;
      at: number;
      text: string;
      files: { id: string; name: string }[];
    };
    if (requestSignal.aborted || !dialog.isConnected) return false;
    if (result.threadRef !== threadRef) throw new Error("Message belongs to another conversation. Refresh.");
    title.textContent = result.title;
    const time = document.createElement("p");
    time.className = "hint";
    time.textContent = new Date(result.at).toLocaleString();
    const body = document.createElement("markdown-block") as HTMLElement & { content: string };
    body.content = escapeLoneDollars(result.text || "This message has no text.");
    content.replaceChildren(time, body);
    for (const file of result.files) {
      const link = document.createElement("a");
      link.href = withBase(`/api/files/${encodeURIComponent(file.id)}/content`);
      link.textContent = file.name;
      link.download = file.name;
      link.className = "notification-result-file";
      content.append(link);
    }
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    return !requestSignal.aborted && dialog.isConnected;
  } catch (error) {
    if (controller.signal.aborted || signal?.aborted) return false;
    let message = "Could not load the result. It stays unread.";
    if (error instanceof Error) message = error.message;
    if (requestSignal.aborted) message = "Loading timed out. It stays unread. Close and try again.";
    content.textContent = message;
    return false;
  }
}
