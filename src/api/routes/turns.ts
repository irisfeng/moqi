import { fromJSONSchema, z, ZodObject } from "zod";
import type { ClientToolDeclaration, TurnOrigin, TurnRequest, TurnResult } from "../../types.ts";
import { MAX_INBOUND_FILES } from "../../core/attachments.ts";
import { resolveTurnOrigin } from "../../core/turn-origin.ts";
import { personKey, samePerson } from "../../directory/person.ts";
import { defaultOpenerKey, firstWebTurnLockKey, openerKeyFor } from "../first-web-turn.ts";
import { sendJson } from "../http.ts";
import { isObj } from "./shared.ts";
import { type ApiCtx, type Route } from "./route.ts";

function isTurnRequest(body: unknown): body is TurnRequest {
  return (
    isObj(body) &&
    typeof body.text === "string" &&
    isObj(body.actor) &&
    typeof body.actor.externalId === "string" &&
    body.actor.externalId !== "" &&
    isObj(body.conversation)
  );
}

const MAX_CLIENT_TOOL_SCHEMA_CHARS = 16_000;

function convertsToObjectSchema(schema: Record<string, unknown>): boolean {
  try {
    return fromJSONSchema(schema as Parameters<typeof fromJSONSchema>[0]) instanceof ZodObject;
  } catch {
    return false;
  }
}

const clientToolInputSchema = z
  .looseObject({
    type: z.literal("object"),
    properties: z.record(z.string(), z.unknown()).optional(),
    required: z.array(z.string()).optional(),
  })
  .refine((schema) => JSON.stringify(schema).length <= MAX_CLIENT_TOOL_SCHEMA_CHARS, {
    message: `must be at most ${MAX_CLIENT_TOOL_SCHEMA_CHARS} characters of JSON`,
    abort: true,
  })
  .refine(convertsToObjectSchema, { message: "must convert to a plain object schema" });

const clientToolsSchema = z
  .array(
    z.object({
      name: z.string().regex(/^ui__[a-z0-9_]{1,60}$/),
      description: z
        .string()
        .max(2_000)
        .refine((description) => description.trim() !== "", { message: "must not be blank" }),
      inputSchema: clientToolInputSchema,
      timeoutMs: z.int().min(1_000).max(60_000).optional(),
    }),
  )
  .max(32)
  .refine((tools) => new Set(tools.map((tool) => tool.name)).size === tools.length, {
    message: "names must be unique",
  });

const clientResultSchema = z.object({
  callId: z.string().min(1).max(256),
  result: z.object({
    content: z.string(),
    structured: z.unknown().optional(),
    isError: z.boolean().optional(),
    images: z
      .array(
        z.object({
          data: z.string().max(4_000_000).base64(),
          mimeType: z.enum(["image/png", "image/jpeg"]),
        }),
      )
      .max(4)
      .optional(),
  }),
});

function zodMessage(field: string, error: z.ZodError): string {
  const issue = error.issues[0]!;
  return `${[field, ...issue.path.map(String)].join(".")}: ${issue.message}`;
}

function publicOrigin(origin: TurnOrigin | undefined): TurnOrigin | undefined {
  if (origin?.kind !== "automation") return origin;
  const { useOwnerKeychain: _internalOnly, ...safe } = origin;
  return safe;
}

function publicTurnOrigin(body: TurnRequest): { origin?: TurnOrigin; error?: string } {
  const typed = publicOrigin(body.origin);
  if (
    typed?.kind === "automation" &&
    body.triggered === true &&
    typed.screenData !== undefined &&
    body.securityScreenData !== undefined &&
    typed.screenData !== body.securityScreenData
  ) {
    return { error: "conflicting typed and legacy automation screen data" };
  }
  return { origin: resolveTurnOrigin({ ...body, ...(typed ? { origin: typed } : { origin: undefined }) }) };
}

