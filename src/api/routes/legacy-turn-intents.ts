import { sendJson } from "../http.ts";
import { isObj } from "./shared.ts";
import { type ApiCtx, type Route } from "./route.ts";
import { LegacyTurnIntentCapacityError, type LegacyTurnIntentPayload } from "../../runs/legacy-turn-intent-store.ts";

function member(ctx: ApiCtx, requested: unknown): string | null {
  const principalId = ctx.actor?.p;
  if (!principalId || ctx.capability || ctx.actor?.imp !== undefined) {
    sendJson(ctx.res, 403, { error: "forbidden" });
    return null;
  }
  if (requested !== principalId) {
    sendJson(ctx.res, 403, { error: "forbidden" });
    return null;
  }
  return principalId;
}

function validPayload(value: unknown): LegacyTurnIntentPayload | null {
  if (!isObj(value) || typeof value.text !== "string" || value.text.length > 50_000) return null;
  if (value.quoteSeq !== undefined && (!Number.isSafeInteger(value.quoteSeq) || (value.quoteSeq as number) < 0))
    return null;
  if (value.quoteText !== undefined && (typeof value.quoteText !== "string" || value.quoteText.length > 300))
    return null;
  if (value.quoteAuthor !== undefined && (typeof value.quoteAuthor !== "string" || value.quoteAuthor.length > 50))
    return null;
  if (value.attachmentsWerePresent !== undefined && typeof value.attachmentsWerePresent !== "boolean") return null;
  const attachments = value.attachments;
  if (
    attachments !== undefined &&
    (!Array.isArray(attachments) ||
      attachments.length > 20 ||
      attachments.some(
        (a) =>
          !isObj(a) ||
          typeof a.name !== "string" ||
          !a.name ||
          a.name.length > 255 ||
          typeof a.mimetype !== "string" ||
          a.mimetype.length > 127 ||
          !Number.isSafeInteger(a.sizeBytes) ||
          (a.sizeBytes as number) < 0 ||
          typeof a.blobId !== "string" ||
          a.blobId.length > 128,
      ))
  )
    return null;
  if (!value.text.trim() && (!Array.isArray(attachments) || attachments.length === 0) && !value.attachmentsWerePresent)
    return null;
  return {
    text: value.text,
    ...(value.attachmentsWerePresent ? { attachmentsWerePresent: true } : {}),
    ...(value.quoteSeq !== undefined ? { quoteSeq: value.quoteSeq as number } : {}),
    ...(value.quoteText !== undefined ? { quoteText: value.quoteText as string } : {}),
    ...(value.quoteAuthor !== undefined ? { quoteAuthor: value.quoteAuthor as string } : {}),
    ...(attachments !== undefined ? { attachments: attachments as LegacyTurnIntentPayload["attachments"] } : {}),
  };
}

async function add(ctx: ApiCtx): Promise<void> {
  if (!ctx.deps.legacyTurnIntents) return sendJson(ctx.res, 503, { error: "legacy_intents_unavailable" });
  const body = isObj(ctx.body) ? ctx.body : {};
  const principalId = member(ctx, body.principalId);
  if (!principalId) return;
  const scopeId = body.scopeId;
  const threadRef = body.threadRef;
  const payload = validPayload(body.payload);
  if (
    typeof scopeId !== "string" ||
    scopeId.length > 255 ||
    typeof threadRef !== "string" ||
    !threadRef.startsWith("web:") ||
    threadRef.length > 512 ||
    !payload
  )
    return sendJson(ctx.res, 400, { error: "invalid_legacy_intent" });
  const personal = scopeId === `personal:${principalId}`;
  if (personal && !threadRef.startsWith(`web:${principalId}:`))
    return sendJson(ctx.res, 403, { error: "forbidden_thread" });
  if (!personal && !((scopeId.startsWith("channel:") || scopeId.startsWith("group:")) && scopeId.split(":")[1]))
    return sendJson(ctx.res, 403, { error: "forbidden_scope" });
  if (!(await ctx.app.belongsToScope(principalId, scopeId)))
    return sendJson(ctx.res, 403, { error: "forbidden_scope" });
  try {
    const intent = await ctx.deps.legacyTurnIntents.add({ principalId, scopeId, threadRef, payload });
    return sendJson(ctx.res, 201, { ingressId: intent.id, status: intent.status, expiresAt: intent.expiresAt });
  } catch (error) {
    if (error instanceof LegacyTurnIntentCapacityError)
      return sendJson(ctx.res, 507, { error: "legacy_intents_capacity" });
    throw error;
  }
}

async function list(ctx: ApiCtx): Promise<void> {
  if (!ctx.deps.legacyTurnIntents) return sendJson(ctx.res, 503, { error: "legacy_intents_unavailable" });
  const principalId = member(ctx, ctx.url.searchParams.get("principalId"));
  if (!principalId) return;
  const rawCursor = ctx.url.searchParams.get("before");
  let before: { createdAt: number; id: string } | undefined;
  if (rawCursor) {
    const matched = /^(\d{13}):([0-9a-f-]{36})$/.exec(rawCursor);
    if (!matched) return sendJson(ctx.res, 400, { error: "invalid_cursor" });
    before = { createdAt: Number(matched[1]), id: matched[2]! };
  }
  const page = await ctx.deps.legacyTurnIntents.list(principalId, before);
  const visible = [];
  for (const intent of page.intents) {
    if (await ctx.app.belongsToScope(principalId, intent.scopeId)) visible.push(intent);
  }
  return sendJson(ctx.res, 200, { intents: visible, nextCursor: page.nextCursor });
}

async function dismiss(ctx: ApiCtx): Promise<void> {
  if (!ctx.deps.legacyTurnIntents) return sendJson(ctx.res, 503, { error: "legacy_intents_unavailable" });
  const body = isObj(ctx.body) ? ctx.body : {};
  const principalId = member(ctx, body.principalId);
  if (!principalId) return;
  const ingressId = body.ingressId;
  if (typeof ingressId !== "string" || !/^[0-9a-f-]{36}$/.test(ingressId))
    return sendJson(ctx.res, 400, { error: "invalid_legacy_intent" });
  await ctx.deps.legacyTurnIntents.dismiss(principalId, ingressId);
  return sendJson(ctx.res, 200, { status: "dismissed" });
}

export const legacyTurnIntentRoutes: ReadonlyArray<Route<ApiCtx>> = [
  { method: "POST", path: "/v2/legacy-turn-intents", auth: "source", handle: add },
  { method: "GET", path: "/v2/legacy-turn-intents", auth: "source", handle: list },
  { method: "POST", path: "/v2/legacy-turn-intents/dismiss", auth: "source", handle: dismiss },
];
