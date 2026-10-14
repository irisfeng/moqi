import { personKey } from "../../directory/person.ts";
import { RATING_REASON_LIMIT, ratingContext, ratingTargetId } from "../../ratings/rating-store.ts";
import { sendJson } from "../http.ts";
import { authorizeAdmin, isObj, orgScope } from "./shared.ts";
import { type ApiCtx, type Route } from "./route.ts";

function viewer(ctx: ApiCtx): string | null {
  const requested = ctx.url.searchParams.get("principalId") ?? "";
  const principal = ctx.actor?.p ?? ctx.capability?.actorId;
  if (principal && requested && principal !== requested) return null;
  return principal ?? (ctx.auth || ctx.allowUnsignedSourceAuth ? requested || null : null);
}

async function listRatings(ctx: ApiCtx): Promise<void> {
  const principal = viewer(ctx);
  const sessionId = ctx.url.searchParams.get("sessionId") ?? "";
  if (!principal || !ctx.deps.ratings || !sessionId) return sendJson(ctx.res, 404, { error: "not_found" });
  const ratings = await ctx.deps.ratings.forSession(personKey(principal), sessionId);
  return sendJson(ctx.res, 200, {
    ratings: ratings.map(({ targetId, value, reason }) => ({ targetId, value, reason })),
  });
}

async function putRating(ctx: ApiCtx): Promise<void> {
  const principal = viewer(ctx);
  if (!principal || !ctx.deps.ratings || !ctx.deps.sessions) return sendJson(ctx.res, 404, { error: "not_found" });
  if (ctx.actor?.imp !== undefined) return sendJson(ctx.res, 403, { error: "impersonation_forbidden" });
  const b = isObj(ctx.body) ? ctx.body : {};
  const sessionId = typeof b.sessionId === "string" ? b.sessionId : "";
  const seq = Number.isSafeInteger(b.seq) && (b.seq as number) >= 0 ? (b.seq as number) : null;
  const fileId = typeof b.fileId === "string" && b.fileId.length <= 200 ? b.fileId : "";
  if (!sessionId || seq === null || (b.value !== "up" && b.value !== "down" && b.value !== null))
    return sendJson(ctx.res, 400, { error: "bad_request", message: "sessionId, seq and value required" });
  if (b.reason !== undefined && typeof b.reason !== "string")
    return sendJson(ctx.res, 400, { error: "bad_request", message: "reason must be text" });
  const found = await ctx.app.getSessionEntryForViewer(sessionId, principal, seq);
  if (!found || found.entry.type === "user") return sendJson(ctx.res, 404, { error: "not_found" });
  if (fileId) {
    const opened = await ctx.app.openFileForViewer(fileId, principal);
    if (!opened) return sendJson(ctx.res, 404, { error: "not_found" });
    opened.stream.destroy();
  }
  const targetId = ratingTargetId(sessionId, seq, fileId || undefined);
  if (b.value === null) {
    await ctx.deps.ratings.remove(personKey(principal), targetId);
    return sendJson(ctx.res, 200, { targetId, value: null });
  }
  const reason =
    b.value === "down" ? ((b.reason as string | undefined) ?? "").trim().slice(0, RATING_REASON_LIMIT) : "";
  await ctx.deps.ratings.set({
    principalId: personKey(principal),
    targetId,
    sessionId,
    value: b.value,
    reason,
    ...(await ratingContext(ctx.deps.sessions, sessionId, seq)),
    updatedAt: Date.now(),
  });
  return sendJson(ctx.res, 200, { targetId, value: b.value, reason });
}

async function ratingSummary(ctx: ApiCtx): Promise<void> {
  const actor = await authorizeAdmin(ctx, orgScope(ctx.deps));
  if (!actor) return;
  if (!ctx.deps.ratings) return sendJson(ctx.res, 404, { error: "not_found" });
  return sendJson(ctx.res, 200, await ctx.deps.ratings.summary());
}

export const ratingRoutes: ReadonlyArray<Route<ApiCtx>> = [
  { method: "GET", path: "/v1/ratings", auth: "source", handle: listRatings },
  { method: "PUT", path: "/v1/ratings", auth: "source", handle: putRating },
  { method: "GET", path: "/v1/admin/ratings", auth: "either", handle: ratingSummary },
];