function validV2Attachments(value: unknown): boolean {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_INBOUND_FILES) return false;
  return value.every((item: unknown) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return false;
    const attachment = item as Record<string, unknown>;
    return (
      Object.keys(attachment).every((key) => ["name", "mimetype", "sizeBytes", "blobId"].includes(key)) &&
      typeof attachment.name === "string" &&
      Boolean(attachment.name) &&
      attachment.name === attachment.name.trim() &&
      attachment.name.length <= 255 &&
      attachment.name !== "." &&
      attachment.name !== ".." &&
      !/[/\\\x00-\x1f]/.test(attachment.name) &&
      typeof attachment.mimetype === "string" &&
      attachment.mimetype.includes("/") &&
      attachment.mimetype.length <= 127 &&
      !/[^\x20-\x7e]/.test(attachment.mimetype) &&
      Number.isSafeInteger(attachment.sizeBytes) &&
      (attachment.sizeBytes as number) > 0 &&
      (attachment.sizeBytes as number) <= 1_000_000_000 &&
      typeof attachment.blobId === "string" &&
      /^[0-9a-f]{32}$/.test(attachment.blobId)
    );
  });
}

function sanitizedTurnRequest(body: TurnRequest): { request: TurnRequest } | { error: string } {
  const {
    slackSource: _slackSource,
    externalSlack: _externalSlack,
    ownerKeychainUnion: _ownerKeychainUnion,
    spawned: _spawned,
    unattendedGrants: _unattendedGrants,
    redeliveryKey: _redeliveryKey,
    ...safeBody
  } = body;
  if (typeof safeBody.idempotencyKey === "string" && safeBody.idempotencyKey.startsWith("slack:"))
    return { error: "idempotencyKey must not use the reserved slack: prefix" };
  const resolvedOrigin = publicTurnOrigin(safeBody);
  if (resolvedOrigin.error) return { error: resolvedOrigin.error };
  const origin = resolvedOrigin.origin;
  const { clientTools: rawClientTools, ...rest } = safeBody;
  if (rest.desktopClientId !== undefined && !z.uuid().safeParse(rest.desktopClientId).success)
    return { error: "desktopClientId must be a UUID" };
  let clientTools: ClientToolDeclaration[] | undefined;
  if (rawClientTools !== undefined) {
    const parsed = clientToolsSchema.safeParse(rawClientTools);
    if (!parsed.success) return { error: zodMessage("clientTools", parsed.error) };
    clientTools = parsed.data;
  }
  return { request: { ...rest, ...(origin ? { origin } : {}), ...(clientTools?.length ? { clientTools } : {}) } };
}

