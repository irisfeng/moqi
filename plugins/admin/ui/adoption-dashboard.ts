const SVG_NS = "http://www.w3.org/2000/svg";
const SCENE_COLORS = ["#2c6b5c", "#427fa0", "#846ca5", "#bf8d37", "#a96558", "#5c8a8a", "#697e43", "#a87795"];
const stamp = (ms: number) => new Date(ms + 28800000).toISOString().slice(0, 19).replace("T", " ");

const date = (ms: number) => new Date(ms + 28800000).toISOString().slice(0, 10);
const count = (value: any) => Number(value).toLocaleString("zh-CN");
const compact = (value: any) => Intl.NumberFormat("zh-CN", { notation: "compact" }).format(value);
const token = (usage: any, key = "total") => (usage?.measuredCalls ? (usage[key] ?? null) : null);
const percent = (value: number | null) => (value == null ? "No requests" : `${(value * 100).toFixed(1)}%`);
const isUnassigned = (name: string) => name === "No dept" || name === "Unassigned";

function scope(report: any) {
  return `${date(report.window.from)} to ${date(report.window.to - 86400000)} · ${report.window.department || "All departments"} · Members: ${report.window.search || "All"} · Beijing time`;
}

export function freshness(report: any) {
  const asOf = report.asOf ?? Math.min(report.window.to, report.generatedAt);
  return (report.partialDay ?? asOf < report.window.to)
    ? `Today's data is still updating · figures as of ${stamp(asOf)} · Beijing time`
    : `Data generated at ${stamp(report.generatedAt)} · Beijing time`;
}

function sceneNote(report: any) {
  const s = report.scenarios;
  if (!s) return "Scene statistics are not set up yet";
  const processed = s.processedAt ? stamp(s.processedAt) : "Not finished yet";
  return `Automatic classification · ${s.taxonomyVersion} · Classified ${count(s.classifiedRequests)} / ${count(s.totalRequests)} · Coverage ${percent(s.coverage)} · Last processed ${processed} (Beijing time)`;
}

export function trendSeries(report: any, measure = "requests") {
  const days = [...report.trend].sort((a: any, b: any) => a.at - b.at);
  return {
    label: measure === "requests" ? "Observed manual requests (times)" : "People with observed records (people)",
    points: days.map((d: any) => ({
      name: date(d.at),
      raw: d[measure],
      value: report.quality.projectionPending && d[measure] === 0 ? null : d[measure],
    })),
  };
}

export function departmentData(report: any, measure: string) {
  const value = (d: any) => {
    if (measure === "tokens") return token(d.tokens);
    return measure === "people" ? d.activePeople + d.otherActivePeople : d.requests;
  };
  return [...report.departmentMetrics]
    .map((d: any) => ({ name: d.department, value: value(d) }))
    .sort((a, b) => (b.value ?? -1) - (a.value ?? -1) || a.name.localeCompare(b.name, "zh-CN"));
}

export function departmentSeries(report: any, measure = "tokens") {
  const labels: Record<string, string> = {
    tokens: "Tokens recorded",
    people: "People with observed records",
  };
  return {
    label: labels[measure] ?? "Observed manual requests",
    bars: departmentData(report, measure).map((d) => ({
      name: d.name,
      value: report.quality.projectionPending && d.value === 0 && measure !== "tokens" ? null : d.value,
    })),
  };
}

export function valueText(report: any, value: any, measure: string) {
  if (value == null) return "Not collected yet";
  if (report.quality.projectionPending && value === 0 && measure !== "tokens") return "Backfilling";
  return count(value);
}

export function sceneRows(report: any) {
  const s = report.scenarios;
  if (!s) return null;
  return s.categories.map((c: any) => ({
    id: c.id,
    label: c.label,
    requests: c.requests,
    people: c.people,
    share: s.totalRequests ? c.requests / s.totalRequests : null,
  }));
}

export function sceneColor(id: string, index: number) {
  return id === "unclassified" ? "#99a29d" : SCENE_COLORS[index % SCENE_COLORS.length]!;
}

export function sceneTrend(report: any, selected = "all") {
  const s = report.scenarios;
  if (!s) return null;
  return {
    days: s.trend.map((d: any) => date(d.at)),
    series: s.categories
      .map((c: any, index: number) => ({
        id: c.id,
        label: c.label,
        index,
        values: s.trend.map((d: any) => d.categories.find((r: any) => r.id === c.id)?.requests || 0),
      }))
      .filter((c: any) => selected === "all" || selected === c.id),
  };
}

