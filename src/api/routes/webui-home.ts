import { samePerson } from "../../directory/person.ts";
import { createGrowthService, GrowthError, parseGrowthConfig } from "../../webui/growth-service.ts";
import { sendJson } from "../http.ts";
import { authorizeAdmin, isObj, orgScope } from "./shared.ts";
import { type ApiCtx, type Route } from "./route.ts";
import { isWebuiEventType } from "../../webui/webui-events-store.ts";

function actingPrincipalId(ctx: ApiCtx, requested: string): string | null {
  if (ctx.capability) {
    if (requested && requested !== ctx.capability.actorId) {
      sendJson(ctx.res, 404, { error: "not_found" });
      return null;
    }
    return ctx.capability.actorId;
  }
  if (ctx.actor) {
    if (requested && !samePerson(requested, ctx.actor.p)) {
      sendJson(ctx.res, 404, { error: "not_found" });
      return null;
    }
    return ctx.actor.p;
  }
  return requested;
}

async function getWebuiHome(ctx: ApiCtx): Promise<void> {
  const { res, deps } = ctx;
  if (!deps.webuiHome) return sendJson(res, 404, { error: "not_found" });
  const config = await deps.webuiHome.get(orgScope(deps));
  if (!config || typeof config !== "object") return sendJson(res, 404, { error: "not_found" });
  return sendJson(res, 200, config);
}

async function getAdminWebuiHome(ctx: ApiCtx): Promise<void> {
  const { res, deps } = ctx;
  const actor = await authorizeAdmin(ctx, orgScope(deps));
  if (!actor) return;
  if (!deps.webuiHome) return sendJson(res, 404, { error: "not_found" });
  return sendJson(res, 200, { home: (await deps.webuiHome.get(orgScope(deps))) ?? null });
}

async function postWebuiEvent(ctx: ApiCtx): Promise<void> {
  const { res, deps, body } = ctx;
  if (!deps.webuiEvents) return sendJson(res, 404, { error: "not_found" });
  const b = isObj(body) ? body : {};
  const requested = typeof b.principalId === "string" ? b.principalId.trim() : "";
  const principalId = actingPrincipalId(ctx, requested);
  if (principalId === null) return;
  if (!principalId) return sendJson(res, 400, { error: "bad_request", message: "principalId required" });
  if (!isWebuiEventType(b.type)) {
    return sendJson(res, 400, { error: "bad_request", message: "type must be a known webui event type" });
  }
  const ref = typeof b.ref === "string" ? b.ref.slice(0, 128) : "";
  await deps.webuiEvents.record(principalId, b.type, ref);
  return sendJson(res, 204, "");
}

async function growth(ctx: ApiCtx): Promise<void> {
  const { deps, res } = ctx;
  const principal = ctx.actor?.p;
  if (!principal || ctx.capability)
    return sendJson(res, 403, { error: "forbidden", message: "Use your own signed-in workspace" });
  const body = isObj(ctx.body) ? ctx.body : {};
  const requested = body.principalId ?? ctx.url.searchParams.get("principalId");
  if (requested && !samePerson(String(requested), principal)) return sendJson(res, 404, { error: "not_found" });
  const home = await deps.webuiHome?.get(orgScope(deps));
  const config = parseGrowthConfig(isObj(home) ? home.growth : null);
  if (!deps.growth || !deps.sessions || !deps.runs || !config)
    return sendJson(res, 503, { error: "unavailable", message: "The growth guide is not ready yet. Try again later" });
  try {
    const service = createGrowthService({ store: deps.growth, sessions: deps.sessions, runs: deps.runs });
    return sendJson(res, 200, await service.execute(principal, config, ctx.method === "POST" ? body : {}));
  } catch (error) {
    if (error instanceof GrowthError) return sendJson(res, 409, { error: "growth_state", message: error.message });
    throw error;
  }
}

export const webuiHomeRoutes: ReadonlyArray<Route<ApiCtx>> = [
  { method: "GET", path: "/v1/me/growth", auth: "source", handle: growth },
  { method: "POST", path: "/v1/me/growth/action", auth: "source", handle: growth },
  { method: "GET", path: "/v1/webui-home", auth: "source", handle: getWebuiHome },
  { method: "GET", path: "/v1/admin/webui-home", auth: "either", handle: getAdminWebuiHome },
  { method: "POST", path: "/v1/webui-events", auth: "source", handle: postWebuiEvent },
];