async function postTurn(ctx: ApiCtx): Promise<void> {
  const { res, app, deps, url, body } = ctx;
  if (!isTurnRequest(body)) {
    return sendJson(res, 400, { error: "bad_request", message: "expected a TurnRequest" });
  }
  if (url.pathname === "/v1/web-proactive-opener") {
    const allowed = new Set([
      "surface",
      "actor",
      "conversation",
      "liveActor",
      "deliveryTarget",
      "text",
      "proactiveOpener",
      "harness",
      "model",
      "thinkingLevel",
      "fastMode",
      "timezone",
      "idempotencyKey",
    ]);
    if (
      body.surface !== "web" ||
      body.proactiveOpener !== true ||
      Object.keys(body).some((field) => !allowed.has(field)) ||
      Object.keys(body.actor).some((field) => field !== "externalId" && field !== "displayName") ||
      (body.actor.displayName !== undefined && typeof body.actor.displayName !== "string") ||
      Object.keys(body.conversation).some((field) => field !== "kind" && field !== "threadRef") ||
      body.conversation.kind !== "dm" ||
      typeof body.conversation.threadRef !== "string" ||
      body.conversation.threadRef.length > 300 ||
      body.conversation.threadRef === `web:${body.actor.externalId}:` ||
      !body.conversation.threadRef.startsWith(`web:${body.actor.externalId}:`) ||
      body.liveActor !== true ||
      body.deliveryTarget !== body.conversation.threadRef ||
      body.text !== "" ||
      (body.harness !== undefined && typeof body.harness !== "string") ||
      (body.model !== undefined && typeof body.model !== "string") ||
      (body.thinkingLevel !== undefined && typeof body.thinkingLevel !== "string") ||
      (body.fastMode !== undefined && typeof body.fastMode !== "boolean") ||
      (body.timezone !== undefined && typeof body.timezone !== "string")
    )
      return sendJson(res, 400, { error: "invalid_opener_request" });
  }
  if (url.pathname === "/v1/turns" && body.surface === "web" && body.proactiveOpener)
    return sendJson(res, 409, { error: "versioned_opener_route_required" });
  const wantAsync = url.searchParams.get("async") === "1" || body.async === true;
  const sendProtocol = url.pathname.startsWith("/v2/") ? 2 : 1;
  if (sendProtocol === 2) {
    const allowed = new Set([
      "surface",
      "actor",
      "conversation",
      "liveActor",
      "deliveryTarget",
      "text",
      "quoteSeq",
      "quoteText",
      "quoteAuthor",
      "attachments",
      "harness",
      "model",
      "thinkingLevel",
      "fastMode",
      "timezone",
      "idempotencyKey",
      "verifiedRequestFingerprint",
      "conversationHeader",
      "analyticsSuppressed",
      "async",
    ]);
    if (
      body.surface !== "web" ||
      Object.keys(body).some((field) => !allowed.has(field)) ||
      Array.isArray(body.actor) ||
      Object.keys(body.actor).some((field) => field !== "externalId" && field !== "displayName") ||
      (body.actor.displayName !== undefined && typeof body.actor.displayName !== "string") ||
      Array.isArray(body.conversation) ||
      Object.keys(body.conversation).some(
        (field) => !["kind", "threadRef", "channelRef", "channelName"].includes(field),
      ) ||
      !["dm", "channel", "group"].includes(body.conversation.kind) ||
      typeof body.conversation.threadRef !== "string" ||
      !body.conversation.threadRef.startsWith("web:") ||
      (body.conversation.kind === "dm" &&
        (body.conversation.channelRef !== undefined || body.conversation.channelName !== undefined)) ||
      (body.conversation.kind !== "dm" &&
        (typeof body.conversation.channelRef !== "string" || !body.conversation.channelRef)) ||
      (body.conversation.channelName !== undefined && typeof body.conversation.channelName !== "string") ||
      body.liveActor !== true ||
      body.deliveryTarget !== body.conversation.threadRef ||
      (!body.text.trim() && !body.attachments?.length) ||
      (body.attachments !== undefined && !validV2Attachments(body.attachments)) ||
      ((body.quoteSeq !== undefined || body.quoteText !== undefined || body.quoteAuthor !== undefined) &&
        (typeof body.quoteText !== "string" ||
          !body.quoteText ||
          body.quoteText !== body.quoteText.trim() ||
          body.quoteText.length > 300 ||
          (body.quoteSeq !== undefined && (!Number.isSafeInteger(body.quoteSeq) || body.quoteSeq < 0)) ||
          (body.quoteAuthor !== undefined &&
            (typeof body.quoteAuthor !== "string" ||
              !body.quoteAuthor ||
              body.quoteAuthor !== body.quoteAuthor.trim() ||
              body.quoteAuthor.length > 50)))) ||
      (body.harness !== undefined && typeof body.harness !== "string") ||
      (body.model !== undefined && typeof body.model !== "string") ||
      (body.thinkingLevel !== undefined && typeof body.thinkingLevel !== "string") ||
      (body.fastMode !== undefined && typeof body.fastMode !== "boolean") ||
      (body.timezone !== undefined && typeof body.timezone !== "string") ||
      (body.async !== undefined && typeof body.async !== "boolean") ||
      (body.conversationHeader !== undefined && typeof body.conversationHeader !== "string") ||
      (body.analyticsSuppressed !== undefined && typeof body.analyticsSuppressed !== "boolean") ||
      typeof body.idempotencyKey !== "string" ||
      body.idempotencyKey.length > 300 ||
      !body.idempotencyKey.startsWith(`web:${encodeURIComponent(body.actor.externalId)}:`) ||
      typeof body.verifiedRequestFingerprint !== "string" ||
      !/^[0-9a-f]{64}$/.test(body.verifiedRequestFingerprint)
    )
      return sendJson(res, 400, { error: "bad_request", message: "verified text send required" });
  }
  const sanitized = sanitizedTurnRequest(body);
  if ("error" in sanitized) return sendJson(res, 400, { error: "bad_request", message: sanitized.error });
  const submit = () =>
    app.turn({
      ...sanitized.request,
      async: wantAsync,
      ...(body.surface === "web" ? { webSendProtocol: sendProtocol } : {}),
      ...(sendProtocol === 1 ? { verifiedRequestFingerprint: undefined } : {}),
    });
  const personalWebTurn =
    body.surface === "web" &&
    body.conversation.kind === "dm" &&
    body.conversation.threadRef.startsWith(`web:${body.actor.externalId}:`);
  if (
    body.proactiveOpener &&
    body.surface === "web" &&
    (typeof body.idempotencyKey !== "string" ||
      (body.idempotencyKey !== defaultOpenerKey(body.actor.externalId) &&
        !body.idempotencyKey.startsWith(`${defaultOpenerKey(body.actor.externalId)}:`)))
  )
    return sendJson(res, 400, { error: "invalid_opener_key" });
  if (personalWebTurn && deps.production && (!deps.advisoryLock || !deps.firstWebTurns || !deps.firstWebTurnsDurable))
    return sendJson(res, 503, { error: "first_turn_gate_unavailable" });
  let result: TurnResult | null;
  if (personalWebTurn && deps.advisoryLock && deps.firstWebTurns) {
    const actorId = body.actor.externalId;
    const threadRef = body.conversation.threadRef;
    const firstWebTurns = deps.firstWebTurns;
    result = await deps.advisoryLock.withLock(firstWebTurnLockKey(actorId), async () => {
      if (body.approval) {
        const current = await app.getApproval(body.approval.requestId, actorId);
        return current ? submit() : { status: "refused", reason: "approval is no longer current" };
      }
      const memberKey = personKey(actorId);
      const prior = await firstWebTurns.get(memberKey);
      if (body.proactiveOpener) {
        if (body.idempotencyKey !== openerKeyFor(actorId, prior)) return null;
        if (prior && prior.kind !== "reset" && (prior.kind !== "opener" || prior.threadRef !== threadRef)) return null;
        if ((!prior || prior.kind === "reset") && (await app.listSessions(actorId)).length) return null;
        if (!prior || prior.kind === "reset")
          await firstWebTurns.put(memberKey, {
            kind: "opener",
            threadRef,
            createdAt: Date.now(),
            ...(prior?.openerGeneration ? { openerGeneration: prior.openerGeneration } : {}),
          });
      } else if (!prior || prior.kind === "reset") {
        await firstWebTurns.put(memberKey, {
          kind: "human",
          threadRef,
          createdAt: Date.now(),
          ...(prior?.openerGeneration ? { openerGeneration: prior.openerGeneration } : {}),
        });
      } else if (prior.kind === "opener") {
        const openerKey = openerKeyFor(actorId, prior);
        const openerRun = await app.webRunForOperationKey(openerKey, actorId);
        if (!openerRun)
          await firstWebTurns.put(memberKey, {
            kind: "human",
            threadRef,
            createdAt: Date.now(),
            ...(prior.openerGeneration ? { openerGeneration: prior.openerGeneration } : {}),
          });
      }
      return submit();
    });
  } else {
    result = await submit();
  }
  if (!result) return sendJson(res, 409, { error: "opener_superseded" });
  const response = sendProtocol === 2 ? { ...result, sendProtocol: 2 } : result;
  if (result.status === "queued") return sendJson(res, 202, response);
  const status = result.status === "refused" ? 403 : 200;
  return sendJson(res, status, response);
}