export function niceScale(max: number, target = 4) {
  const top = max > 0 ? max : 1;
  const raw = top / target;
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const step = Math.max(1, ([1, 2, 5, 10].find((m) => m * magnitude >= raw) ?? 10) * magnitude);
  const steps = Math.ceil(top / step);
  return { max: steps * step, ticks: Array.from({ length: steps + 1 }, (_, i) => i * step) };
}

type Listen = (target: any, type: string, handler: (event: any) => void) => void;

const el = (tag: string, text?: any, cls?: string): any => {
  const n = document.createElement(tag);
  if (text != null) n.textContent = text;
  if (cls) n.className = cls;
  return n;
};

const svg = (tag: string, attrs: Record<string, string | number>, text?: string): any => {
  const n = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs)) n.setAttribute(key, String(value));
  if (text != null) n.textContent = text;
  return n;
};

const withTitle = (node: any, text: string) => {
  node.append(svg("title", {}, text));
  return node;
};

function lineChart(o: {
  aria: string;
  labels: { short: string; full: string }[];
  series: { label: string; color: string; dash: string; values: (number | null)[]; area?: boolean }[];
}) {
  const W = 640;
  const H = 300;
  const L = 48;
  const R = 16;
  const T = 12;
  const B = 28;
  const top = Math.max(0, ...o.series.flatMap((x) => x.values.filter((v): v is number => v != null)));
  const scale = niceScale(top);
  const n = o.labels.length;
  const x = (i: number) => (n === 1 ? L + (W - L - R) / 2 : L + (i * (W - L - R)) / (n - 1));
  const y = (v: number) => T + (H - T - B) * (1 - v / scale.max);
  const root = svg("svg", { viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": o.aria });
  root.style.width = "100%";
  root.style.height = "auto";
  root.style.display = "block";
  for (const tick of scale.ticks) {
    root.append(
      svg("line", { x1: L, x2: W - R, y1: y(tick), y2: y(tick), stroke: "var(--chart-line)", "stroke-width": 1 }),
      svg(
        "text",
        { x: L - 6, y: y(tick) + 4, "text-anchor": "end", fill: "var(--chart-dim)", "font-size": 11 },
        compact(tick),
      ),
    );
  }
  const every = Math.ceil(n / 8);
  o.labels.forEach((label, i) => {
    if (i % every) return;
    root.append(
      svg(
        "text",
        { x: x(i), y: H - 8, "text-anchor": "middle", fill: "var(--chart-dim)", "font-size": 11 },
        label.short,
      ),
    );
  });
  for (const series of o.series) {
    const runs: number[][] = [];
    series.values.forEach((value, i) => {
      if (value == null) return;
      if (i > 0 && series.values[i - 1] != null) runs[runs.length - 1].push(i);
      else runs.push([i]);
    });
    for (const run of runs) {
      const points = run.map((i) => `${x(i)} ${y(series.values[i] as number)}`);
      if (series.area && run.length > 1)
        root.append(
          svg("path", {
            d: `M${x(run[0])} ${y(0)} L${points.join(" L")} L${x(run[run.length - 1])} ${y(0)} Z`,
            fill: series.color,
            "fill-opacity": 0.15,
            stroke: "none",
          }),
        );
      const line = svg("path", {
        d: `M${points.join(" L")}`,
        fill: "none",
        stroke: series.color,
        "stroke-width": 2.5,
        "stroke-linejoin": "round",
      });
      if (series.dash) line.setAttribute("stroke-dasharray", series.dash);
      root.append(line);
    }
    series.values.forEach((value, i) => {
      if (value == null) return;
      root.append(
        withTitle(
          svg("circle", { cx: x(i), cy: y(value), r: n === 1 ? 4 : 3, fill: series.color }),
          `${o.labels[i].full} · ${series.label}: ${count(value)}`,
        ),
      );
    });
  }
  return root;
}

function barChart(
  o: {
    aria: string;
    rows: { name: string; value: number | null; text: string; color: string; title: string; pick?: () => void }[];
  },
  listen: Listen,
) {
  const W = 640;
  const L = 116;
  const R = 64;
  const T = 6;
  const B = 22;
  const rowHeight = 29;
  const H = T + o.rows.length * rowHeight + B;
  const scale = niceScale(Math.max(0, ...o.rows.map((r) => r.value ?? 0)));
  const x = (v: number) => L + (v / scale.max) * (W - L - R);
  const root = svg("svg", { viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": o.aria });
  root.style.width = "100%";
  root.style.height = "auto";
  root.style.display = "block";
  for (const tick of scale.ticks) {
    root.append(
      svg("line", { x1: x(tick), x2: x(tick), y1: T, y2: H - B, stroke: "var(--chart-line)", "stroke-width": 1 }),
      svg(
        "text",
        { x: x(tick), y: H - 6, "text-anchor": "middle", fill: "var(--chart-dim)", "font-size": 11 },
        compact(tick),
      ),
    );
  }
  o.rows.forEach((row, i) => {
    const mid = T + i * rowHeight + rowHeight / 2;
    const group = withTitle(svg("g", {}), row.title);
    group.append(
      svg("rect", { x: 0, y: mid - rowHeight / 2, width: W, height: rowHeight, fill: "none", "pointer-events": "all" }),
    );
    const shown = row.name.length > 10 ? `${row.name.slice(0, 9)}…` : row.name;
    group.append(
      svg("text", { x: L - 8, y: mid + 4, "text-anchor": "end", fill: "var(--chart-ink)", "font-size": 12 }, shown),
    );
    if (row.value != null)
      group.append(
        svg("rect", { x: L, y: mid - 7, width: Math.max(0, x(row.value) - L), height: 14, rx: 3, fill: row.color }),
      );
    group.append(
      svg(
        "text",
        { x: row.value == null ? L + 8 : x(row.value) + 6, y: mid + 4, fill: "var(--chart-ink)", "font-size": 12 },
        row.text,
      ),
    );
    const pick = row.pick;
    if (pick) {
      group.setAttribute("role", "button");
      group.setAttribute("tabindex", "0");
      group.setAttribute("aria-label", row.title);
      group.style.cursor = "pointer";
      listen(group, "click", () => pick());
      listen(group, "keydown", (event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        pick();
      });
    }
    root.append(group);
  });
  return root;
}

function legend(items: { label: string; color: string; dash: string }[]) {
  const box = el("div");
  box.style.display = "flex";
  box.style.flexWrap = "wrap";
  box.style.gap = "4px 14px";
  box.style.fontSize = "11px";
  box.style.marginTop = "6px";
  for (const item of items) {
    const entry = el("span");
    entry.style.display = "inline-flex";
    entry.style.alignItems = "center";
    entry.style.gap = "6px";
    const swatch = svg("svg", { width: 26, height: 8, "aria-hidden": "true" });
    const line = svg("line", { x1: 0, x2: 26, y1: 4, y2: 4, stroke: item.color, "stroke-width": 2.5 });
    if (item.dash) line.setAttribute("stroke-dasharray", item.dash);
    swatch.append(line);
    entry.append(swatch, item.label);
    box.append(entry);
  }
  return box;
}

function createScenes(
  report: any,
  onDepartment: (value: string) => void,
  listen: Listen,
  apiBase: string,
  query: string,
) {
  const s = report.scenarios;
  const root = el("section", null, "scenario-section");
  root.append(el("h3", "Request scenes"));
  if (!s) {
    root.append(el("p", "Scene statistics are not set up yet", "adoption-note"));
    return root;
  }
  const button = (label: string, action: () => void) => {
    const b = el("button", label);
    b.type = "button";
    listen(b, "click", action);
    return b;
  };
  root.append(
    el("p", sceneNote(report), "adoption-note"),
    el(
      "p",
      "Each manual request has one main scene; follow-ups in the same conversation count separately; people can overlap across scenes. Automatic classification is pending review.",
      "adoption-note",
    ),
  );
  const rows = sceneRows(report);
  const table = el("table", null, "scenario-table");
  const head = el("tr");
  for (const name of ["Main scene", "Requests", "Share of all requests", "People"]) head.append(el("th", name));
  const thead = el("thead");
  thead.append(head);
  const body = el("tbody");
  table.append(thead, body);
  let selected = "all";
  const controls = el("label", "Scene to analyse ");
  const select = el("select");
  select.setAttribute("aria-label", "Scene to analyse");
  for (const c of [{ id: "all", label: "All scenes" }, ...s.categories]) {
    const option = el("option", c.label);
    option.value = c.id;
    select.append(option);
  }
  controls.append(select);
  const scroll = el("div", null, "scenario-scroll");
  scroll.append(table);
  const grid = el("div", null, "dashboard-grid");
  const distribution = el("section", null, "dashboard-card");
  const barPlot = el("div", null, "scenario-plot");
  barPlot.style.height = "auto";
  distribution.append(el("h3", "Scene distribution"), barPlot, scroll);
  const trend = el("section", null, "dashboard-card");
  trend.append(el("h3", "Scene trend by day"), controls);
  const plot = el("div", null, "scenario-plot");
  plot.style.height = "auto";
  const exact = el("details", null, "dashboard-data");
  exact.append(el("summary", "Show daily values"));
  const values = el("div");
  exact.append(values);
  trend.append(plot, exact);
  grid.append(distribution, trend);
  root.append(
    grid,
    el(
      "p",
      "The scene selector only filters the trend and the department breakdown in this section; the date, department and member filters above always apply. Exports include all scenes in the current range.",
      "adoption-note",
    ),
  );
  const matrixCard = el("section", null, "dashboard-card");
  matrixCard.append(el("h3", "Departments and scenes"));
  const matrix = el("div", null, "scenario-scroll");
  matrixCard.append(matrix);
  root.append(matrixCard);
  const quality = el("details", null, "dashboard-data");
  quality.append(el("summary", `Show classification coverage: ${count(s.unclassifiedRequests)} unclassified`));
  for (const row of s.statuses) quality.append(el("p", `${row.label}: ${count(row.requests)}`));
  quality.append(
    el(
      "p",
      "Pending, too little information, missing source and failed requests all stay in the request total.",
      "adoption-note",
    ),
  );
  root.append(quality);
  const csv = el("a", "Download scenes CSV");
  csv.href = apiBase + "/api/adoption/scenarios/export?" + query;
  csv.setAttribute("download", "");
  root.append(csv);
  const choose = (id: string) => {
    selected = id;
    select.value = id;
    render();
  };
  const render = () => {
    for (const row of body.children) row.dataset.selected = String(row.dataset.id === selected);
    values.replaceChildren();
    plot.replaceChildren();
    const view = sceneTrend(report, selected);
    if (!view) return;
    for (const [i, day] of view.days.entries())
      values.append(el("p", `${day} · ${view.series.map((c: any) => `${c.label} ${count(c.values[i])}`).join("; ")}`));
    const styled = view.series.map((c: any) => ({
      label: c.label,
      color: sceneColor(c.id, c.index),
      dash: "",
      values: c.values,
    }));
    plot.append(
      lineChart({
        aria: "Daily manual requests for the selected scene; expand the daily values to read them",
        labels: view.days.map((day: string) => ({ short: day.slice(5), full: day })),
        series: styled,
      }),
      legend(styled),
    );
    const m = el("table", null, "scenario-table");
    const mh = el("tr");
    mh.append(el("th", "Current department"));
    for (const c of view.series) mh.append(el("th", c.label));
    const mt = el("thead");
    mt.append(mh);
    const mb = el("tbody");
    for (const department of s.departments) {
      const row = el("tr");
      const name = el("td");
      name.append(button(department.department, () => onDepartment(department.department)));
      row.append(name);
      for (const c of view.series) {
        const value = department.categories.find((r: any) => r.id === c.id);
        row.append(el("td", `${count(value?.requests || 0)} requests / ${count(value?.people || 0)} people`));
      }
      mb.append(row);
    }
    m.append(mt, mb);
    matrix.replaceChildren(m);
  };
  for (const c of rows) {
    const row = el("tr");
    row.dataset.id = c.id;
    const name = el("td");
    name.append(button(c.label, () => choose(c.id)));
    row.append(name, el("td", count(c.requests)), el("td", percent(c.share)), el("td", count(c.people)));
    body.append(row);
  }
  listen(select, "change", () => choose(select.value));
  barPlot.append(
    barChart(
      {
        aria: "Requests by main scene; the table below gives requests, shares and people",
        rows: rows.map((c: any, index: number) => ({
          name: c.label,
          value: c.requests,
          text: count(c.requests),
          color: sceneColor(c.id, index),
          title: `${c.label}: ${count(c.requests)} requests · ${percent(c.share)}`,
          pick: () => choose(c.id),
        })),
      },
      listen,
    ),
  );
  render();
  return root;
}

export function createDashboard(
  report: any,
  onDepartment: (value: string) => void,
  apiBase = "",
  query = "",
): { element: HTMLElement; dispose(): void } {
  const cleanups: (() => void)[] = [];
  const listen: Listen = (target, type, handler) => {
    target.addEventListener(type, handler);
    cleanups.push(() => target.removeEventListener(type, handler));
  };
  const root = el("section", null, "adoption-dashboard");
  const top = el("div", null, "dashboard-heading");
  const heading = el("div");
  heading.append(
    el("h3", "Usage trends and distribution"),
    el("p", scope(report), "adoption-note"),
    el("p", freshness(report), "adoption-note"),
  );
  const actions = el("div");
  const csv = el("a", "Download report CSV", "adoption-export");
  csv.href = apiBase + "/api/adoption/export?" + query;
  csv.download = "adoption.csv";
  actions.append(
    csv,
    el(
      "p",
      "Exports follow the current date, department and member filters and include all request scenes.",
      "adoption-note",
    ),
  );
  top.append(heading, actions);
  const grid = el("div", null, "dashboard-grid");
  root.append(top, grid);
  const measures = { trend: "requests", department: "tokens" };
  for (const kind of ["trend", "department"] as const) {
    const card = el("section", null, "dashboard-card");
    card.append(el("h3", kind === "trend" ? "Daily usage trend" : "Usage by department"));
    const select = el("select");
    select.setAttribute("aria-label", kind === "trend" ? "Trend measure" : "Department measure");
    const options =
      kind === "trend"
        ? [
            ["requests", "Manual requests"],
            ["activePeople", "People with observed records"],
          ]
        : [
            ["requests", "Manual requests"],
            ["people", "People with observed records"],
            ["tokens", "Token usage"],
          ];
    for (const [value, label] of options) {
      const option = el("option", label);
      option.value = value;
      select.append(option);
    }
    select.value = measures[kind];
    const controls = el("div", null, "dashboard-card-controls");
    controls.append(select);
    card.append(controls);
    const plot = el("div", null, "dashboard-canvas");
    const accessible = el("details", null, "dashboard-data");
    accessible.append(el("summary", kind === "trend" ? "Show daily values" : "Show values and filter by department"));
    const values = el("div", null, "dashboard-values");
    accessible.append(values);
    const caption = el(
      "p",
      kind === "trend"
        ? "Shown by day from observed data; zeros are kept; gaps in history cannot be placed on a given day."
        : "Grouped by current registered department; click a bar or expand the values to filter members.",
      "adoption-note",
    );
    card.append(plot, caption, accessible);
    grid.append(card);
    const draw = () => {
      const measure = measures[kind];
      values.replaceChildren();
      plot.replaceChildren();
      if (kind === "trend") {
        const series = trendSeries(report, measure);
        for (const point of series.points)
          values.append(el("p", `${point.name}: ${valueText(report, point.raw, measure)}`));
        if (!report.summary.registeredPeople || !report.trend.length) {
          plot.append(el("p", "No data to show for the current filter", "dashboard-empty"));
          return;
        }
        plot.append(
          lineChart({
            aria: "Daily usage trend. Expand the daily values below to read exact figures. History completeness is unknown.",
            labels: series.points.map((p: any) => ({ short: p.name.slice(5).replace("-", "/"), full: p.name })),
            series: [
              {
                label: series.label,
                color: "var(--chart-accent)",
                dash: "",
                values: series.points.map((p: any) => p.value),
                area: true,
              },
            ],
          }),
        );
        return;
      }
      const series = departmentSeries(report, measure);
      const missing = measure === "tokens" ? "Not collected yet" : "Backfilling";
      for (const item of departmentData(report, measure)) {
        const text = `${item.name}: ${valueText(report, item.value, measure)}`;
        const b = el("button", text);
        b.type = "button";
        listen(b, "click", () => onDepartment(item.name));
        values.append(b);
      }
      if (!report.summary.registeredPeople) {
        plot.append(el("p", "No data to show for the current filter", "dashboard-empty"));
        return;
      }
      plot.append(
        barChart(
          {
            aria: "Usage by department. Expand the values below and use the keyboard to pick a department.",
            rows: series.bars.map((b: any) => ({
              name: b.name,
              value: b.value,
              text: b.value == null ? missing : compact(b.value),
              color: isUnassigned(b.name) ? "var(--chart-dim)" : "var(--chart-accent)",
              title: `${b.name} · ${series.label}: ${valueText(report, b.value, measure)}`,
              pick: () => onDepartment(b.name),
            })),
          },
          listen,
        ),
      );
    };
    listen(select, "change", () => {
      measures[kind] = select.value;
      draw();
    });
    draw();
  }
  root.append(createScenes(report, onDepartment, listen, apiBase, query));
  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    for (const cleanup of cleanups.splice(0)) cleanup();
  };
  return { element: root, dispose };
}
