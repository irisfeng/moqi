export type AnnouncementTiming = { startsAt: number; endsAt: number | null };
export type AnnouncementState = "scheduled" | "active" | "ended";
export type AnnouncementDraft = {
  level: string;
  title: string;
  body: string;
  startsAt: number;
  endsAt: number | null;
  error?: string;
};

export const ANNOUNCEMENT_LEVEL_LABELS: Record<string, string> = {
  notice: "Notice",
  maintenance: "Maintenance",
  incident: "Incident",
};

export const ANNOUNCEMENT_STATUS_META: Record<AnnouncementState, [string, string]> = {
  active: ["Active", "ok"],
  scheduled: ["Scheduled", "info"],
  ended: ["Ended", "muted"],
};

export function announcementStatus(a: AnnouncementTiming, now = Date.now()): AnnouncementState {
  if (now < a.startsAt) return "scheduled";
  if (a.endsAt === null || now < a.endsAt) return "active";
  return "ended";
}

export function toDatetimeLocalValue(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    date.getFullYear() +
    "-" +
    pad(date.getMonth() + 1) +
    "-" +
    pad(date.getDate()) +
    "T" +
    pad(date.getHours()) +
    ":" +
    pad(date.getMinutes())
  );
}

export function defaultAnnouncementWindow(now = new Date()): { startsAt: string; endsAt: string } {
  return {
    startsAt: toDatetimeLocalValue(now),
    endsAt: toDatetimeLocalValue(new Date(now.getTime() + 7 * 86400000)),
  };
}

export function announcementDraft(
  level: string,
  title: string,
  body: string,
  startsAtRaw: string,
  endsAtRaw: string,
): AnnouncementDraft {
  const fail = (error: string) => ({ error }) as AnnouncementDraft;
  const trimmed = String(title ?? "").trim();
  if (!trimmed) return fail("A title is required.");
  const startsAt = new Date(startsAtRaw).getTime();
  const endsAt = endsAtRaw === "" ? null : new Date(endsAtRaw).getTime();
  if (!Number.isFinite(startsAt) || (endsAt !== null && !Number.isFinite(endsAt)))
    return fail("Enter a valid start time. Leave the end time empty for no end.");
  if (endsAt !== null && endsAt <= startsAt) return fail("The end time must be later than the start time.");
  return { level, title: trimmed, body: String(body ?? ""), startsAt, endsAt };
}

export function takedownEndsAt(a: { startsAt: number }, now = Date.now()): number {
  return now > a.startsAt ? now : a.startsAt + 1;
}