async function getWebTurnReceipt(ctx: ApiCtx): Promise<void> {
  const { res, app, deps, url, actor } = ctx;
  res.setHeader("Cache-Control", "no-store");
  const viewer = url.searchParams.get("viewer");
  if (!viewer || !actor || !samePerson(viewer, actor.p)) return sendJson(res, 403, { error: "forbidden" });
  const key = url.searchParams.get("key") ?? "";
  if (!key.startsWith(`web:${encodeURIComponent(viewer)}:`) || key.length > 300)
    return sendJson(res, 400, { error: "bad_request", message: "valid web operation key required" });
  const baseOpenerKey = defaultOpenerKey(viewer);
  if (key === baseOpenerKey || key.startsWith(`${baseOpenerKey}:`)) {
    if (!deps.firstWebTurns || (deps.production && !deps.firstWebTurnsDurable))
      return sendJson(res, 503, { error: "first_turn_gate_unavailable" });
    if (key !== openerKeyFor(viewer, await deps.firstWebTurns.get(personKey(viewer))))
      return sendJson(res, 404, { error: "not_found", sendProtocol: 2 });
  }
  const receipt = await app.webRunForOperationKey(key, viewer);
  if (receipt && "conflict" in receipt) return sendJson(res, 409, { error: "ambiguous_operation", sendProtocol: 2 });
  return receipt
    ? sendJson(res, 200, { ...receipt, sendProtocol: 2 })
    : sendJson(res, 404, { error: "not_found", sendProtocol: 2 });
}

