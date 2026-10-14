import { html } from "lit";
import { card, renderer, table } from "./shared.ts";

interface RatingTally {
  name: string;
  up: number;
  down: number;
}

export function upShare(row: Pick<RatingTally, "up" | "down">): string {
  const total = row.up + row.down;
  return total ? `${Math.round((row.up / total) * 100)}%` : "";
}

export function ratingRows(rows: unknown, unnamed: string): any[][] {
  const tallies: RatingTally[] = Array.isArray(rows) ? rows : [];
  return tallies.map((row) => [row.name || unnamed, row.up, row.down, upShare(row)]);
}

export function ratings(root: HTMLElement, d: any, s: Record<string, any>) {
  const paint = renderer(root);
  const byModel = ratingRows(d?.byModel, "Unknown model");
  const bySkill = ratingRows(d?.bySkill, "Unknown skill");
  const reasons: any[] = Array.isArray(d?.reasons) ? d.reasons : [];
  const total = (Array.isArray(d?.byModel) ? d.byModel : []).reduce(
    (sum: number, row: RatingTally) => sum + row.up + row.down,
    0,
  );
  s.defaultShell({ stats: [[String(total), "Ratings"]] });
  paint(
    html`<div class="list-root">
      ${card(
        "By model",
        "Thumbs up and down that people gave to answers and generated files, grouped by the model that wrote the answer.",
        table(["Model", "Up", "Down", "Share up"], byModel, "No ratings yet."),
      )}
      ${card(
        "By skill",
        "The same ratings grouped by the skills the assistant loaded for that answer. An answer that used two skills counts under both.",
        table(["Skill", "Up", "Down", "Share up"], bySkill, "No rated answer used a skill yet."),
      )}
      ${card(
        "Reasons given with a thumbs down",
        "The most recent fifty. The person who wrote each one is not shown.",
        table(
          ["When", "Model", "Skills", "Reason"],
          reasons.map((row) => [
            new Date(row.at).toLocaleString(),
            row.model || "Unknown model",
            (row.skills ?? []).join(", "),
            row.reason,
          ]),
          "No reasons yet.",
        ),
      )}
    </div>`,
  );
}
