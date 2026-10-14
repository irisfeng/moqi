import { ProjectBoardError, type ProjectBoardCommand } from "../../projects/project-collaboration.ts";
import { projectScopeId } from "../../projects/project-store.ts";
import { sendJson } from "../http.ts";
import { type ApiCtx, type Route } from "./route.ts";
import { isObj } from "./shared.ts";

async function collaboration(ctx: ApiCtx): Promise<void> {
  const store = ctx.deps.projectCollaboration;
  if (!store) return sendJson(ctx.res, 404, { error: "not_found" });
  const body = isObj(ctx.body) ? ctx.body : {};
  const requested = ctx.req.method === "GET" ? ctx.url.searchParams.get("principalId") : body.principalId;
  const actor = ctx.actor?.p ?? (typeof requested === "string" ? requested.trim() : "");
  if (!actor || (ctx.actor && requested && requested !== actor)) return sendJson(ctx.res, 404, { error: "not_found" });
  try {
    if (!ctx.params.id) return sendJson(ctx.res, 200, { projects: await store.summaries(actor) });
    const board =
      ctx.req.method === "GET"
        ? await store.read(ctx.params.id, actor)
        : await store.update(ctx.params.id, actor, body.command as ProjectBoardCommand);
    if (ctx.req.method === "PUT")
      ctx.deps.auditLog?.record({
        at: Date.now(),
        principalId: actor,
        action: `project.${(body.command as ProjectBoardCommand).kind}`,
        resource: ctx.params.id,
        scopeLabel: projectScopeId(ctx.params.id),
      });
    return sendJson(ctx.res, 200, { board });
  } catch (error) {
    if (!(error instanceof ProjectBoardError)) throw error;
    return sendJson(ctx.res, error.status, {
      error: error.status === 404 ? "not_found" : "project_update_failed",
      message: error.message,
    });
  }
}

export const projectCollaborationRoutes: ReadonlyArray<Route<ApiCtx>> = [
  { method: "GET", path: "/v1/project-collaboration", auth: "source", handle: collaboration },
  { method: "GET", path: "/v1/project-collaboration/:id", auth: "source", handle: collaboration },
  { method: "PUT", path: "/v1/project-collaboration/:id", auth: "source", handle: collaboration },
];