async function getFirstWebTurnState(ctx: ApiCtx): Promise<void> {
  const { res, deps, url, actor } = ctx;
  res.setHeader("Cache-Control", "no-store");
  const principalId = url.searchParams.get("principalId") ?? "";
  if (!principalId || !actor || !samePerson(principalId, actor.p)) return sendJson(res, 403, { error: "forbidden" });
  if (!deps.firstWebTurns || (deps.production && !deps.firstWebTurnsDurable))
    return sendJson(res, 503, { error: "first_turn_gate_unavailable" });
  const record = await deps.firstWebTurns.get(personKey(principalId));
  return sendJson(res, 200, { openerKey: openerKeyFor(principalId, record) });
}

async function getApproval(ctx: ApiCtx): Promise<void> {
  const { res, app, actor } = ctx;
  const id = ctx.params.id!;
  if (!id || id.includes("/")) return sendJson(res, 404, { error: "not_found" });
  const record = await app.getApproval(id, actor?.p);
  return record ? sendJson(res, 200, record) : sendJson(res, 404, { error: "not_found" });
}

async function getPendingApproval(ctx: ApiCtx): Promise<void> {
  const { res, app, url, actor } = ctx;
  const threadRef = url.searchParams.get("threadRef") ?? "";
  if (!threadRef) return sendJson(res, 400, { error: "bad_request", message: "threadRef required" });
  return sendJson(res, 200, { pending: await app.pendingApprovalForThread(threadRef, actor?.p) });
}

async function postRunDeliveryState(ctx: ApiCtx): Promise<void> {
  const { res, app, body } = ctx;
  const id = ctx.params.id!;
  const editRef = isObj(body) && typeof body.editRef === "string" ? body.editRef : "";
  if (!id || !editRef) return sendJson(res, 400, { error: "bad_request", message: "editRef required" });
  const found = await app.setRunDeliveryState(id, { editRef });
  if (!found) return sendJson(res, 404, { error: "not_found" });
  return sendJson(res, 200, { ok: true });
}

