import { createDashboard, freshness } from "./adoption-dashboard.ts";

export function adoption(root: HTMLElement, initial: any, s: Record<string, any>) {
  const { api, apiBase } = s;
  const { document, Option } = globalThis;
  const day = 86400000;
  const date = (ms: number) => new Date(ms + 28800000).toISOString().slice(0, 10);
  const when = (ms: number | null) =>
    ms == null ? "Unverified" : new Date(ms).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false });
  const node = (tag: string, text?: any, cls?: string): any => {
    const el = document.createElement(tag);
    if (tag === "th") (el as HTMLTableCellElement).scope = "col";
    if (text != null) el.textContent = text;
    if (cls) el.className = cls;
    return el;
  };
  const button = (text: string, action: () => void): any => {
    const b = node("button", text);
    b.type = "button";
    b.onclick = action;
    return b;
  };
  const field = (label: string, input: any): any => {
    const wrap = node("label");
    wrap.append(node("span", label));
    wrap.append(input);
    return wrap;
  };
  const input = (type: string, value = ""): any => {
    const el = node("input");
    el.type = type;
    el.value = value;
    return el;
  };
  root.classList.add("adoption-root");
  root.replaceChildren();
  let report = initial;
  let page = 0;
  let requestId = 0;
  let activeQuery = "";
  let sortBy = "name";
  const observed = (n: any, unit = "") => {
    if (n > 0) return String(n) + unit;
    return report.quality.projectionPending ? "Backfilling" : "Not observed yet";
  };
  const eligibility = (value: any) => {
    if (value === null) return "Unverified";
    return value ? "Verified" : "Not admitted at period end";
  };
  const title = node("div", null, "adoption-title");
  const intro = node("div");
  intro.append(
    node("h2", "Team usage overview"),
    node("p", "See how usage changes and find working methods worth sharing."),
  );
  title.append(
    intro,
    button("Register a tracked member", () => void editMember()),
  );
  const toolbar = node("form", null, "adoption-filters");
  const from = input("date", date(report.window.from));
  const through = input("date", date(report.window.to - day));
  from.max = through.max = date(Date.now());
  const department = node("select");
  department.append(new Option("All departments", ""));
  for (const d of report.departments) department.append(new Option(d, d));
  const search = input("search");
  search.placeholder = "Name or account";
  toolbar.append(
    field("From", from),
    field("To", through),
    field("Current department", department),
    field("Member", search),
  );
  const submit = node("button", "Apply filters");
  submit.type = "submit";
  toolbar.append(
    submit,
    button("Today", () => preset(1)),
    button("Last 7 days", () => preset(7)),
    button("Last 28 days", () => preset(28)),
    button("Clear filters", () => {
      department.value = "";
      search.value = "";
      preset(7);
    }),
  );
  const status = node("p", "", "adoption-status");
  status.setAttribute("role", "status");
  const body = node("div");
  const styles = node("style");
  styles.textContent = `.adoption-root{max-width:1200px;margin:auto}.adoption-title{display:flex;align-items:center;justify-content:space-between;gap:20px}.adoption-title p,.adoption-note{color:var(--muted,#707070);font-size:13px;line-height:1.7}.adoption-filters{display:flex;flex-wrap:wrap;align-items:end;gap:12px;margin:24px 0}.adoption-root label{display:flex;flex-direction:column;gap:6px;font-size:12px}.adoption-root input,.adoption-root select,.adoption-root button,.adoption-root .adoption-export{font:inherit;border:1px solid var(--border,#ddd);border-radius:8px;padding:10px 12px;min-height:42px;color:inherit;background:var(--bg,#fff)}.adoption-root button{cursor:pointer}.adoption-root button:disabled{opacity:.5;cursor:wait}.adoption-root input:focus-visible,.adoption-root button:focus-visible,.adoption-root select:focus-visible{outline:2px solid #537acb;outline-offset:2px}.adoption-root input[type=checkbox]{width:22px;min-height:22px}.adoption-trend{max-height:350px;overflow:auto}.adoption-trend-row{display:grid;grid-template-columns:90px 1fr 140px;gap:12px;align-items:center;margin:10px 0;font-size:12px}.adoption-trend-row meter{width:100%}.adoption-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px}.adoption-kpi,.adoption-panel{border:1px solid var(--border,#e5e5e5);border-radius:12px;padding:20px;margin-bottom:18px}.adoption-number{font-size:30px;font-weight:600;margin:8px 0}.adoption-section-head,.adoption-pages{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap}.adoption-export{display:inline-block;text-decoration:none}.adoption-depts{display:flex;flex-wrap:wrap;gap:8px;margin:16px 0}.adoption-table-wrap{overflow:auto}.adoption-table{width:100%;border-collapse:collapse;font-size:13px}.adoption-table th,.adoption-table td{text-align:left;padding:12px 8px;border-bottom:1px solid var(--border,#eee)}.adoption-table td{overflow-wrap:anywhere}.adoption-table .adoption-secondary{display:block;color:var(--muted,#777);font-size:12px;margin-top:4px}.adoption-status{color:#956016;min-height:20px}.adoption-dialog{width:min(560px,calc(100vw - 32px));box-sizing:border-box;border:1px solid #ddd;border-radius:16px;padding:24px;color:inherit;background:var(--bg,#fff);max-height:85dvh;overflow:auto}.adoption-dialog::backdrop{background:#0005}.adoption-dialog form{display:grid;gap:14px}.adoption-dialog label{display:flex;flex-direction:column;gap:6px}.adoption-dialog input{padding:10px;font:inherit;min-width:0}.adoption-dialog footer{display:flex;justify-content:flex-end;gap:10px}.adoption-dialog button{min-height:44px;padding:8px 16px}.adoption-weekly{white-space:pre-wrap;line-height:1.8}.adoption-root details summary{cursor:pointer;padding:8px 0}.adoption-root details li{margin:8px 0}@media(max-width:680px){.adoption-trend-row{grid-template-columns:80px 1fr;gap:6px}.adoption-trend-row>span:last-child{grid-column:2}.adoption-title{align-items:flex-start;flex-direction:column}.adoption-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.adoption-kpi,.adoption-panel{padding:14px}.adoption-filters>label{flex:1 1 130px;min-width:0}.adoption-filters input,.adoption-filters select{min-width:0;width:100%;box-sizing:border-box}.adoption-table thead{display:none}.adoption-table tr{display:block;border-bottom:1px solid #ddd;padding:10px 0}.adoption-table td{display:flex;justify-content:space-between;gap:14px;border:0;padding:6px 0}.adoption-table td:before{content:attr(data-label);color:var(--muted,#777);flex-shrink:0}.adoption-table td:first-child{display:block}.adoption-table td:first-child:before{display:none}}`;
  styles.textContent +=
    '.adoption-root {\n  --chart-ink: #233e38;\n  --chart-accent: #2c6b5c;\n  --chart-soft: #edf3ef;\n  --chart-line: #dce5df;\n  --chart-dim: #586860;\n  max-width: 1440px;\n  padding: 8px 0 32px;\n  color: #27362f;\n  font-variant-numeric: tabular-nums;\n}\n.adoption-root h2 {\n  font-size: clamp(22px, 2.4vw, 32px);\n  letter-spacing: -0.035em;\n  margin: 10px 0;\n  font-weight: 650;\n}\n.adoption-root h3 {\n  font-size: 18px;\n  letter-spacing: -0.02em;\n  margin: 0;\n}\n.adoption-eyebrow {\n  font-size: 11px;\n  font-weight: 700;\n  letter-spacing: 0.16em;\n  color: var(--chart-accent);\n}\n.adoption-title > button {\n  border-radius: 24px;\n  white-space: nowrap;\n  background: var(--chart-ink);\n  color: white;\n  border-color: var(--chart-ink);\n  padding: 10px 18px;\n}\n.adoption-title p {\n  margin: 8px 0;\n  color: var(--chart-dim);\n}\n.adoption-filters {\n  background: white;\n  border: 1px solid var(--chart-line);\n  padding: 18px;\n  border-radius: 18px;\n  margin: 24px 0 0;\n  gap: 10px;\n}\n.adoption-filters > label {\n  flex: 1 1 125px;\n  min-width: 0;\n}\n.adoption-filters input,\n.adoption-filters select {\n  min-width: 0;\n  width: 100%;\n  box-sizing: border-box;\n  background: #fafcf9;\n  border-color: var(--chart-line);\n}\n.adoption-filters > button[type="submit"] {\n  background: var(--chart-ink);\n  color: #fff;\n  border-color: var(--chart-ink);\n}\n.adoption-root button:focus-visible,\n.adoption-root input:focus-visible,\n.adoption-root select:focus-visible,\n.adoption-root a:focus-visible {\n  outline: 3px solid var(--chart-accent);\n  outline-offset: 3px;\n}\n.adoption-status {\n  font-size: 12px;\n  margin: 8px 4px 14px;\n  color: var(--chart-dim);\n  min-height: 18px;\n}\n.adoption-summary {\n  display: grid;\n  grid-template-columns: repeat(4, minmax(0, 1fr));\n  gap: 14px;\n  margin: 0 0 14px;\n}\n.adoption-summary-card {\n  background: white;\n  border: 1px solid var(--chart-line);\n  border-radius: 18px;\n  padding: 22px;\n  min-width: 0;\n}\n.adoption-summary-card:first-child {\n  background: var(--chart-ink);\n  color: white;\n  border-color: var(--chart-ink);\n}\n.adoption-summary-card:first-child .adoption-note {\n  color: #cbdcd3;\n}\n.adoption-summary-label {\n  font-size: 13px;\n}\n.adoption-summary-value {\n  font-size: clamp(30px, 3vw, 43px);\n  font-weight: 650;\n  letter-spacing: -0.035em;\n  line-height: 1.3;\n  margin: 10px 0 8px;\n  overflow-wrap: anywhere;\n}\n.adoption-summary-unit {\n  font-size: 13px;\n  font-weight: 400;\n  margin-left: 6px;\n  letter-spacing: 0;\n}\n.adoption-note {\n  color: var(--chart-dim);\n  font-size: 12px;\n}\n.adoption-charts {\n  display: grid;\n  grid-template-columns: 1.05fr 1fr;\n  gap: 20px;\n  margin: 24px 0;\n}\n.adoption-chart-card {\n  background: #fff;\n  border: 1px solid var(--chart-line);\n  border-radius: 20px;\n  padding: 24px;\n  min-width: 0;\n}\n.adoption-chart-head {\n  display: flex;\n  justify-content: space-between;\n  gap: 12px;\n  align-items: start;\n  margin-bottom: 12px;\n}\n.adoption-chart-no {\n  font-size: 12px;\n  letter-spacing: 0.12em;\n  color: var(--chart-dim);\n  margin: 0 0 12px;\n}\n.adoption-chart-card p {\n  line-height: 1.65;\n}\n.adoption-chart-caption {\n  font-size: 12px;\n  color: var(--chart-dim);\n  margin: 8px 0 18px;\n}\n.adoption-root .adoption-chart-reset {\n  border: 0;\n  color: var(--chart-accent);\n  background: var(--chart-soft);\n  font-size: 12px;\n  white-space: nowrap;\n  padding: 8px 12px;\n}\n.adoption-chart-tabs {\n  display: flex;\n  gap: 4px;\n  background: var(--chart-soft);\n  border-radius: 10px;\n  padding: 4px;\n  width: fit-content;\n  margin: 12px 0 20px;\n}\n.adoption-root .adoption-chart-tab {\n  border: 0;\n  background: transparent;\n  padding: 8px 14px;\n  min-height: 36px;\n  font-size: 12px;\n  color: var(--chart-dim);\n}\n.adoption-root .adoption-chart-tab[aria-pressed="true"] {\n  background: white;\n  color: var(--chart-ink);\n  font-weight: 650;\n}\n.adoption-chart-rows {\n  display: grid;\n  gap: 6px;\n}\n.adoption-root .adoption-chart-row {\n  display: grid;\n  grid-template-columns: minmax(94px, 130px) minmax(0, 1fr) max-content;\n  align-items: center;\n  gap: 12px;\n  border: 0;\n  background: transparent;\n  padding: 9px 6px;\n  border-radius: 9px;\n  width: 100%;\n  text-align: left;\n  min-height: 42px;\n  font-size: 13px;\n  transition: background 0.16s ease;\n}\n.adoption-root .adoption-chart-row:hover,\n.adoption-root .adoption-chart-row:focus-visible {\n  background: var(--chart-soft);\n}\n.adoption-chart-name {\n  overflow-wrap: anywhere;\n}\n.adoption-chart-track {\n  height: 14px;\n  background: #f0f3f0;\n  border-radius: 4px;\n  overflow: hidden;\n}\n.adoption-chart-bar {\n  height: 100%;\n  background: var(--chart-accent);\n  border-radius: 4px;\n  transform-origin: left;\n  animation: adoption-grow 0.45s ease both;\n}\n.adoption-chart-row[data-unassigned="true"] .adoption-chart-bar {\n  background: #88978f;\n}\n.adoption-chart-value {\n  text-align: right;\n  font-weight: 650;\n  min-width: 45px;\n}\n.adoption-chart-footer {\n  font-size: 11px;\n  line-height: 1.7;\n  color: var(--chart-dim);\n  border-top: 1px solid var(--chart-line);\n  padding-top: 14px;\n  margin: 18px 0 0;\n}\n.adoption-plot {\n  display: grid;\n  grid-template-columns: max-content minmax(0, 1fr);\n  gap: 8px;\n  margin: 22px 0 0;\n}\n.adoption-plot-scale {\n  min-width: 28px;\n  height: 200px;\n  display: flex;\n  flex-direction: column;\n  justify-content: space-between;\n  font-size: 11px;\n  color: var(--chart-dim);\n  text-align: right;\n}\n.adoption-plot-surface {\n  min-width: 0;\n}\n.adoption-plot-svg {\n  display: block;\n  width: 100%;\n  height: 200px;\n  overflow: visible;\n  touch-action: pan-y;\n}\n.adoption-plot-labels {\n  position: relative;\n  height: 32px;\n  margin-top: 10px;\n  font-size: 11px;\n  color: var(--chart-dim);\n}\n.adoption-plot-label {\n  position: absolute;\n  transform: translateX(-50%);\n  white-space: nowrap;\n}\n.adoption-plot-label:first-child {\n  transform: none;\n}\n.adoption-plot-label:last-child {\n  transform: translateX(-100%);\n}\n.adoption-plot-readout {\n  background: var(--chart-soft);\n  border-radius: 14px;\n  padding: 16px 18px;\n  display: grid;\n  grid-template-columns: 1fr 1fr;\n  gap: 14px;\n  margin-top: 12px;\n}\n.adoption-plot-date {\n  grid-column: 1/-1;\n  font-size: 12px;\n  font-weight: 600;\n  letter-spacing: 0.02em;\n}\n.adoption-plot-stat {\n  font-size: 24px;\n  font-weight: 650;\n}\n.adoption-plot-stat span {\n  display: block;\n  font-size: 11px;\n  font-weight: 400;\n  color: var(--chart-dim);\n  margin-top: 5px;\n}\n.adoption-root .adoption-plot-slider {\n  padding: 0;\n  min-height: 44px;\n  width: 100%;\n  accent-color: var(--chart-accent);\n  border: 0;\n}\n.adoption-plot-control {\n  margin-top: 14px;\n}\n.adoption-plot-control > span {\n  font-size: 11px;\n  color: var(--chart-dim);\n}\n.adoption-chart-empty {\n  display: flex;\n  min-height: 220px;\n  align-items: center;\n  justify-content: center;\n  color: var(--chart-dim);\n  font-size: 14px;\n}\n.adoption-panel {\n  background: white;\n  border-color: var(--chart-line);\n  border-radius: 18px;\n}\n.adoption-depts {\n  gap: 6px;\n}\n.adoption-depts button {\n  font-size: 12px;\n  padding: 6px 10px;\n  min-height: 36px;\n}\n.adoption-table th {\n  font-size: 11px;\n  color: var(--chart-dim);\n  font-weight: 600;\n  white-space: nowrap;\n}\n.adoption-table tbody tr:hover {\n  background: #f7faf7;\n}\n.adoption-section-head {\n  margin-bottom: 14px;\n}\n.adoption-section-head > div {\n  display: flex;\n  gap: 8px;\n  flex-wrap: wrap;\n}\n.adoption-root .adoption-export[href] {\n  color: var(--chart-accent);\n  border-color: var(--chart-line);\n}\n.adoption-root .adoption-pages {\n  justify-content: flex-end;\n}\n.adoption-pages p {\n  margin-right: auto;\n  color: var(--chart-dim);\n  font-size: 12px;\n}\n@keyframes adoption-grow {\n  from {\n    transform: scaleX(0);\n  }\n  to {\n    transform: scaleX(1);\n  }\n}\n@media (prefers-reduced-motion: reduce) {\n  .adoption-chart-bar {\n    animation: none;\n  }\n  .adoption-root * {\n    scroll-behavior: auto;\n    transition: none;\n  }\n}\n@media (max-width: 1050px) {\n  .adoption-summary-card {\n    padding: 18px;\n  }\n  .adoption-charts {\n    grid-template-columns: 1fr;\n  }\n}\n@media (max-width: 680px) {\n  .adoption-root {\n    padding: 0 0 24px;\n  }\n  .adoption-summary {\n    grid-template-columns: repeat(2, minmax(0, 1fr));\n    gap: 10px;\n  }\n  .adoption-summary-card {\n    padding: 16px;\n  }\n  .adoption-summary-value {\n    font-size: 30px;\n  }\n  .adoption-title {\n    gap: 12px;\n  }\n  .adoption-filters {\n    padding: 14px;\n  }\n  .adoption-chart-card {\n    padding: 18px;\n  }\n  .adoption-root .adoption-chart-row {\n    grid-template-columns: 100px minmax(0, 1fr) max-content;\n    gap: 8px;\n    font-size: 12px;\n  }\n  .adoption-chart-head h3 {\n    font-size: 17px;\n  }\n  .adoption-plot {\n    grid-template-columns: max-content minmax(0, 1fr);\n    gap: 6px;\n  }\n  .adoption-plot-labels {\n    font-size: 10px;\n  }\n  .adoption-table td {\n    max-width: 100%;\n    box-sizing: border-box;\n  }\n  .adoption-section-head > div {\n    width: 100%;\n  }\n}\n\n.adoption-data-status {\n  grid-column: 1/-1;\n  font-size: 12px;\n  color: var(--chart-dim);\n  margin: 0;\n  line-height: 1.6;\n}\n.adoption-plot-label:only-child {\n  transform: translateX(-50%);\n}\n\n@media (max-width: 680px) {\n  .adoption-chart-value {\n    min-width: 36px;\n  }\n}\n\n.adoption-root .adoption-depts button[aria-pressed="true"] {\n  background: var(--chart-accent);\n  border-color: var(--chart-accent);\n  color: white;\n  font-weight: 700;\n  box-shadow: 0 0 0 2px var(--chart-soft);\n}\n.adoption-root .adoption-chart-row[aria-pressed="true"] {\n  background: var(--chart-soft);\n  outline: 2px solid var(--chart-accent);\n  outline-offset: -2px;\n}\n.adoption-execution {\n  min-width: 110px;\n  display: grid;\n  gap: 5px;\n}\n.adoption-execution-done {\n  color: var(--chart-accent);\n  font-weight: 650;\n}\n.adoption-execution-neutral {\n  color: var(--chart-ink);\n  font-weight: 500;\n}\n.adoption-execution-part {\n  color: var(--chart-dim);\n  font-size: 12px;\n}\n';
  styles.textContent +=
    '.wrap:has(.adoption-root) {\n  max-width: 1600px;\n  width: 100%;\n  box-sizing: border-box;\n}\n.admin-inner:has(> .adoption-root) {\n  width: 100%;\n  max-width: 1480px;\n  box-sizing: border-box;\n}\n.adoption-root {\n  width: 100%;\n  max-width: 1480px;\n  box-sizing: border-box;\n  font-size: 14px;\n  --chart-dim: #52645b;\n}\n.adoption-root h2 {\n  font-size: 28px;\n  letter-spacing: -0.025em;\n}\n.adoption-root h3 {\n  font-size: 17px;\n}\n.adoption-root .adoption-title > button {\n  border-radius: 8px;\n  background: #fff;\n  color: #233e38;\n  border-color: #ccd9d0;\n}\n.adoption-root .adoption-filters {\n  border-radius: 12px;\n  padding: 16px;\n  margin: 20px 0 0;\n}\n.adoption-root .adoption-filters > label {\n  flex: 1 1 135px;\n}\n.adoption-root .adoption-summary {\n  gap: 12px;\n  margin-bottom: 20px;\n}\n.adoption-root .adoption-summary-card {\n  border-radius: 12px;\n  padding: 18px 20px;\n}\n.adoption-root .adoption-summary-card:first-child {\n  background: #fff;\n  color: #233e38;\n  border-color: #ccd9d0;\n}\n.adoption-root .adoption-summary-card:first-child .adoption-note {\n  color: #52645b;\n}\n.adoption-root .adoption-summary-value {\n  font-size: 34px;\n  margin: 8px 0;\n  line-height: 1.25;\n}\n.adoption-root .adoption-summary-label {\n  color: #52645b;\n}\n.adoption-root .adoption-note {\n  font-size: 12px;\n  color: #52645b;\n  line-height: 1.6;\n}\n.adoption-root .adoption-panel {\n  border-radius: 12px;\n  padding: 20px;\n}\n.adoption-dashboard {\n  margin: 24px 0;\n}\n.dashboard-heading {\n  display: flex;\n  justify-content: space-between;\n  gap: 16px;\n  align-items: flex-start;\n  margin-bottom: 14px;\n}\n.dashboard-heading p {\n  margin: 6px 0 0;\n}\n.dashboard-grid {\n  display: grid;\n  grid-template-columns: minmax(0, 1.25fr) minmax(0, 1fr);\n  gap: 16px;\n  align-items: start;\n}\n.dashboard-card {\n  background: #fff;\n  border: 1px solid #dce5df;\n  border-radius: 12px;\n  padding: 20px;\n  min-width: 0;\n}\n.adoption-dashboard > .dashboard-grid > .dashboard-card {\n  display: grid;\n  grid-template-columns: minmax(0, 1fr) auto;\n  column-gap: 12px;\n  align-items: center;\n}\n.adoption-dashboard > .dashboard-grid > .dashboard-card > h3 {\n  margin: 0;\n}\n.adoption-dashboard > .dashboard-grid > .dashboard-card > :not(h3, .dashboard-card-controls) {\n  grid-column: 1 / -1;\n}\n.adoption-dashboard > .dashboard-grid > .dashboard-card > .dashboard-canvas {\n  margin-top: 16px;\n}\n.adoption-dashboard > .dashboard-grid > .dashboard-card > .adoption-note {\n  margin-bottom: 0;\n}\n.dashboard-card-controls {\n  display: flex;\n  justify-content: flex-end;\n  min-width: 0;\n}\n.adoption-root .dashboard-card-controls select,\n.adoption-root .dashboard-card-controls .dd {\n  width: auto;\n  min-width: 150px;\n  max-width: 100%;\n}\n.adoption-root .dashboard-card-controls .dd-menu {\n  left: auto;\n  right: 0;\n}\n.dashboard-canvas {\n  width: 100%;\n  min-width: 0;\n}\n.dashboard-export {\n  position: relative;\n  flex-shrink: 0;\n}\n.adoption-root .dashboard-export > summary {\n  list-style: none;\n  border: 1px solid #233e38;\n  background: #233e38;\n  color: white;\n  border-radius: 8px;\n  padding: 10px 16px;\n  min-height: 42px;\n  box-sizing: border-box;\n  font-size: 13px;\n  white-space: nowrap;\n}\n.dashboard-export > summary::-webkit-details-marker {\n  display: none;\n}\n.dashboard-export-menu {\n  position: absolute;\n  right: 0;\n  top: 48px;\n  z-index: 10;\n  width: 230px;\n  padding: 6px;\n  background: white;\n  box-shadow: 0 8px 24px #233e381a;\n  border: 1px solid #dce5df;\n  border-radius: 10px;\n  display: grid;\n  gap: 2px;\n}\n.adoption-root .dashboard-export-menu button {\n  border: 0;\n  text-align: left;\n  background: white;\n}\n.adoption-root .dashboard-export-menu button:hover {\n  background: #edf3ef;\n}\n.adoption-root summary:focus-visible {\n  outline: 3px solid #2c6b5c;\n  outline-offset: 3px;\n}\n.dashboard-data {\n  border-top: 1px solid #e4eae6;\n  font-size: 12px;\n  margin-top: 14px;\n}\n.dashboard-values {\n  max-height: 260px;\n  overflow: auto;\n  display: grid;\n  gap: 4px;\n}\n.dashboard-values p {\n  margin: 0;\n  padding: 6px 0;\n}\n.adoption-root .dashboard-values button {\n  text-align: left;\n  border: 0;\n  background: #f7faf8;\n  font-size: 12px;\n}\n.dashboard-empty {\n  display: grid;\n  place-items: center;\n  height: 100%;\n  color: #52645b;\n}\n.adoption-root .token-panel .adoption-summary {\n  margin-top: 16px;\n}\n.adoption-root .token-panel .adoption-summary-card {\n  background: #f7faf8;\n  border: 0;\n  padding: 14px;\n}\n.adoption-root .token-panel .adoption-summary-value {\n  font-size: 28px;\n}\n.adoption-root .adoption-table-wrap {\n  max-height: 640px;\n  overflow: auto;\n  overscroll-behavior: contain;\n  margin-top: 14px;\n}\n.adoption-root .adoption-table th {\n  position: sticky;\n  top: 0;\n  background: #f5f8f6;\n  z-index: 1;\n  font-size: 12px;\n}\n.adoption-root .adoption-table td {\n  vertical-align: top;\n  padding: 12px 10px;\n  line-height: 1.5;\n}\n.adoption-root .adoption-members-table {\n  min-width: 940px;\n}\n.adoption-root .adoption-members-table td:first-child {\n  min-width: 170px;\n  max-width: 230px;\n}\n.adoption-root .adoption-members-table td:nth-child(8) {\n  min-width: 145px;\n}\n.adoption-root .adoption-members-table td:nth-child(10) {\n  min-width: 120px;\n}\n.adoption-root .adoption-members-table:not(.show-all) :is(th, td):nth-child(3),\n.adoption-root .adoption-members-table:not(.show-all) :is(th, td):nth-child(4),\n.adoption-root .adoption-members-table:not(.show-all) :is(th, td):nth-child(9) {\n  display: none;\n}\n.adoption-root .adoption-table .adoption-secondary {\n  font-size: 11px;\n  color: #52645b;\n}\n.adoption-root .adoption-table details summary {\n  padding: 3px 0;\n  font-size: 12px;\n  color: #2c6b5c;\n}\n.adoption-root .adoption-pages {\n  padding-top: 16px;\n}\n.adoption-root .adoption-depts {\n  margin: 12px 0;\n  gap: 5px;\n}\n.adoption-root .adoption-depts button {\n  min-height: 32px;\n  padding: 4px 10px;\n}\n.adoption-root .adoption-status:empty {\n  min-height: 8px;\n  margin: 0;\n}\n@media (max-width: 1050px) {\n  .dashboard-grid {\n    grid-template-columns: 1fr;\n  }\n}\n@media (max-width: 680px) {\n  .wrap:has(.adoption-root) {\n    padding-left: 16px;\n    padding-right: 16px;\n  }\n  .adoption-root h2 {\n    font-size: 24px;\n  }\n  .adoption-root .adoption-summary-card {\n    padding: 14px;\n  }\n  .adoption-root .adoption-summary-value {\n    font-size: 28px;\n  }\n  .dashboard-heading {\n    flex-direction: column;\n  }\n  .dashboard-export-menu {\n    right: auto;\n    left: 0;\n  }\n  .dashboard-card {\n    padding: 16px;\n  }\n  .adoption-dashboard > .dashboard-grid > .dashboard-card {\n    grid-template-columns: minmax(0, 1fr);\n  }\n  .dashboard-card-controls {\n    justify-content: flex-start;\n    margin-top: 10px;\n  }\n  .adoption-root .dashboard-card-controls .dd-menu {\n    left: 0;\n    right: auto;\n  }\n  .adoption-root .adoption-panel {\n    padding: 16px;\n  }\n  .adoption-root .adoption-members-table {\n    min-width: 0;\n  }\n  .adoption-root .adoption-members-table td:first-child {\n    max-width: none;\n  }\n  .adoption-root .adoption-members-table td {\n    min-width: 0;\n    padding: 6px 0;\n  }\n  .adoption-root .adoption-table-wrap {\n    max-height: 700px;\n  }\n  .adoption-root .token-panel .adoption-summary-value {\n    font-size: 24px;\n  }\n}\n\n.scenario-section {\n  margin-top: 24px;\n  padding-top: 20px;\n  border-top: 1px solid #dce5df;\n}\n.scenario-section > .dashboard-card {\n  margin: 18px 0;\n}\n.scenario-scroll {\n  overflow: auto;\n  max-width: 100%;\n}\n.scenario-table {\n  width: 100%;\n  border-collapse: collapse;\n  font-variant-numeric: tabular-nums;\n}\n.scenario-table th,\n.scenario-table td {\n  padding: 10px 9px;\n  text-align: left;\n  border-bottom: 1px solid #e5ebe7;\n  white-space: nowrap;\n}\n.scenario-table th {\n  font-size: 12px;\n  color: #586860;\n}\n.scenario-table tr[data-selected="true"] {\n  background: #edf3ef;\n}\n.scenario-table button {\n  font-size: 13px;\n  text-align: left;\n}\n.scenario-plot {\n  height: 300px;\n  position: relative;\n  margin-top: 12px;\n}\n.scenario-section > h3 {\n  font-size: 18px;\n}\n.scenario-section label {\n  display: flex;\n  gap: 8px;\n  align-items: center;\n}\n.scenario-section select {\n  min-width: 0;\n  max-width: 100%;\n}\n@media (max-width: 600px) {\n  .scenario-table th,\n  .scenario-table td {\n    padding: 9px 6px;\n    font-size: 12px;\n  }\n  .scenario-plot {\n    height: 250px;\n  }\n  .scenario-section label {\n    flex-wrap: wrap;\n  }\n}\n';
  root.append(styles, title, toolbar, status, body);
  toolbar.onsubmit = (e: Event) => {
    e.preventDefault();
    void load();
  };
  function query() {
    const end = Date.parse(`${through.value}T00:00:00+08:00`) + day;
    if (!from.value || !through.value || !Number.isFinite(end)) throw new Error("Choose a date range.");
    const params = new URLSearchParams({ from: from.value, to: date(end) });
    if (department.value) params.set("department", department.value);
    if (search.value.trim()) params.set("search", search.value.trim());
    return params.toString();
  }
  function preset(days: number) {
    const end = Math.floor((Date.now() + 28800000) / day) * day - 28800000 + day;
    from.max = through.max = date(end - day);
    from.value = date(end - days * day);
    through.value = date(end - day);
    void load();
  }
  async function load() {
    const id = ++requestId;
    submit.disabled = true;
    status.textContent = "Checking data…";
    body.setAttribute("aria-busy", "true");
    try {
      const q = query();
      const r = await api("GET", "/api/adoption?" + q);
      if (id !== requestId || !root.contains(body)) return;
      if (!r.ok) throw new Error(r.data?.message || `Failed to load (${r.status})`);
      report = r.data;
      activeQuery = q;
      page = 0;
      const selected = report.window.department || "";
      department.replaceChildren(new Option("All departments", ""));
      for (const d of report.departments) department.append(new Option(d, d));
      department.value = selected;
      draw();
      status.textContent = "Data updated.";
    } catch (error: any) {
      if (id === requestId)
        status.textContent = `${error.message} The last data that loaded successfully is kept below.`;
    } finally {
      if (id === requestId) {
        submit.disabled = false;
        body.removeAttribute("aria-busy");
      }
    }
  }
  const number = (value: any) => Number(value).toLocaleString("zh-CN");
  function drawSummary(summary: any) {
    const grid = node("section", null, "adoption-summary");
    grid.setAttribute("aria-label", "Usage overview metrics");
    for (const [label, value, unit, help] of [
      ["Observed human requests", number(summary.requests), "times", "Retries of the same request count once"],
      [
        "Observed active this period",
        number(summary.activePeople + summary.otherActivePeople),
        "people",
        "Includes members whose admission is unverified or who were not admitted at period end",
      ],
      [
        "Tracked members",
        number(summary.registeredPeople),
        "people",
        "Current filtered roster, including members with no observed activity",
      ],
      [
        "First observed this period",
        number(summary.firstObservedPeople),
        "people",
        "First seen in the records that still exist, which is not the same as first use",
      ],
    ]) {
      const card = node("div", null, "adoption-summary-card");
      const pending = report.quality.projectionPending && value === "0" && label !== "Tracked members";
      const valueNode = node("div", pending ? "Backfilling" : value, "adoption-summary-value");
      if (!pending) valueNode.append(node("span", unit, "adoption-summary-unit"));
      card.append(node("span", label, "adoption-summary-label"), valueNode, node("div", help, "adoption-note"));
      grid.append(card);
    }
    grid.append(
      node(
        "p",
        `Basis: observed lower bound · full usage coverage unknown · ${number(report.quality.unknownEligibility)} people with an unverified start date${report.quality.projectionPending ? " · history is still backfilling, so these figures are incomplete" : ""}`,
        "adoption-data-status",
      ),
    );
    return grid;
  }
  function drawExecution(member: any) {
    const cell = node("div", null, "adoption-execution");
    if (!member.requests) {
      cell.append(
        node("span", report.quality.projectionPending ? "Backfilling" : "No records this period", "adoption-secondary"),
      );
      return cell;
    }
    if (report.quality.projectionPending)
      cell.append(node("span", "Backfilling · the part checked so far", "adoption-secondary"));
    if (member.succeeded > 0)
      cell.append(node("strong", `Completed normally ${number(member.succeeded)}`, "adoption-execution-done"));
    else
      cell.append(
        node(
          "strong",
          (member.unknownTerminal || 0) + (member.sourceMissing || 0) > 0
            ? "Completions unverified"
            : "Completed normally 0",
          "adoption-execution-neutral",
        ),
      );
    for (const [key, label] of [
      ["failed", "Failed"],
      ["stopped", "Stopped on purpose"],
      ["unknownTerminal", "Unverified"],
      ["otherTerminal", "Other endings"],
      ["paused", "Paused for approval"],
      ["handedOff", "Handed off"],
      ["pending", "Running"],
      ["sourceMissing", "Source record missing"],
    ])
      if (member[key] > 0) cell.append(node("span", `${label} ${number(member[key])}`, "adoption-execution-part"));
    cell.title =
      "Each request falls into exactly one outcome. Unverified means the kept evidence is not enough, not that the request failed. Other endings include declined and reaction-only requests. Paused for approval and handed off are listed separately and are not counted as finished records.";
    return cell;
  }

  function executionCount(value: any, unit = "") {
    return `${number(value || 0)}${unit}${report.quality.projectionPending ? " (backfilling)" : ""}`;
  }

  const tokenNumber = (n: any) => Number(n).toLocaleString("zh-CN");
  const tokenUnitOptions: [string, string][] = [
    ["auto", "Auto (×10k / ×100M)"],
    ["million", "Millions (M)"],
    ["exact", "Exact values"],
  ];
  let tokenUnit = "auto";
  try {
    const saved = globalThis.localStorage?.getItem("coworker.admin.token-unit");
    if (saved && tokenUnitOptions.some(([key]) => key === saved)) tokenUnit = saved;
  } catch {
    tokenUnit = "auto";
  }
  function formatTokenValue(n: any, mode = tokenUnit) {
    if (!Number.isSafeInteger(n) || n < 0) return { value: "Unverified", unit: "" };
    if (mode === "exact") return { value: tokenNumber(n), unit: "" };
    const rounded = (value: number) => value.toLocaleString("zh-CN", { maximumFractionDigits: 2 });
    if (mode === "million") {
      return { value: n > 0 && n < 10000 ? "<0.01" : rounded(n / 1e6), unit: " M" };
    }
    for (const [scale, unit] of [
      [1e12, "×1T"],
      [1e8, "×100M"],
      [1e4, "×10k"],
    ] as [number, string][]) {
      if (n >= scale || (scale > 1e4 && n >= scale - scale / 2000000)) {
        return { value: rounded(n / scale), unit };
      }
    }
    return { value: tokenNumber(n), unit: "" };
  }
  function updateTokenValue(el: any, n: any) {
    const { value, unit } = formatTokenValue(n);
    el.replaceChildren(document.createTextNode(value));
    if (unit) el.append(node("span", unit, "token-unit"));
    const exact = Number.isSafeInteger(n) && n >= 0 ? `${tokenNumber(n)} Token` : "Usage unverified";
    el.title = exact;
    el.setAttribute("aria-label", exact);
  }
  function tokenValue(n: any, tag = "span") {
    const el = node(tag, null, "token-value");
    el.dataset.tokenValue = Number.isSafeInteger(n) && n >= 0 ? String(n) : "invalid";
    updateTokenValue(el, n);
    return el;
  }
  function tokenBreakdown(parts: [string, any][]) {
    const line = node("span", null, "adoption-secondary");
    parts.forEach(([label, n], index) => {
      if (index) line.append(document.createTextNode(" · "));
      line.append(document.createTextNode(label + " "), tokenValue(n));
    });
    return line;
  }
  function tokenCell(usage: any) {
    const cell = node("div");
    cell.style.display = "grid";
    cell.style.gap = "4px";
    if (!usage) return node("span", "Not collected");
    cell.append(usage.measuredCalls ? tokenValue(usage.total, "strong") : node("strong", "Not collected"));
    cell.append(
      node(
        "span",
        `With usage ${tokenNumber(usage.measuredCalls)} / attributed ${tokenNumber(usage.calls)} records`,
        "adoption-secondary",
      ),
    );
    if (usage.measuredCalls) {
      cell.append(
        tokenBreakdown([
          ["Input", usage.input],
          ["Output", usage.output],
        ]),
      );
      cell.append(
        tokenBreakdown([
          ["Cache read", usage.cacheRead],
          ["Cache write", usage.cacheWrite],
        ]),
      );
    }
    if (usage.measuredCalls && usage.other > 0) cell.append(tokenBreakdown([["Other metered", usage.other]]));
    if (cell.children.length > 1) {
      const detail = node("details");
      detail.append(node("summary", "Usage details"));
      while (cell.children.length > 1) detail.append(cell.children[1]);
      cell.append(detail);
    }
    return cell;
  }
  function drawTokens() {
    const panel = node("section", null, "adoption-panel");
    panel.classList.add("token-panel");
    panel.dataset.tokenUnit = tokenUnit;
    const heading = node("div", null, "adoption-section-head");
    const units = node("select");
    units.setAttribute("aria-label", "Token display unit");
    for (const [key, label] of tokenUnitOptions) units.append(new Option(label, key));
    units.value = tokenUnit;
    units.onchange = () => {
      tokenUnit = units.value;
      panel.dataset.tokenUnit = tokenUnit;
      root
        .querySelectorAll("[data-token-value]")
        .forEach((el) => updateTokenValue(el, Number((el as HTMLElement).dataset.tokenValue)));
      try {
        globalThis.localStorage?.setItem("coworker.admin.token-unit", tokenUnit);
      } catch {
        return;
      }
    };
    heading.append(node("h3", "Token usage"), field("Display unit", units));
    const style = node("style");
    style.textContent =
      ".token-panel>.adoption-section-head{margin-bottom:14px}.token-value{font-variant-numeric:tabular-nums;white-space:nowrap}.token-panel .adoption-summary-value{font-size:clamp(24px,2.6vw,38px)}.token-panel[data-token-unit=exact] .adoption-summary-value{font-size:clamp(20px,2vw,28px)}@media(max-width:680px){.token-panel[data-token-unit=exact] .adoption-summary{grid-template-columns:minmax(0,1fr)}}.token-panel .adoption-summary-value .token-value{white-space:normal;overflow-wrap:anywhere}.token-panel .adoption-summary-value .token-unit{font-size:.55em;font-weight:500;letter-spacing:0;margin-left:3px}@media(min-width:681px){.token-panel .adoption-table th:not(:first-child),.token-panel .adoption-table td:not(:first-child){text-align:right}}";
    panel.append(heading, style);
    panel.append(
      node(
        "p",
        "1 M = 1 million Token; ×100M = 100 M. Shortened values keep at most two decimals; the exact mode and the export keep precise values.",
        "adoption-note",
      ),
    );
    panel.append(
      node(
        "p",
        "A Token is the unit the model uses to process text. It is not the same as word count, cost or work results. Departments and people only add up usage from human-initiated requests with a confirmed requester, within the current filter and by the time of the model call (Beijing time).",
        "adoption-note",
      ),
    );
    if (!report.summary.tokens) {
      panel.append(node("p", "Token data is not connected yet. Refresh after the service is updated."));
      return panel;
    }
    if (report.tokenQuality?.available === false) {
      panel.append(
        node(
          "p",
          "The usage data source is not initialised, so Token cannot be counted now. Refresh after model usage collection is enabled.",
        ),
      );
      return panel;
    }
    const summary = report.summary.tokens;
    const overview = node("div", null, "adoption-summary");
    overview.setAttribute("aria-label", "Token usage overview");
    for (const [key, label, help] of [
      [
        "total",
        "Total recorded Token",
        summary.other > 0 ? tokenBreakdown([["Of which other metered", summary.other]]) : "Current filter",
      ],
      ["input", "Uncached input", "Does not include cache again"],
      ["output", "Output", "Content the model generated"],
      [
        "cacheRead",
        "Cache read",
        summary.measuredCalls
          ? tokenBreakdown([["Plus cache write", summary.cacheWrite]])
          : "Cache write not collected",
      ],
    ]) {
      const card = node("div", null, "adoption-summary-card");
      const value = node("div", null, "adoption-summary-value");
      value.append(summary.measuredCalls ? tokenValue(summary[key], "strong") : node("strong", "Not collected"));
      const note = node("div", null, "adoption-note");
      note.append(typeof help === "string" ? document.createTextNode(help) : help);
      card.append(node("span", label, "adoption-summary-label"), value, note);
      overview.append(card);
    }
    panel.append(
      overview,
      node(
        "p",
        `With usage ${tokenNumber(summary.measuredCalls)} / attributed ${tokenNumber(summary.calls)} records${summary.calls ? ` (${((summary.measuredCalls / summary.calls) * 100).toFixed(1)}%)` : ""}. Some run modes may merge several calls into one record.`,
        "adoption-note",
      ),
    );
    panel.append(
      node(
        "p",
        "Total = uncached input + output + cache read + cache write + other metered. Input does not include cache again. Other metered keeps the part of the total that is not listed separately, such as reasoning usage in some run modes. Only recorded usage is added up; missing usage is not counted as 0, and a record that was not observed shows Not collected.",
        "adoption-note",
      ),
    );
    const wrap = node("div", null, "adoption-table-wrap");
    const table = node("table", null, "adoption-table");
    const head = node("tr");
    const labels = [
      "Current department",
      "Recorded Token",
      "With usage / attributed records",
      "Uncached input",
      "Output",
      "Cache read",
      "Cache write",
      "Other metered",
    ];
    labels.forEach((label) => head.append(node("th", label)));
    const thead = node("thead");
    thead.append(head);
    table.append(thead);
    const tbody = node("tbody");
    for (const departmentRow of [...report.departmentMetrics].sort(
      (a, b) => (b.tokens?.total ?? 0) - (a.tokens?.total ?? 0),
    )) {
      const usage = departmentRow.tokens;
      if (!usage) continue;
      const row = node("tr");
      const values = [
        button(departmentRow.department, () => {
          department.value = departmentRow.department;
          void load();
        }),
        usage.measuredCalls ? tokenValue(usage.total) : "Not collected",
        `${tokenNumber(usage.measuredCalls)} / ${tokenNumber(usage.calls)}`,
        ...["input", "output", "cacheRead", "cacheWrite", "other"].map((key) =>
          usage.measuredCalls ? tokenValue(usage[key]) : "Not collected",
        ),
      ];
      values.forEach((value, index) => {
        const td = node("td");
        td.dataset.label = labels[index];
        td.append(typeof value === "string" ? document.createTextNode(value) : value);
        row.append(td);
      });
      tbody.append(row);
    }
    table.append(tbody);
    wrap.append(table);
    const departmentDetails = node("details");
    departmentDetails.append(node("summary", "Show department Token details"), wrap);
    panel.append(departmentDetails);
    const quality = report.tokenQuality;
    if (quality) {
      const details = node("details");
      details.append(
        node(
          "summary",
          "Data coverage and what is not counted (whole organisation for the selected period, not affected by the department or member filter)",
        ),
      );
      for (const [key, label] of [
        ["unattributed", "Requester could not be confirmed uniquely"],
        ["nonHuman", "Scheduled, automatic and other non-human requests"],
        ["unregistered", "Members not registered for tracking"],
        ["excludedTest", "Test members"],
      ]) {
        const usage = quality[key];
        const line = node(
          "p",
          `${label}: ${tokenNumber(usage.calls)} records, of which ${tokenNumber(usage.measuredCalls)} have usage; `,
        );
        if (usage.measuredCalls) line.append(tokenValue(usage.total), document.createTextNode(" Token"));
        else line.append(document.createTextNode("Usage not collected"));
        details.append(line);
      }
      details.append(
        node(
          "p",
          "Records from automatic tasks and from unverified identities are not included in department or personal figures. Only the model call records that were kept are covered; history cleanup, calls that were never reported and sub-tasks that cannot be linked may leave gaps. The coverage ratio only concerns recorded, attributed records and does not represent all actual consumption. Departments follow the current roster, so staff moves change the historical department totals.",
          "adoption-note",
        ),
      );
      panel.append(details);
    }
    return panel;
  }

  let dashboard: { element: HTMLElement; dispose(): void } | undefined;
  function draw() {
    dashboard?.dispose();
    body.replaceChildren();
    const s = report.summary;
    body.append(drawSummary(s));
    dashboard = createDashboard(
      report,
      (value: string) => {
        department.value = value;
        void load();
      },
      apiBase,
      activeQuery,
    );
    body.append(dashboard.element);
    body.append(drawTokens());
    const note = node(
      "p",
      `Beijing time ${date(report.window.from)} to ${date(report.window.to - day)} · Department: ${report.window.department || "All"} · Member filter: ${report.window.search || "None"} · Current department · Generated at ${when(report.generatedAt)}. The history that still exists may be incomplete, and everything above is observed data.`,
      "adoption-note",
    );
    body.append(note);
    body.append(
      node(
        "p",
        `Other members (admission unconfirmed at period end, or disabled), observed active: ${observed(s.otherActivePeople, " people")}. Newly started and verified this period: ${s.openedPeople} people; observed active person-days: ${observed(s.activePersonDays)}. Steady observation is not the retention rate.`,
        "adoption-note",
      ),
    );

    if (!s.registeredPeople)
      body.append(
        node(
          "p",
          report.rosterRevision
            ? "No tracked members match the filters."
            : "No tracked members are registered yet. Check the admission list first and register them; conversation participants are not treated as all staff automatically.",
          "adoption-panel",
        ),
      );
    if (report.quality.projectionPending)
      body.append(
        node(
          "p",
          "History is being backfilled, so these figures are incomplete. Select Apply filters later to keep checking.",
          "adoption-panel",
        ),
      );
    const panel = node("section", null, "adoption-panel");
    const head = node("div", null, "adoption-section-head");
    const actions = node("div");
    const exp = node("a", "Export current filter", "adoption-export");
    exp.href = apiBase + "/api/adoption/export?" + activeQuery;
    exp.download = "adoption.csv";
    exp.textContent = "CSV raw data";
    actions.append(exp, button("Weekly report draft", weekly));
    head.append(node("h3", "Departments and members"), actions);
    const chips = node("div", null, "adoption-depts");
    for (const [value, label] of [["", "Whole organisation"], ...report.departments.map((d: string) => [d, d])]) {
      const chip = button(label, () => {
        department.value = value;
        void load();
      });
      chip.setAttribute("aria-pressed", String(value === (report.window.department || "")));
      chips.append(chip);
    }
    const sorting = node("select");
    for (const [value, text] of [
      ["name", "Name"],
      ["requests", "Observed requests, most first"],
      ["tokens", "Recorded Token, most first"],
      ["activeDays", "Active days, most first"],
      ["lastActiveAt", "Most recently active first"],
    ])
      sorting.append(new Option(text, value));
    sorting.value = sortBy;
    sorting.onchange = () => {
      sortBy = sorting.value;
      page = 0;
      draw();
    };
    panel.append(
      head,
      chips,
      node(
        "p",
        "Completed normally means the system finished the run normally. Failed, stopped on purpose and unverified evidence are counted separately, and none of this means the business result was accepted.",
        "adoption-note",
      ),
      field("Sort members", sorting),
    );
    const wrap = node("div", null, "adoption-table-wrap");
    const table = node("table", null, "adoption-table");
    table.classList.add("adoption-members-table");
    const columns = button("Show all columns", () => {
      const expanded = table.classList.toggle("show-all");
      columns.textContent = expanded ? "Show fewer columns" : "Show all columns";
      columns.setAttribute("aria-pressed", String(expanded));
    });
    columns.setAttribute("aria-pressed", "false");
    actions.append(columns);
    const labels = [
      "Member",
      "Current department",
      "Admitted at period end",
      "Verified start date",
      "Observed requests",
      "Active days",
      "Outcomes",
      "Token usage",
      "First observed",
      "Last active",
      "Profile",
    ];
    const thead = node("thead"),
      tr = node("tr");
    for (const l of labels) tr.append(node("th", l));
    thead.append(tr);
    table.append(thead);
    const tbody = node("tbody");
    const sorted = [...report.members].sort((a, b) => {
      let difference = 0;
      if (sortBy === "tokens") difference = (b.tokens?.total ?? -1) - (a.tokens?.total ?? -1);
      else if (sortBy !== "name") difference = (b[sortBy] || 0) - (a[sortBy] || 0);
      return (
        difference || a.displayName.localeCompare(b.displayName, "zh-CN") || a.principalId.localeCompare(b.principalId)
      );
    });
    for (const m of sorted.slice(page * 10, (page + 1) * 10)) {
      const row = node("tr");
      const name = node("span", m.displayName);
      name.append(node("span", m.principalId, "adoption-secondary"));
      const values = [
        name,
        m.department || "Unassigned",
        eligibility(m.eligible),
        m.eligibleFrom == null ? "Unverified" : date(m.eligibleFrom),
        observed(m.requests),
        observed(m.activeDays),
        drawExecution(m),
        tokenCell(m.tokens),
        m.firstObservedAt == null ? "Not observed yet" : when(m.firstObservedAt),
        m.lastActiveAt == null ? "Not observed yet" : when(m.lastActiveAt),
        button("View / edit", () => editMember(m)),
      ];
      values.forEach((v, i) => {
        const td = node("td");
        td.dataset.label = labels[i];
        td.append(typeof v === "string" ? document.createTextNode(v) : v);
        row.append(td);
      });
      tbody.append(row);
    }
    table.append(tbody);
    wrap.append(table);
    panel.append(wrap);
    const pages = node("div", null, "adoption-pages");
    const prev = button("Previous page", () => {
      page--;
      draw();
    });
    prev.disabled = page === 0;
    const next = button("Next page", () => {
      page++;
      draw();
    });
    next.disabled = (page + 1) * 10 >= report.members.length;
    pages.append(
      node(
        "p",
        `Total ${report.members.length} people · page ${page + 1} / ${Math.max(1, Math.ceil(report.members.length / 10))} · 10 people per page`,
      ),
      prev,
      next,
    );
    panel.append(pages);
    body.append(panel);
    const details = node("details", null, "adoption-panel");
    details.append(node("summary", "Data diagnostics and basis"));
    const ul = node("ul");
    const q = report.quality;
    for (const text of [
      `Roster source: ${report.rosterSource || "Not registered"}; revision ${report.rosterRevision}; registered at ${when(report.rosterRecordedAt)}.`,
      `Start date unknown for ${q.unknownEligibility} people, department unassigned for ${q.unassignedDepartments} people. Full coverage is not calculated until history completeness is verified.`,
      `Across the whole organisation in the selected dates, unregistered initiators: ${observed(q.unregisteredActors, " users")}, related requests: ${observed(q.unregisteredRequests, " times")}; human requests that cannot be attributed to an internal member: ${observed(q.unattributedRequests, " times")}, all listed separately. Test members excluded: ${q.excludedTestMembers} people.`,
      `Human requests are counted by initiator, excluding automatic tasks and listen-only activity. Completed normally means the system finished the run normally, including tool replies that have evidence from the same run; it does not mean business acceptance or that the user read it. An unverified outcome is not a failure. Observed running records: ${executionCount(s.pending, " times")}, finished records: ${observed(s.terminal, " times")}.`,
      `Last successful check: ${when(q.checkedAt)}; ${q.checkedAt == null ? "unknown" : Math.max(0, Math.floor((Date.now() - q.checkedAt) / 1000))} seconds ago; oldest check of a running record: ${when(q.oldestPendingCheck)}. This is not the date up to which the data is complete.`,
      `Source records with a damaged format: ${q.malformedRecords} records. They are saved and the unreadable parts are skipped, so they do not block other records. Identity aliases are merged using the current saved member directory.`,
      `Source records removed, outcome unknown: ${observed(q.sourceMissingRequests, " times")}. The observed requests are kept and no longer counted as in progress. Failure rate among clear outcomes (failed ÷ completed normally plus failed, excluding stopped, other and unverified): ${s.failureRate == null ? "No clear outcomes yet" : Math.round(s.failureRate * 100) + "%"}.`,
      `Outcomes: failed ${executionCount(s.failed, " times")}; stopped on purpose ${executionCount(s.stopped, " times")}; paused for approval ${executionCount(s.paused, " times")}; handed off ${executionCount(s.handedOff, " times")}; other endings (declined, reaction only) ${executionCount(s.otherTerminal, " times")}; outcome unknown ${executionCount(s.unknownTerminal, " times")}.`,
      "The data comes from the run records that still exist; the date up to which it is complete and the start of continuous coverage are both unknown. The selected period may have gaps from history cleanup, and the missing dates cannot be located; this does not mean the whole span is confirmed missing. First observed is not the same as first use.",
      `Recalculation: this report was aggregated again with the current roster and projection; history backfill ${q.projectionPending ? "in progress" : "covers the records that still exist"}. Real results, hours saved and retention are not collected, and zero is not used in place of unknown.`,
      `Admission is judged as of: ${when(report.eligibilityAt)}; people disabled on the first day of the next period still count as admitted in this period.`,
      "Departments are grouped by the current registered profile, not the department at the time of the request. Tracking registration does not change sign-in admission. Only organisation admins can view this page and export.",
    ])
      ul.append(node("li", text));
    details.append(ul);
    body.append(details);
  }
  function modal(titleText: string) {
    const d = node("dialog", null, "adoption-dialog");
    const h = node("h3", titleText);
    const id = "adoption-dialog-" + Date.now();
    h.id = id;
    d.setAttribute("aria-labelledby", id);
    d.append(h);
    root.append(d);
    d.addEventListener("close", () => d.remove());
    return d;
  }
  function weekly() {
    const d = modal("Adoption weekly report draft");
    const s = report.summary;
    d.append(
      node(
        "p",
        `${date(report.window.from)} to ${date(report.window.to - day)} (Beijing time)\n${freshness(report)}\nRegistered in the current filter: ${s.registeredPeople} people; active members with verified admission: ${observed(s.activePeople, " people")}; other members active: ${observed(s.otherActivePeople, " people")}; total observed requests: ${observed(s.requests, " times")} (observed lower bound). First observed this period: ${observed(s.firstObservedPeople, " people")}; steadily observed over the last 7 days: ${s.steadyObservedPeople == null ? "observation period too short" : observed(s.steadyObservedPeople, " people")}.\nOf these, completed normally: ${executionCount(s.succeeded, " times")}; failed: ${executionCount(s.failed, " times")}; stopped on purpose: ${executionCount(s.stopped, " times")}; paused for approval: ${executionCount(s.paused, " times")}; handed off: ${executionCount(s.handedOff, " times")}; other endings: ${executionCount(s.otherTerminal, " times")}; outcome unverified: ${executionCount(s.unknownTerminal, " times")}; running: ${executionCount(s.pending, " times")}. Completed normally does not yet mean real adoption.\nSuggestion: invite colleagues who have finished real work to share their methods voluntarily, and use their feedback to choose the next training scenarios.\nFilter: department ${report.window.department || "All"}; member ${report.window.search || "None"}.\nMetric version ${report.metricVersion}; roster revision ${report.rosterRevision}; the date up to which data is complete is unknown; the start of continuous coverage is unknown; last successful check ${when(report.quality.checkedAt)}; backfill ${report.quality.projectionPending ? "not finished" : "finished for the records that still exist"}.\nData notes: history completeness is unknown, so non-use cannot be assumed; full coverage is unknown; outcome unknown for removed source records: ${observed(report.quality.sourceMissingRequests, " times")}; source records with a damaged format: ${report.quality.malformedRecords} records; identities are merged using the current saved member directory; grouped by the current registered department; generated at ${when(report.generatedAt)}. Cases and hours saved are still to be collected.`,
        "adoption-weekly",
      ),
      button("Close", () => d.close()),
    );
    d.showModal();
  }
  async function editMember(member?: any) {
    status.textContent = "Reading member profile…";
    try {
      const r = await api("GET", "/api/adoption/roster");
      if (!r.ok) throw new Error(r.data?.message || "Could not read the profile.");
      if (!root.contains(body)) return;
      status.textContent = "";
      const current = r.data.members.find((m: any) => m.principalId === member?.principalId) || member;
      const d = modal(current ? "Member profile and usage details" : "Register a tracked member");
      const form = node("form");
      const principal = input("text", current?.principalId || "");
      principal.required = true;
      principal.maxLength = 254;
      principal.readOnly = Boolean(current);
      const name = input("text", current?.displayName || "");
      name.required = true;
      name.maxLength = 120;
      const dept = input("text", current?.department || "");
      dept.maxLength = 120;
      const enabled = input("date", current?.eligibleFrom == null ? "" : date(current.eligibleFrom));
      const disabled = input("date", current?.eligibleTo == null ? "" : date(current.eligibleTo));
      const source = input("text");
      source.required = true;
      source.maxLength = 300;
      source.placeholder = "For example: checked against the beta admission list";
      const test = input("checkbox");
      test.checked = Boolean(current?.isTest);
      form.append(
        node(
          "p",
          "This only records tracking details and does not enable or block an account. Leave the start date empty if there is no basis for it; a disable date takes effect from midnight of that day.",
          "adoption-note",
        ),
      );
      if (member)
        form.append(
          node(
            "p",
            `Observed requests this period: ${observed(member.requests, " times")} · Active: ${observed(member.activeDays, " days")} · First observed: ${member.firstObservedAt == null ? "Not observed yet" : when(member.firstObservedAt)}`,
            "adoption-note",
          ),
        );
      if (member)
        form.append(
          node(
            "p",
            `Failed ${executionCount(member.failed, " times")}; stopped on purpose ${executionCount(member.stopped, " times")}; completed normally ${executionCount(member.succeeded, " times")}; paused for approval ${executionCount(member.paused, " times")}; handed off ${executionCount(member.handedOff, " times")}; other endings ${executionCount(member.otherTerminal, " times")}; outcome unverified ${executionCount(member.unknownTerminal, " times")}.`,
            "adoption-note",
          ),
        );
      form.append(
        field("Account", principal),
        field("Name", name),
        field("Department now", dept),
        field("Verified start date (optional)", enabled),
        field("Disable date (optional)", disabled),
        field("Verification source / reason for change", source),
        field("This is a test account (not counted)", test),
      );
      const error = node("p");
      error.setAttribute("role", "alert");
      const footer = node("footer"),
        save = node("button", "Save profile");
      save.type = "submit";
      footer.append(
        button("Cancel", () => d.close()),
        save,
      );
      form.append(error, footer);
      form.onsubmit = async (e: Event) => {
        e.preventDefault();
        save.disabled = true;
        try {
          const epoch = (v: string) => (v ? Date.parse(v + "T00:00:00+08:00") : null);
          const result = await api("PUT", "/api/adoption/roster", {
            revision: r.data.revision,
            source: source.value,
            members: [
              {
                principalId: principal.value,
                displayName: name.value,
                department: dept.value.trim() || null,
                eligibleFrom: epoch(enabled.value),
                eligibleTo: epoch(disabled.value),
                isTest: test.checked,
              },
            ],
          });
          if (!result.ok) throw new Error(result.data?.message || "Could not save.");
          d.close();
          await load();
        } catch (err: any) {
          error.textContent = err.message;
        } finally {
          save.disabled = false;
        }
      };
      d.append(form);
      d.showModal();
    } catch (error: any) {
      status.textContent = error.message;
    }
  }
  activeQuery = query();
  draw();
}
