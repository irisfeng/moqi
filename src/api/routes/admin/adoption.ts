import { ZodError } from "zod";
import { AdoptionConflict, parseAdoptionRoster, type AdoptionWindow } from "../../../admin/adoption-store.ts";
import { samePerson } from "../../../directory/person.ts";
import { sendJson } from "../../http.ts";
import { activePrincipal, adminActorFrom, audit, orgScope } from "../shared.ts";
import type { ApiCtx } from "../route.ts";

const DAY = 86400000;
function dateStart(value: string): number {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error("Date must be YYYY-MM-DD.");
  const ms = Date.parse(`${value}T00:00:00+08:00`);
  if (!Number.isFinite(ms) || new Date(ms + 28800000).toISOString().slice(0, 10) !== value)
    throw new Error("Invalid date.");
  return ms;
}
function csvCell(raw: unknown): string {
  const text = String(raw ?? "");
  const safe = /^[\s\uFEFF]*[=+@-]|^[\t\r\n]/u.test(text) ? `'${text}` : text;
  return `"${safe.replaceAll('"', '""')}"`;
}
function downloadCsv(ctx: ApiCtx, name: string, rows: unknown[][]): void {
  ctx.res.writeHead(200, {
    "content-type": "text/csv; charset=utf-8",
    "content-disposition": `attachment; filename="${name}"`,
    "x-content-type-options": "nosniff",
  });
  ctx.res.end("\uFEFF" + rows.map((row) => row.map(csvCell).join(",")).join("\r\n") + "\r\n");
}
function reportWindow(url: URL): AdoptionWindow {
  const allowed = new Set(["from", "to", "department", "search"]);
  for (const key of url.searchParams.keys()) if (!allowed.has(key)) throw new Error("Unsupported filter parameter.");
  const from = url.searchParams.get("from");
  const to = url.searchParams.get("to");
  if (Boolean(from) !== Boolean(to)) throw new Error("Start and end dates must both be provided.");
  const tomorrow = Math.floor((Date.now() + 28800000) / DAY) * DAY - 28800000 + DAY;
  const end = to ? dateStart(to) : tomorrow;
  const start = from ? dateStart(from) : end - 7 * DAY;
  if (start < 0 || end <= start || end - start > 180 * DAY || end > tomorrow)
    throw new Error("Choose 1–180 calendar days up to today; the end date is exclusive. Today's data keeps updating.");
  const department = url.searchParams.get("department") || undefined;
  const search = url.searchParams.get("search") || undefined;
  if ((department?.length ?? 0) > 120 || (search?.length ?? 0) > 254) throw new Error("Filter text is too long.");
  return { from: start, to: end, ...(department ? { department } : {}), ...(search ? { search } : {}) };
}
async function access(ctx: ApiCtx) {
  ctx.res.setHeader("cache-control", "no-store");
  const actor = adminActorFrom(ctx);
  const grants = (await ctx.deps.admin?.listGrants()) ?? [];
  if (
    !actor ||
    !(await activePrincipal(ctx.deps, actor.id)) ||
    !grants.some(
      (g) => samePerson(g.principalId, actor.id) && g.role === "org_admin" && g.scopeId === orgScope(ctx.deps),
    )
  ) {
    sendJson(ctx.res, 403, { error: "forbidden", message: "Only organization admins can view usage statistics." });
    return null;
  }
  if (!ctx.deps.adoption) {
    sendJson(ctx.res, 503, { error: "unavailable", message: "Usage statistics have no persistent data source." });
    return null;
  }
  return { actor, store: ctx.deps.adoption };
}
async function answeringConflicts(ctx: ApiCtx, handler: (ctx: ApiCtx) => Promise<unknown>) {
  try {
    await handler(ctx);
  } catch (error) {
    if (!(error instanceof AdoptionConflict) || ctx.res.headersSent) throw error;
    sendJson(ctx.res, 409, { error: "conflict", message: error.message });
  }
}

export const adoptionReport = (ctx: ApiCtx) => answeringConflicts(ctx, reportView);
export const adoptionScenarioExport = (ctx: ApiCtx) => answeringConflicts(ctx, scenarioExport);