async function postRunSignal(ctx: ApiCtx): Promise<void> {
  const { res, app, body, actor } = ctx;
  const id = ctx.params.id!;
  const kind = isObj(body) && typeof body.kind === "string" ? body.kind : "";
  if (kind !== "abort" && kind !== "steer" && kind !== "client_result") {
    return sendJson(res, 400, { error: "bad_request", message: "kind must be abort, steer or client_result" });
  }
  if (kind === "client_result") {
    const run = await ctx.deps.runs?.get(id);
    if (run?.request.desktopClientId && (!isObj(body) || body.desktopClientId !== run.request.desktopClientId))
      return sendJson(res, 403, { error: "wrong_desktop_client" });
    const parsed = clientResultSchema.safeParse(body);
    if (!parsed.success)
      return sendJson(res, 400, { error: "bad_request", message: zodMessage("client_result", parsed.error) });
    const outcome = await app.signalRun(id, { kind, ...parsed.data }, actor?.p);
    if (outcome.accepted) return sendJson(res, 200, outcome);
    if (outcome.reason === "not_found") return sendJson(res, 404, { error: "not_found" });
    return sendJson(res, 409, outcome);
  }
  const text = isObj(body) && typeof body.text === "string" ? body.text : undefined;
  const queuedRunId = isObj(body) && typeof body.queuedRunId === "string" ? body.queuedRunId : undefined;
  const ts = isObj(body) && typeof body.ts === "string" && body.ts ? body.ts : undefined;
  let request: TurnRequest | undefined;
  if (isObj(body) && body.request !== undefined) {
    if (!isTurnRequest(body.request)) {
      return sendJson(res, 400, { error: "bad_request", message: "request must be a TurnRequest" });
    }
    if (actor && !samePerson(body.request.actor.externalId, actor.p)) {
      return sendJson(res, 403, { error: "forbidden", message: "portal identity does not match the requested actor" });
    }
    const sanitized = sanitizedTurnRequest(body.request);
    if ("error" in sanitized) return sendJson(res, 400, { error: "bad_request", message: sanitized.error });
    request = sanitized.request;
  }
  const outcome = await app.signalRun(
    id,
    {
      kind,
      ...(text !== undefined ? { text } : {}),
      ...(ts ? { ts } : {}),
      ...(request ? { request } : {}),
      ...(queuedRunId ? { queuedRunId } : {}),
    },
    actor?.p,
  );
  if (outcome.accepted) return sendJson(res, 200, outcome);
  if (outcome.reason === "not_found") return sendJson(res, 404, { error: "not_found" });
  if (outcome.reason === "text_required")
    return sendJson(res, 400, { error: "bad_request", message: "text required", ...outcome });
  if (outcome.reason === "conversation_mismatch")
    return sendJson(res, 400, {
      error: "bad_request",
      message: "request conversation does not match the run",
      ...outcome,
    });
  return sendJson(res, 409, outcome);
}

async function getRun(ctx: ApiCtx): Promise<void> {
  const { res, app, actor } = ctx;
  const id = ctx.params.id!;
  const run = await app.getRun(id, actor?.p);
  if (!run) return sendJson(res, 404, { error: "not_found" });
  return sendJson(res, 200, run);
}

async function getActiveRunForThread(ctx: ApiCtx): Promise<void> {
  const { res, app, url, actor } = ctx;
  const threadRef = url.searchParams.get("threadRef") ?? "";
  if (!threadRef) return sendJson(res, 400, { error: "bad_request", message: "threadRef required" });
  const active = await app.activeRunForThread(threadRef, actor?.p);
  return sendJson(res, 200, { runId: active?.runId ?? null, ...(active?.queued ? { queued: active.queued } : {}) });
}

async function patchQueuedRun(ctx: ApiCtx): Promise<void> {
  const { res, app, actor, body } = ctx;
  if (!isObj(body) || typeof body.text !== "string" || typeof body.expectedText !== "string")
    return sendJson(res, 400, { error: "bad_request", message: "text and expectedText required" });
  const outcome = await app.editQueuedRun(ctx.params.id!, body.text, body.expectedText, actor?.p);
  if (outcome.edited) return sendJson(res, 200, outcome);
  if (outcome.reason === "not_found") return sendJson(res, 404, { error: "not_found" });
  return sendJson(res, outcome.reason === "empty_text" ? 400 : 409, outcome);
}

async function postRunWithdraw(ctx: ApiCtx): Promise<void> {
  const { res, app, actor } = ctx;
  const outcome = await app.withdrawRun(ctx.params.id!, actor?.p);
  if (outcome.withdrawn) return sendJson(res, 200, outcome);
  if (outcome.reason === "not_found") return sendJson(res, 404, { error: "not_found" });
  return sendJson(res, 409, outcome);
}

async function listDeliveries(ctx: ApiCtx): Promise<void> {
  const { res, app, url } = ctx;
  const type = url.searchParams.get("type") ?? "";
  const claimMsRaw = Number(url.searchParams.get("claimMs") ?? 0);
  const claimMs = Number.isFinite(claimMsRaw) && claimMsRaw > 0 ? claimMsRaw : 0;
  return sendJson(res, 200, { deliveries: await app.pendingDeliveries(type, claimMs) });
}

