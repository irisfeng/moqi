import { html, nothing, type TemplateResult } from "lit";
import { ThumbsDown, ThumbsUp } from "lucide";
import { api } from "./core-bridge.ts";
import { tip } from "./tooltip.ts";
import { icon } from "./icons.ts";

type RatingValue = "up" | "down";

interface HeldRating {
  targetId: string;
  value: RatingValue;
  reason: string;
}

const held = new Map<string, Map<string, HeldRating>>();
const requested = new Set<string>();
const changedLocally = new Map<string, Set<string>>();
let version = 0;

export function resetRatings(): void {
  held.clear();
  requested.clear();
  changedLocally.clear();
  version += 1;
}

export function ratingsVersion(): number {
  return version;
}

export function ratingTargetId(sessionId: string, seq: number, fileId?: string): string {
  return fileId ? `file:${sessionId}:${fileId}` : `entry:${sessionId}:${seq}`;
}

export function nextRating(current: RatingValue | undefined, clicked: RatingValue): RatingValue | null {
  return current === clicked ? null : clicked;
}

function loadRatings(sessionId: string, redraw: () => void): void {
  if (requested.has(sessionId)) return;
  requested.add(sessionId);
  void api<{ ratings: HeldRating[] }>(`/api/ratings?sessionId=${encodeURIComponent(sessionId)}`)
    .then((result) => {
      if (!requested.has(sessionId)) return;
      const loaded = new Map(result.ratings.map((rating) => [rating.targetId, rating]));
      const local = held.get(sessionId);
      for (const targetId of changedLocally.get(sessionId) ?? []) {
        const mine = local?.get(targetId);
        if (mine) loaded.set(targetId, mine);
        else loaded.delete(targetId);
      }
      changedLocally.delete(sessionId);
      held.set(sessionId, loaded);
      version += 1;
      redraw();
    })
    .catch(() => requested.delete(sessionId));
}

async function rate(
  sessionId: string,
  seq: number,
  fileId: string | undefined,
  clicked: RatingValue,
  redraw: () => void,
): Promise<void> {
  const targetId = ratingTargetId(sessionId, seq, fileId);
  const ratings = held.get(sessionId) ?? new Map<string, HeldRating>();
  const before = ratings.get(targetId);
  const value = nextRating(before?.value, clicked);
  let reason = "";
  if (value === "down") {
    const answer = window.prompt("What was wrong? You can leave this empty.", "");
    if (answer === null) return;
    reason = answer.trim();
  }
  if (value) ratings.set(targetId, { targetId, value, reason });
  else ratings.delete(targetId);
  held.set(sessionId, ratings);
  if (!changedLocally.has(sessionId)) changedLocally.set(sessionId, new Set());
  changedLocally.get(sessionId)!.add(targetId);
  version += 1;
  redraw();
  try {
    await api("/api/ratings", {
      method: "PUT",
      body: JSON.stringify({ sessionId, seq, ...(fileId ? { fileId } : {}), value, reason }),
    });
  } catch {
    if (before) ratings.set(targetId, before);
    else ratings.delete(targetId);
    version += 1;
    redraw();
  }
}

export function ratingButtons(sessionId: string, seq: number, redraw: () => void, fileId?: string): TemplateResult {
  loadRatings(sessionId, redraw);
  const current = held.get(sessionId)?.get(ratingTargetId(sessionId, seq, fileId))?.value;
  const button = (value: RatingValue, label: string): TemplateResult => {
    const given = current === value;
    const rated = value === "up" ? "Rated helpful. Click to remove." : "Rated not helpful. Click to remove.";
    return html`<button
      class=${given ? `msg-rated ${value}` : "msg-copy"}
      type="button"
      aria-pressed=${String(given)}
      aria-label=${given ? rated : label}
      ${tip(given ? "Click to remove your rating" : label)}
      @click=${() => void rate(sessionId, seq, fileId, value, redraw)}
    >
      ${icon(value === "up" ? ThumbsUp : ThumbsDown, 13)}${
        given ? html`<span>${value === "up" ? "Helpful" : "Not helpful"}</span>` : nothing
      }
    </button>`;
  };
  return html`${button("up", fileId ? "Good file" : "Good answer")}${button("down", fileId ? "Bad file" : "Bad answer")}`;
}
