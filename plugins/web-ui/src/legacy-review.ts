import { html, nothing, render } from "lit";
import { api } from "./core-bridge";
import { appState } from "./shell-state";
import { userErrorMessage } from "./user-error";

interface LegacyReviewIntent {
  id: string;
  principalId: string;
  scopeId: string;
  threadRef: string;
  text: string;
  createdAt: number;
  expiresAt: number;
  status: "pending_review";
  requiresReattach: boolean;
  payload: { attachments?: Array<{ name: string }>; quoteSeq?: number; quoteText?: string; quoteAuthor?: string };
}

let dialog: HTMLDialogElement | null = null;
let owner: string | null = null;
let generation = 0;
let intents: LegacyReviewIntent[] = [];
let cursor: string | null = null;
let pageCursor: string | null = null;
let previousCursors: Array<string | null> = [];
let loading = false;
let busyId: string | null = null;
let error = "";
let notice = "";
let discardConfirmId: string | null = null;
let refreshTimer: ReturnType<typeof setInterval> | null = null;
const confirmed = new Set<string>();

function currentOwner(): string | null {
  return owner && appState.me?.user === owner && !appState.me.impersonatedBy ? owner : null;
}

function draw(): void {
  if (!dialog) return;
  if (!currentOwner()) {
    closeLegacyReview();
    return;
  }
  render(
    html`
      <header class="legacy-review-head">
        <div>
          <h2 id="legacy-review-title">Old requests to review</h2>
          <p>
            These old-page requests reached the new service but were not run. Check each against its original
            conversation. To send one, retype it in a new chat, then clear it once you see the receipt. Records are kept
            for up to 30 days.
          </p>
        </div>
        <button type="button" class="btn" aria-label="Close review" @click=${closeLegacyReview}>Close</button>
      </header>
      <div class="legacy-review-actions">
        <button type="button" class="btn" ?disabled=${loading || busyId !== null} @click=${() => void loadPage(null)}>
          Refresh
        </button>
        <span>${intents.length} visible on this page</span>
      </div>
      ${error ? html`<p class="legacy-review-error" role="alert">${error}</p>` : nothing}
      ${notice ? html`<p class="legacy-review-notice" role="status">${notice}</p>` : nothing}
      ${loading && !intents.length ? html`<p>Loading your requests to review…</p>` : nothing}
      ${!loading && !intents.length && !error ? html`<p>No requests to review right now.</p>` : nothing}
      <div class="legacy-review-list">
        ${intents.map(
          (intent) => html`
            <section class="legacy-review-item" data-legacy-id=${intent.id}>
              <h3>To review · ${new Date(intent.createdAt).toLocaleString("zh-CN")}</h3>
              <p>Original conversation: ${intent.threadRef}</p>
              <p class="legacy-review-warning">May be a duplicate. Check the original conversation first.</p>
              ${
                intent.requiresReattach
                  ? html`<p class="legacy-review-warning">
                      Old attachment links cannot be restored. Reattach the files; no text-only draft is possible.
                    </p>`
                  : nothing
              }
              ${
                intent.payload.quoteText || intent.payload.quoteSeq !== undefined
                  ? html`<p class="legacy-review-warning">Old quotes cannot carry over. Check the quote by hand.</p>
                      <p>
                        Quote: ${intent.payload.quoteAuthor ?? "Original member"} ·
                        ${intent.payload.quoteText ?? "Original message no. " + intent.payload.quoteSeq}
                      </p>`
                  : nothing
              }
              ${
                intent.text.length > 20_000
                  ? html`<p class="legacy-review-warning">
                      Over the new 20,000-character limit. Split it by hand; the full original is shown.
                    </p>`
                  : nothing
              }
              <details>
                <summary>View original request text</summary>
                <pre>${intent.text}</pre>
              </details>
              <p class="legacy-review-expiry">Kept until ${new Date(intent.expiresAt).toLocaleString("zh-CN")}</p>
              <label class="legacy-review-check">
                <input
                  data-action="confirm"
                  type="checkbox"
                  .checked=${confirmed.has(intent.id)}
                  @change=${(event: Event) => {
                    if ((event.currentTarget as HTMLInputElement).checked) confirmed.add(intent.id);
                    else confirmed.delete(intent.id);
                    draw();
                  }}
                />
                I checked the original chat and chose not to send, or resent it by hand and checked the receipt
              </label>
              <div class="legacy-review-row-actions">
                <button
                  data-action="discard"
                  type="button"
                  class="btn"
                  ?disabled=${!confirmed.has(intent.id) || busyId !== null}
                  @click=${() => void discard(intent)}
                >
                  ${discardConfirmId === intent.id ? "Confirm handled and delete this entry" : "Handled, delete record"}
                </button>
              </div>
            </section>
          `,
        )}
      </div>
      <div class="legacy-review-pagination">
        ${
          previousCursors.length
            ? html`<button
                type="button"
                class="btn"
                ?disabled=${loading || busyId !== null}
                @click=${() => void loadPage(previousCursors.at(-1) ?? null, "back")}
              >
                Previous
              </button>`
            : nothing
        }
        ${
          cursor
            ? html`<button
                type="button"
                class="btn"
                ?disabled=${loading || busyId !== null}
                @click=${() => void loadPage(cursor, "next")}
              >
                Next
              </button>`
            : nothing
        }
      </div>
    `,
    dialog,
  );
}