async function ackDelivery(ctx: ApiCtx): Promise<void> {
  const { res, app, body } = ctx;
  const id = ctx.params.id!;
  const recipientThreadRef =
    isObj(body) && typeof body.recipientThreadRef === "string" ? body.recipientThreadRef : undefined;
  const slackApiMs =
    isObj(body) && typeof body.slackApiMs === "number" && Number.isFinite(body.slackApiMs) && body.slackApiMs >= 0
      ? body.slackApiMs
      : undefined;
  if (recipientThreadRef) await app.recordPrincipalDelivery(id, recipientThreadRef);
  await app.ackDelivery(id, slackApiMs);
  return sendJson(res, 200, { ok: true });
}

async function ackDeliveryByKey(ctx: ApiCtx): Promise<void> {
  const { res, app, body } = ctx;
  const idempotencyKey = isObj(body) && typeof body.idempotencyKey === "string" ? body.idempotencyKey : "";
  if (!idempotencyKey) return sendJson(res, 400, { error: "bad_request", message: "idempotencyKey required" });
  await app.ackDeliveryByKey(idempotencyKey);
  return sendJson(res, 200, { ok: true });
}

async function postTurnMetrics(ctx: ApiCtx): Promise<void> {
  const { res, deps, body } = ctx;
  const runId = ctx.params.runId!;
  const num = (v: unknown): number | undefined =>
    typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined;
  const deliverMs = isObj(body) ? num(body.deliverMs) : undefined;
  const slackInflightMs = isObj(body) ? num(body.slackInflightMs) : undefined;
  if (deliverMs === undefined && slackInflightMs === undefined) {
    return sendJson(res, 400, { error: "bad_request", message: "deliverMs or slackInflightMs required" });
  }
  await deps.metrics
    ?.updateByRunId(runId, {
      ...(deliverMs !== undefined ? { deliverMs } : {}),
      ...(slackInflightMs !== undefined ? { slackInflightMs } : {}),
    })
    .catch(() => undefined);
  return sendJson(res, 200, { ok: true });
}

export const turnRoutes: ReadonlyArray<Route<ApiCtx>> = [
  { method: "POST", path: "/v1/turns", auth: "source", handle: postTurn },
  { method: "POST", path: "/v1/web-proactive-opener", auth: "source", handle: postTurn },
  { method: "POST", path: "/v2/turns", auth: "source", handle: postTurn },
  { method: "GET", path: "/v1/web-first-turn", auth: "source", handle: getFirstWebTurnState },
  { method: "GET", path: "/v2/turns/receipt", auth: "source", handle: getWebTurnReceipt },
  { method: "POST", path: "/v1/turns/:runId/metrics", auth: "source", handle: postTurnMetrics },
  { method: "GET", path: "/v1/approvals/pending", auth: "source", handle: getPendingApproval },
  { method: "GET", path: "/v1/approvals/:id", auth: "source", handle: getApproval },
  { method: "POST", path: "/v1/runs/:id/delivery-state", auth: "source", handle: postRunDeliveryState },
  { method: "POST", path: "/v1/runs/:id/signal", auth: "source", maxBodyBytes: 6_000_000, handle: postRunSignal },
  { method: "PATCH", path: "/v1/runs/:id/input", auth: "source", handle: patchQueuedRun },
  { method: "POST", path: "/v1/runs/:id/withdraw", auth: "source", handle: postRunWithdraw },
  { method: "GET", path: "/v1/runs/:id", auth: "source", handle: getRun },
  { method: "GET", path: "/v1/runs", auth: "source", handle: getActiveRunForThread },
  { method: "GET", path: "/v1/deliveries", auth: "source", handle: listDeliveries },
  { method: "POST", path: "/v1/deliveries/:id/ack", auth: "source", handle: ackDelivery },
  { method: "POST", path: "/v1/deliveries/ack-by-key", auth: "source", handle: ackDeliveryByKey },
];
