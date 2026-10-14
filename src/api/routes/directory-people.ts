import { adminStatusFromGrants } from "../../admin/admin-service.ts";
import { personKey } from "../../directory/person.ts";
import { contactEmail, type PersonContact } from "../../directory/person-contact.ts";
import { departmentByPerson, type RosterEntry } from "../../projects/department-roster.ts";
import { sendJson } from "../http.ts";
import { type ApiCtx, type Route } from "./route.ts";
import { adminActorFrom } from "./shared.ts";

async function viewerIsAdmin(ctx: ApiCtx): Promise<boolean> {
  const actor = adminActorFrom(ctx);
  if (!actor || !ctx.deps.admin) return false;
  return adminStatusFromGrants(await ctx.deps.admin.listGrants(), actor.id).isAdmin;
}

async function listPeople(ctx: ApiCtx): Promise<void> {
  const principalId = (ctx.url.searchParams.get("principalId") ?? "").trim();
  if (!principalId) return sendJson(ctx.res, 400, { error: "bad_request", message: "principalId required" });
  const identity = ctx.deps.identity;
  const active = (id: string): boolean => !identity || identity.isInternal(identity.classify(id));
  if (!active(principalId)) return sendJson(ctx.res, 403, { error: "forbidden" });
  const roster: RosterEntry[] = ctx.deps.adoption ? (await ctx.deps.adoption.roster()).members : [];
  const departments = departmentByPerson(roster, Date.now());
  const contacts = new Map<string, PersonContact>(
    ctx.deps.personContacts ? await ctx.deps.personContacts.entries() : [],
  );
  const everyone = await viewerIsAdmin(ctx);
  const people = (await ctx.app.directoryMembers())
    .filter((member) => member.type === "internal" && active(member.principalId))
    .map((member) => ({
      principalId: member.principalId,
      displayName: member.displayName?.trim() || member.principalId,
      department: departments.get(personKey(member.principalId)) ?? null,
      email: contactEmail(member.principalId),
      phone: contacts.get(personKey(member.principalId))?.phone ?? null,
    }))
    .filter((person) => everyone || person.department !== null);
  return sendJson(ctx.res, 200, { people });
}

export const directoryPeopleRoutes: ReadonlyArray<Route<ApiCtx>> = [
  { method: "GET", path: "/v1/directory/people", auth: "source", handle: listPeople },
];