async function loadPage(
  before: string | null,
  direction: "refresh" | "next" | "back" | "stay" = "refresh",
): Promise<void> {
  const user = currentOwner();
  if (!user || loading) return;
  const requestGeneration = generation;
  loading = true;
  error = "";
  notice = "";
  intents = [];
  if (direction !== "stay") confirmed.clear();
  discardConfirmId = null;
  draw();
  try {
    const query = before ? `?before=${encodeURIComponent(before)}` : "";
    const page = await api<{ intents?: LegacyReviewIntent[]; nextCursor?: string | null }>(
      `/api/legacy-turn-intents${query}`,
    );
    if (requestGeneration !== generation || currentOwner() !== user) return;
    if (
      !Array.isArray(page.intents) ||
      page.intents.some(
        (intent) =>
          !intent ||
          intent.principalId !== user ||
          typeof intent.id !== "string" ||
          !/^[0-9a-f-]{36}$/.test(intent.id) ||
          typeof intent.scopeId !== "string" ||
          typeof intent.threadRef !== "string" ||
          typeof intent.text !== "string" ||
          intent.status !== "pending_review" ||
          typeof intent.requiresReattach !== "boolean" ||
          !intent.payload ||
          typeof intent.payload !== "object" ||
          (intent.payload.quoteText !== undefined && typeof intent.payload.quoteText !== "string") ||
          (intent.payload.quoteAuthor !== undefined && typeof intent.payload.quoteAuthor !== "string") ||
          (intent.payload.quoteSeq !== undefined && !Number.isSafeInteger(intent.payload.quoteSeq)) ||
          !Number.isFinite(intent.createdAt) ||
          !Number.isFinite(intent.expiresAt),
      )
    )
      throw new Error("Unexpected review record format. Try again later. ");
    intents = page.intents.filter((intent) => intent.expiresAt > Date.now());
    if (direction === "stay") {
      const visibleIds = new Set(intents.map((intent) => intent.id));
      for (const id of confirmed) if (!visibleIds.has(id)) confirmed.delete(id);
    }
    if (direction === "next") previousCursors.push(pageCursor);
    else if (direction === "back") previousCursors.pop();
    else if (direction === "refresh") previousCursors = [];
    pageCursor = before;
    cursor = typeof page.nextCursor === "string" && page.nextCursor !== before ? page.nextCursor : null;
  } catch (reason) {
    if (requestGeneration === generation && currentOwner() === user)
      error = userErrorMessage(reason, "Could not load requests to review. Try again later.");
  } finally {
    if (requestGeneration === generation && currentOwner() === user) {
      loading = false;
      draw();
    }
  }
}

async function discard(intent: LegacyReviewIntent): Promise<void> {
  const user = currentOwner();
  if (!user || intent.principalId !== user || busyId || !confirmed.has(intent.id)) return;
  if (discardConfirmId !== intent.id) {
    discardConfirmId = intent.id;
    draw();
    return;
  }
  discardConfirmId = null;
  busyId = intent.id;
  error = "";
  draw();
  try {
    const result = await api<{ status?: string }>("/api/legacy-turn-intents/dismiss", {
      method: "POST",
      body: JSON.stringify({ ingressId: intent.id }),
    });
    if (result.status !== "dismissed") throw new Error("Deletion was not confirmed. This entry is kept.");
    if (currentOwner() !== user) return;
    intents = intents.filter((item) => item.id !== intent.id);
    confirmed.delete(intent.id);
    notice = "Review record deleted as you confirmed. No message was sent.";
  } catch (reason) {
    if (currentOwner() === user) error = userErrorMessage(reason, "Could not delete this entry. Try again later.");
  } finally {
    busyId = null;
    draw();
  }
}

function refreshWhenVisible(): void {
  if (!dialog || document.visibilityState !== "visible") return;
  if (!currentOwner()) closeLegacyReview();
  else if (!loading && !busyId) void loadPage(pageCursor, "stay");
}

export function closeLegacyReview(): void {
  generation += 1;
  const previous = dialog;
  dialog = null;
  owner = null;
  intents = [];
  cursor = null;
  pageCursor = null;
  previousCursors = [];
  loading = false;
  busyId = null;
  error = "";
  notice = "";
  discardConfirmId = null;
  confirmed.clear();
  if (refreshTimer !== null) clearInterval(refreshTimer);
  refreshTimer = null;
  document.removeEventListener("visibilitychange", refreshWhenVisible);
  if (previous) {
    if (previous.open) previous.close();
    previous.remove();
  }
}

export function openLegacyReview(): void {
  const user = appState.me?.user;
  if (!user) return;
  closeLegacyReview();
  owner = user;
  dialog = document.createElement("dialog");
  dialog.className = "legacy-review-dialog";
  dialog.setAttribute("aria-labelledby", "legacy-review-title");
  dialog.addEventListener("close", closeLegacyReview, { once: true });
  document.body.append(dialog);
  draw();
  dialog.showModal();
  document.addEventListener("visibilitychange", refreshWhenVisible);
  refreshTimer = setInterval(() => {
    if (!currentOwner()) closeLegacyReview();
    else if (!loading && !busyId) void loadPage(pageCursor, "stay");
  }, 30_000);
  void loadPage(null);
}
