import { canonicalPerson, personKey, samePerson } from "../../../directory/person.ts";
import { contactEmail, parsePhone } from "../../../directory/person-contact.ts";
import { sendJson } from "../../http.ts";
import { type ApiCtx, type Route } from "../route.ts";
import { audit, authorizeAdmin, orgScope } from "../shared.ts";

type ContactTarget = { principalId: string; key: string };

async function contactTarget(ctx: ApiCtx, requested: string): Promise<ContactTarget | null> {
  const directory = ctx.deps.directory;
  const member = directory
    ? ((await directory.get(requested)) ?? (await directory.get(canonicalPerson(requested))))
    : null;
  if (directory && !member) {
    sendJson(ctx.res, 404, { error: "not_found", message: "No such person in the directory." });
    return null;
  }
  const principalId = member?.principalId ?? personKey(requested);
  return { principalId, key: personKey(principalId) };
}

function selfPrincipal(ctx: ApiCtx): string | null {
  const principal = ctx.actor?.p;
  if (!principal || ctx.capability) {
    sendJson(ctx.res, 403, { error: "forbidden", message: "Use your own signed-in workspace" });
    return null;
  }
  const body = ctx.body as { principalId?: unknown } | null;
  const requested = body?.principalId ?? ctx.url.searchParams.get("principalId");
  if (requested && !samePerson(String(requested), principal)) {
    sendJson(ctx.res, 404, { error: "not_found" });
    return null;
  }
  return principal;
}

async function readContact(ctx: ApiCtx, requested: string): Promise<void> {
  const contacts = ctx.deps.personContacts;
  if (!contacts) return sendJson(ctx.res, 404, { error: "not_found" });
  const target = await contactTarget(ctx, requested);
  if (!target) return;
  const saved = await contacts.get(target.key);
  return sendJson(ctx.res, 200, { email: contactEmail(target.principalId), phone: saved?.phone ?? null });
}

async function writeContact(ctx: ApiCtx, actorId: string, requested: string): Promise<void> {
  const contacts = ctx.deps.personContacts;
  if (!contacts) return sendJson(ctx.res, 404, { error: "not_found" });
  const parsed = parsePhone((ctx.body as { phone?: unknown } | null)?.phone);
  if (!parsed) {
    return sendJson(ctx.res, 400, {
      error: "bad_request",
      message: "A phone number is up to 32 characters: digits, spaces, + - ( ) and 转, with at least 3 digits.",
    });
  }
  const target = await contactTarget(ctx, requested);
  if (!target) return;
  if (parsed.phone === null) await contacts.delete(target.key);
  else await contacts.put(target.key, { phone: parsed.phone });
  audit(ctx.deps, {
    principalId: actorId,
    action: "user.contact.set",
    resource: target.principalId,
    scopeLabel: orgScope(ctx.deps),
  });
  return sendJson(ctx.res, 200, { email: contactEmail(target.principalId), phone: parsed.phone });
}

async function getUserContact(ctx: ApiCtx): Promise<void> {
  ctx.res.setHeader("cache-control", "no-store");
  if (!(await authorizeAdmin(ctx, orgScope(ctx.deps)))) return;
  return readContact(ctx, ctx.params.principalId ?? "");
}

async function setUserContact(ctx: ApiCtx): Promise<void> {
  ctx.res.setHeader("cache-control", "no-store");
  const actor = await authorizeAdmin(ctx, orgScope(ctx.deps));
  if (!actor) return;
  return writeContact(ctx, actor.id, ctx.params.principalId ?? "");
}

async function getOwnContact(ctx: ApiCtx): Promise<void> {
  ctx.res.setHeader("cache-control", "no-store");
  const principal = selfPrincipal(ctx);
  if (!principal) return;
  return readContact(ctx, principal);
}

async function setOwnContact(ctx: ApiCtx): Promise<void> {
  ctx.res.setHeader("cache-control", "no-store");
  const principal = selfPrincipal(ctx);
  if (!principal) return;
  if (ctx.actor?.imp !== undefined) return sendJson(ctx.res, 403, { error: "impersonation_forbidden" });
  return writeContact(ctx, principal, principal);
}

export const userContactRoutes: ReadonlyArray<Route<ApiCtx>> = [
  { method: "GET", path: "/v1/admin/users/:principalId/contact", auth: "source", handle: getUserContact },
  { method: "PUT", path: "/v1/admin/users/:principalId/contact", auth: "source", handle: setUserContact },
  { method: "GET", path: "/v1/me/contact", auth: "source", handle: getOwnContact },
  { method: "PUT", path: "/v1/me/contact", auth: "source", handle: setOwnContact },
];
