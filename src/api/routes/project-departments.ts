import { personKey } from "../../directory/person.ts";
import { departmentMembers, departmentNames } from "../../projects/department-roster.ts";
import { sendJson } from "../http.ts";
import { isObj } from "./shared.ts";
import { type ApiCtx, type Route } from "./route.ts";

const DEPARTMENT_ADD_LIMIT = 500;

function previewRefused(ctx: ApiCtx, status: "not_found" | "forbidden"): void {
  return sendJson(ctx.res, status === "not_found" ? 404 : 403, { error: status });
}

async function projectDepartments(ctx: ApiCtx): Promise<void> {
  const principalId = (ctx.url.searchParams.get("principalId") ?? "").trim();
  if (!principalId) return sendJson(ctx.res, 400, { error: "bad_request", message: "principalId required" });
  const department = (ctx.url.searchParams.get("department") ?? "").trim();
  const roster = ctx.deps.adoption ? (await ctx.deps.adoption.roster()).members : [];
  const now = Date.now();
  const preview = await ctx.app.previewProjectMembers(
    ctx.params.id!,
    principalId,
    department ? departmentMembers(roster, department, now) : [],
  );
  if (preview.status !== "ok") return previewRefused(ctx, preview.status);
  return sendJson(ctx.res, 200, {
    departments: departmentNames(roster, now),
    ...(department ? { department, members: preview.members, alreadyIn: preview.alreadyIn } : {}),
  });
}

async function addProjectDepartment(ctx: ApiCtx): Promise<void> {
  const body = isObj(ctx.body) ? ctx.body : {};
  const principalId = typeof body.principalId === "string" ? body.principalId.trim() : "";
  if (ctx.actor?.imp !== undefined) return sendJson(ctx.res, 403, { error: "impersonation_forbidden" });
  const department = typeof body.department === "string" ? body.department.trim() : "";
  const memberIds = Array.isArray(body.memberIds) ? body.memberIds : null;
  if (
    !principalId ||
    !department ||
    !memberIds ||
    memberIds.length > DEPARTMENT_ADD_LIMIT ||
    !memberIds.every((id): id is string => typeof id === "string")
  )
    return sendJson(ctx.res, 400, {
      error: "bad_request",
      message: `principalId, department and up to ${DEPARTMENT_ADD_LIMIT} memberIds required`,
    });
  const roster = ctx.deps.adoption ? (await ctx.deps.adoption.roster()).members : [];
  const preview = await ctx.app.previewProjectMembers(
    ctx.params.id!,
    principalId,
    departmentMembers(roster, department, Date.now()),
  );
  if (preview.status !== "ok") return previewRefused(ctx, preview.status);
  const confirmed = new Set(memberIds.map(personKey));
  let added = 0;
  for (const member of preview.members) {
    if (!confirmed.has(personKey(member.principalId))) continue;
    const result = await ctx.app.addProjectMember(ctx.params.id!, principalId, member.principalId);
    if (result.status === "ok" && result.changed) added += 1;
  }
  return sendJson(ctx.res, 200, { added, skipped: memberIds.length - added });
}

export const projectDepartmentRoutes: ReadonlyArray<Route<ApiCtx>> = [
  { method: "GET", path: "/v1/projects/:id/departments", auth: "source", handle: projectDepartments },
  { method: "POST", path: "/v1/projects/:id/members/department", auth: "source", handle: addProjectDepartment },
];