async function reportView(ctx: ApiCtx) {
  const auth = await access(ctx);
  if (!auth) return;
  let window: AdoptionWindow;
  try {
    window = reportWindow(ctx.url);
  } catch (error) {
    return sendJson(ctx.res, 400, { error: "bad_request", message: (error as Error).message });
  }
  await auth.store.sync();
  const report = await auth.store.report(window);
  const exporting = ctx.pathname.endsWith("/export");
  audit(ctx.deps, {
    principalId: auth.actor.id,
    action: exporting ? "adoption.export" : "adoption.read",
    resource: JSON.stringify({
      ...window,
      rosterRevision: report.rosterRevision,
      metricVersion: report.metricVersion,
      generatedAt: report.generatedAt,
      dataThrough: report.dataThrough,
      asOf: report.asOf,
      partialDay: report.partialDay,
      coverageStart: report.coverageStart,
      coverageStatus: report.coverageStatus,
      checkedAt: report.quality.checkedAt,
      projectionPending: report.quality.projectionPending,
    }),
    scopeLabel: orgScope(ctx.deps),
  });
  if (!exporting) return sendJson(ctx.res, 200, report);
  const headers = [
    "Name",
    "Account",
    "Registered department",
    "Total tokens recorded",
    "Uncached input tokens",
    "Output tokens",
    "Cache read tokens",
    "Cache write tokens",
    "Other metered tokens",
    "Records with usage",
    "Attributed records",
    "Token metric version",
    "Token counting basis",
    "Observed requests",
    "Active days",
    "Completed normally (technical execution)",
    "Finished records",
    "Running",
    "Failed",
    "Stopped by user",
    "Other endings",
    "Result to be verified",
    "Enabled at",
    "First observed at",
    "Start time",
    "End time (exclusive)",
    "Metric version",
    "Roster version",
    "Generated at",
    "History completeness",
    "Projection backfill",
    "Admitted at period end",
    "Source record removal result unknown",
    "Last successful reconciliation",
    "Department filter",
    "Member filter",
    "Counting notes",
    "Data complete through",
    "Continuous coverage start",
    "Continuous coverage status",
    "Corrupt records in selected period",
    "Identity merge basis",
    "Paused for approval",
    "Handed off",
    "This query cutoff",
    "Today's data status",
  ];
  const eligibility = (value: boolean | null) => {
    if (value === null) return "To be verified";
    return value ? "Verified" : "Not admitted at period end";
  };
  const iso = (value: number | null) => (value === null ? "To be verified" : new Date(value).toISOString());
  const rows: unknown[][] = [
    headers,
    ...report.members.map((m) => [
      m.displayName,
      m.principalId,
      m.department ?? "No dept",
      m.tokens.measuredCalls ? m.tokens.total : "Pending collection",
      m.tokens.measuredCalls ? m.tokens.input : "Pending collection",
      m.tokens.measuredCalls ? m.tokens.output : "Pending collection",
      m.tokens.measuredCalls ? m.tokens.cacheRead : "Pending collection",
      m.tokens.measuredCalls ? m.tokens.cacheWrite : "Pending collection",
      m.tokens.measuredCalls ? m.tokens.other : "Pending collection",
      m.tokens.measuredCalls,
      m.tokens.calls,
      report.tokenQuality.metricVersion,
      "Manually initiated; model call time; registered department; missing values not counted as 0",
      m.requests,
      m.activeDays,
      m.succeeded,
      m.terminal,
      m.pending,
      m.failed,
      m.stopped,
      m.otherTerminal,
      m.unknownTerminal,
      iso(m.eligibleFrom),
      iso(m.firstObservedAt),
      iso(window.from),
      iso(window.to),
      report.metricVersion,
      report.rosterRevision,
      iso(report.generatedAt),
      "Retained history completeness unknown",
      report.quality.projectionPending ? "Not yet complete" : "Existing records complete",
      eligibility(m.eligible),
      m.sourceMissing,
      iso(report.quality.checkedAt),
      window.department ?? "All",
      window.search ?? "None",
      "Manually triggered records are deduplicated by run; normal completion includes tool replies with execution evidence; not a business acceptance; to be verified is not failure",
      iso(report.dataThrough),
      iso(report.coverageStart),
      "Retention completeness unverified; there may be gaps from past cleanup",
      report.quality.malformedRecords,
      "Accounts and Slack IDs in the current persisted member directory",
      m.paused,
      m.handedOff,
      iso(report.asOf),
      report.partialDay ? "Today is not over; data keeps updating" : "Full range; retention completeness unverified",
    ]),
  ];
  downloadCsv(ctx, "adoption.csv", rows);
}
async function scenarioExport(ctx: ApiCtx) {
  const auth = await access(ctx);
  if (!auth) return;
  let window: AdoptionWindow;
  try {
    window = reportWindow(ctx.url);
  } catch (error) {
    return sendJson(ctx.res, 400, { error: "bad_request", message: (error as Error).message });
  }
  await auth.store.sync();
  const report = await auth.store.report(window);
  const scenes = report.scenarios;
  if (!scenes) {
    return sendJson(ctx.res, 503, { error: "unavailable", message: "Request scene statistics are not set up." });
  }
  audit(ctx.deps, {
    principalId: auth.actor.id,
    action: "adoption.export",
    resource: JSON.stringify({
      ...window,
      format: "scenarios-csv",
      taxonomyVersion: scenes.taxonomyVersion,
      classifierVersion: scenes.classifierVersion,
      rosterRevision: report.rosterRevision,
      generatedAt: report.generatedAt,
      asOf: report.asOf,
      coverage: scenes.coverage,
    }),
    scopeLabel: orgScope(ctx.deps),
  });
  const iso = (value: number | null) => (value === null ? "Unverified" : new Date(value).toISOString());
  const metadata = [
    scenes.taxonomyVersion,
    scenes.classifierVersion,
    iso(report.asOf),
    scenes.coverage,
    iso(window.from),
    iso(window.to),
    window.department ?? "All",
    window.search ?? "None",
    "Human requests, one per run; inferred automatically; current department; not a business outcome; people must not be added across scenes",
  ];
  const names = new Map(scenes.categories.map((item) => [item.id, item.label]));
  const rows: unknown[][] = [
    [
      "Record type",
      "Current department",
      "Date",
      "Request scene",
      "Requests",
      "People",
      "Share",
      "Taxonomy version",
      "Classifier version",
      "Report as of",
      "Classification coverage",
      "From",
      "To (exclusive)",
      "Department filter",
      "Member filter",
      "Counting note",
    ],
  ];
  for (const item of scenes.categories)
    rows.push(["Scene summary", "", "", item.label, item.requests, item.people, item.share, ...metadata]);
  for (const department of scenes.departments)
    for (const item of department.categories)
      rows.push([
        "By department",
        department.department,
        "",
        names.get(item.id) ?? item.id,
        item.requests,
        item.people,
        "",
        ...metadata,
      ]);
  for (const day of scenes.trend)
    for (const item of day.categories)
      rows.push([
        "Daily trend",
        "",
        new Date(day.at + 28800000).toISOString().slice(0, 10),
        names.get(item.id) ?? item.id,
        item.requests,
        item.people,
        "",
        ...metadata,
      ]);
  for (const item of scenes.statuses)
    rows.push(["Classification status", "", "", item.label, item.requests, "", "", ...metadata]);
  downloadCsv(ctx, "request-scenarios.csv", rows);
}
export async function adoptionRoster(ctx: ApiCtx) {
  const auth = await access(ctx);
  if (!auth) return;
  if (ctx.url.search) return sendJson(ctx.res, 400, { error: "bad_request", message: "No query parameters allowed." });
  if (ctx.method === "GET") return sendJson(ctx.res, 200, await auth.store.roster());
  try {
    const input = parseAdoptionRoster(ctx.body);
    const result = await auth.store.saveRoster(input, auth.actor.id);
    audit(ctx.deps, {
      principalId: auth.actor.id,
      action: "adoption.roster.update",
      resource: String(result.revision),
      scopeLabel: orgScope(ctx.deps),
    });
    return sendJson(ctx.res, 200, result);
  } catch (error) {
    if (error instanceof AdoptionConflict) return sendJson(ctx.res, 409, { error: "conflict", message: error.message });
    if (error instanceof ZodError)
      return sendJson(ctx.res, 400, {
        error: "bad_request",
        message: "Check the roster fields, duplicate accounts, enable and disable times, and data source.",
      });
    throw error;
  }
}
