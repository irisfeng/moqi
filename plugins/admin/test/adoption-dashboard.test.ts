import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  departmentData,
  departmentSeries,
  freshness,
  niceScale,
  sceneColor,
  sceneRows,
  sceneTrend,
  trendSeries,
  valueText,
} from "../ui/adoption-dashboard.ts";

const DAY = 86400000;
const FROM = Date.parse("2026-10-01T00:00:00+08:00");

function report(extra: Record<string, unknown> = {}): any {
  return {
    window: { from: FROM, to: FROM + 3 * DAY, department: "", search: "" },
    generatedAt: FROM + 2 * DAY,
    quality: { projectionPending: false },
    summary: { registeredPeople: 4 },
    trend: [
      { at: FROM + 2 * DAY, requests: 5, activePeople: 2 },
      { at: FROM, requests: 0, activePeople: 0 },
      { at: FROM + DAY, requests: 3, activePeople: 1 },
    ],
    departmentMetrics: [
      {
        department: "Sales",
        requests: 4,
        activePeople: 1,
        otherActivePeople: 0,
        tokens: { measuredCalls: 2, total: 900 },
      },
      { department: "Ops", requests: 9, activePeople: 2, otherActivePeople: 1, tokens: { measuredCalls: 0, total: 0 } },
      {
        department: "Design",
        requests: 4,
        activePeople: 1,
        otherActivePeople: 0,
        tokens: { measuredCalls: 1, total: 900 },
      },
    ],
    ...extra,
  };
}

function scenes() {
  const category = (id: string, requests: number, people: number) => ({
    id,
    label: id.toUpperCase(),
    requests,
    people,
  });
  return {
    taxonomyVersion: "v1",
    totalRequests: 10,
    classifiedRequests: 6,
    unclassifiedRequests: 4,
    coverage: 0.6,
    processedAt: null,
    categories: [category("writing", 4, 2), category("data", 2, 1), category("unclassified", 4, 3)],
    departments: [],
    statuses: [],
    trend: [
      {
        at: FROM,
        categories: [
          { id: "writing", requests: 1, people: 1 },
          { id: "data", requests: 2, people: 1 },
        ],
      },
      { at: FROM + DAY, categories: [{ id: "writing", requests: 3, people: 2 }] },
    ],
  };
}

test("a report without scenarios yields no scene data", () => {
  assert.equal(sceneRows(report()), null);
  assert.equal(sceneTrend(report()), null);
  assert.equal(sceneRows(report({ scenarios: undefined })), null);
});

test("scene shares add up to one with unclassified kept in the total", () => {
  const rows = sceneRows(report({ scenarios: scenes() }));
  assert.equal(rows.length, 3);
  assert.equal(rows.find((r: any) => r.id === "unclassified").share, 0.4);
  const sum = rows.reduce((total: number, r: any) => total + r.share, 0);
  assert.ok(Math.abs(sum - 1) < 1e-9);
});

test("scene shares are null when there are no requests", () => {
  const empty = { ...scenes(), totalRequests: 0 };
  assert.ok(sceneRows(report({ scenarios: empty })).every((r: any) => r.share === null));
});

test("scene trend fills missing categories with zero and filters by selection", () => {
  const all = sceneTrend(report({ scenarios: scenes() }))!;
  assert.deepEqual(all.days, ["2026-10-01", "2026-10-02"]);
  assert.deepEqual(
    all.series.map((s: any) => s.id),
    ["writing", "data", "unclassified"],
  );
  assert.deepEqual(all.series[1].values, [2, 0]);
  const one = sceneTrend(report({ scenarios: scenes() }), "writing")!;
  assert.deepEqual(
    one.series.map((s: any) => s.id),
    ["writing"],
  );
  assert.equal(one.series[0].index, 0);
  assert.deepEqual(one.series[0].values, [1, 3]);
});

test("each scene keeps one colour in every view, and unclassified is grey", () => {
  const all = sceneTrend(report({ scenarios: scenes() }))!;
  const colours = all.series.map((s: any) => sceneColor(s.id, s.index));
  assert.equal(new Set(colours).size, colours.length);
  assert.equal(colours[2], "#99a29d");
  const one = sceneTrend(report({ scenarios: scenes() }), "data")!;
  assert.equal(sceneColor(one.series[0].id, one.series[0].index), colours[1]);
});

test("a card's measure picker shares the title's row instead of being pulled over it", () => {
  const styles = readFileSync(new URL("../ui/adoption.ts", import.meta.url), "utf8");
  assert.doesNotMatch(styles, /margin-top: -/);
  assert.match(styles, /\.adoption-dashboard > \.dashboard-grid > \.dashboard-card \{\\n {2}display: grid;/);
  assert.match(styles, /\.adoption-root \.dashboard-card-controls \.dd \{\\n {2}width: auto;/);
});

test("the daily trend is sorted by day and keeps zero points", () => {
  const series = trendSeries(report());
  assert.deepEqual(
    series.points.map((p: any) => p.name),
    ["2026-10-01", "2026-10-02", "2026-10-03"],
  );
  assert.deepEqual(
    series.points.map((p: any) => p.value),
    [0, 3, 5],
  );
  assert.equal(trendSeries(report(), "activePeople").points[2].value, 2);
});

test("while history is backfilling, zero days become gaps", () => {
  const pending = report({ quality: { projectionPending: true } });
  assert.deepEqual(
    trendSeries(pending).points.map((p: any) => p.value),
    [null, 3, 5],
  );
  assert.equal(valueText(pending, 0, "requests"), "Backfilling");
  assert.equal(valueText(pending, 0, "tokens"), "0");
  assert.equal(valueText(pending, null, "tokens"), "Not collected yet");
});

test("the department ranking is sorted by value, then by name, with missing values last", () => {
  assert.deepEqual(
    departmentData(report(), "requests").map((d) => d.name),
    ["Ops", "Design", "Sales"],
  );
  assert.deepEqual(
    departmentData(report(), "people").map((d) => d.value),
    [3, 1, 1],
  );
  const tokens = departmentData(report(), "tokens");
  assert.deepEqual(
    tokens.map((d) => d.name),
    ["Design", "Sales", "Ops"],
  );
  assert.equal(tokens[2].value, null);
  assert.equal(departmentSeries(report(), "tokens").bars[2].value, null);
});

test("the nice scale covers the maximum with whole-number ticks", () => {
  assert.deepEqual(niceScale(0), { max: 1, ticks: [0, 1] });
  const scale = niceScale(87);
  assert.ok(scale.max >= 87);
  assert.equal(scale.ticks[0], 0);
  assert.equal(scale.ticks.at(-1), scale.max);
});

test("freshness tells a partial day from a finished window", () => {
  assert.ok(freshness(report({ partialDay: true, asOf: FROM + DAY })).startsWith("Today's data is still updating"));
  assert.ok(freshness(report({ partialDay: false })).startsWith("Data generated at"));
});
