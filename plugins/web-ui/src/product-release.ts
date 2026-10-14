export type ReleaseNotes = { version: string; notes: string };

function releaseNotes(value: unknown): ReleaseNotes | null {
  const entry = value as { version?: unknown; notes?: unknown } | null;
  return typeof entry?.version === "string" &&
    entry.version.trim() &&
    typeof entry.notes === "string" &&
    entry.notes.trim()
    ? { version: entry.version, notes: entry.notes }
    : null;
}

export function productRelease(
  doc: Pick<Document, "querySelector" | "getElementById">,
): (ReleaseNotes & { history: ReleaseNotes[] }) | null {
  const version = doc.querySelector('meta[name="coworker-product-version"]')?.getAttribute("content")?.trim();
  const raw = doc.getElementById("coworker-release-notes")?.textContent;
  if (!version || !raw) return null;
  try {
    const parsed = JSON.parse(raw) as { version?: unknown; notes?: unknown; history?: unknown };
    const current = releaseNotes(parsed);
    if (!current || current.version !== version) return null;
    const history = Array.isArray(parsed.history)
      ? parsed.history.map(releaseNotes).filter((entry): entry is ReleaseNotes => entry !== null)
      : [];
    return { version, notes: current.notes, history };
  } catch {
    return null;
  }
}
