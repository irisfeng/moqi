import { personKey } from "../../directory/person.ts";
import { sendJson } from "../http.ts";
import { isObj } from "./shared.ts";
import {
  announcementIdOf,
  notificationCursor,
  projectJoinIdOf,
  withAnnouncements,
  withProjectJoins,
} from "../../notifications/notification-store.ts";
import { type ApiCtx, type Route } from "./route.ts";

function viewer(ctx: ApiCtx): string | null {
  const requested = ctx.url.searchParams.get("principalId") ?? "";
  const principal = ctx.actor?.p ?? ctx.capability?.actorId;
  if (principal && requested && principal !== requested) return null;
  return principal ?? (ctx.auth || ctx.allowUnsignedSourceAuth ? requested || null : null);
}

async function announcementsFor(
  ctx: ApiCtx,
  principal: string,
): Promise<{ active: Array<{ id: string; title: string; startsAt: number }>; dismissed: string[] }> {
  const announcements = ctx.deps.announcements;
  if (!announcements) return { active: [], dismissed: [] };
  const [active, dismissed] = await Promise.all([announcements.listActive(), announcements.dismissals(principal)]);
  return { active, dismissed };
}

export const notificationRoutes: ReadonlyArray<Route<ApiCtx>> = [
  {
    method: "GET",
    path: "/v1/notifications/:id/result",
    auth: "source",
    async handle(ctx) {
      const principal = viewer(ctx);
      if (!principal || !ctx.deps.notifications) return sendJson(ctx.res, 404, { error: "not_found" });
      const sessions = await ctx.app.listSessions(principal);
      const result = await ctx.deps.notifications.result(principal, sessions, ctx.params.id!);
      if (!result) return sendJson(ctx.res, 404, { error: "not_found" });
      const files = [];
      for (const file of result.files) {
        const opened = await ctx.app.openFileForViewer(file.id, principal);
        if (!opened) continue;
        opened.stream.destroy();
        files.push({ id: file.id, name: opened.name });
      }
      return sendJson(ctx.res, 200, { ...result, files });
    },
  },
  {
    method: "GET",
    path: "/v1/notifications",
    auth: "source",
    async handle(ctx) {
      const principal = viewer(ctx);
      if (!principal || !ctx.deps.notifications) return sendJson(ctx.res, 404, { error: "not_found" });
      const cursor = ctx.url.searchParams.get("cursor") || undefined;
      try {
        notificationCursor(cursor);
      } catch {
        return sendJson(ctx.res, 400, { error: "bad_request" });
      }
      const [sessions, person, announced, joins] = await Promise.all([
        ctx.app.listSessions(principal),
        ctx.app.directoryMember(principal).catch(() => null),
        announcementsFor(ctx, principal),
        ctx.deps.projectJoins?.list(personKey(principal)) ?? Promise.resolve([]),
      ]);
      const page = await ctx.deps.notifications.list(principal, sessions, cursor, person?.displayName);
      const withNotices = withAnnouncements(page, announced.active, announced.dismissed, !cursor);
      return sendJson(ctx.res, 200, withProjectJoins(withNotices, joins, !cursor));
    },
  },
  {
    method: "GET",
    path: "/v1/notification-preferences",
    auth: "source",
    async handle(ctx) {
      const principal = viewer(ctx);
      if (!principal || !ctx.deps.notificationPrefs) return sendJson(ctx.res, 404, { error: "not_found" });
      const saved = await ctx.deps.notificationPrefs.get(personKey(principal));
      return sendJson(ctx.res, 200, { muteCompletions: saved?.muteCompletions === true });
    },
  },
  {
    method: "PUT",
    path: "/v1/notification-preferences",
    auth: "source",
    async handle(ctx) {
      const principal = viewer(ctx);
      if (!principal || !ctx.deps.notificationPrefs) return sendJson(ctx.res, 404, { error: "not_found" });
      if (ctx.actor?.imp !== undefined) return sendJson(ctx.res, 403, { error: "impersonation_forbidden" });
      const body = isObj(ctx.body) ? ctx.body : {};
      if (typeof body.muteCompletions !== "boolean")
        return sendJson(ctx.res, 400, { error: "bad_request", message: "muteCompletions must be true or false" });
      const preferences = { muteCompletions: body.muteCompletions };
      await ctx.deps.notificationPrefs.put(personKey(principal), preferences);
      return sendJson(ctx.res, 200, preferences);
    },
  },
  {
    method: "POST",
    path: "/v1/notifications/read-all",
    auth: "source",
    async handle(ctx) {
      const principal = viewer(ctx);
      if (!principal || !ctx.deps.notifications) return sendJson(ctx.res, 404, { error: "not_found" });
      if (ctx.actor?.imp !== undefined) return sendJson(ctx.res, 403, { error: "impersonation_forbidden" });
      const [sessions, announced] = await Promise.all([
        ctx.app.listSessions(principal),
        announcementsFor(ctx, principal),
      ]);
      const pending = announced.active.filter((announcement) => !announced.dismissed.includes(announcement.id));
      for (const announcement of pending) await ctx.deps.announcements?.dismiss(principal, announcement.id);
      const joined = (await ctx.deps.projectJoins?.markAllSeen(personKey(principal), Date.now())) ?? 0;
      const read = (await ctx.deps.notifications.readAll(principal, sessions)) + joined;
      return sendJson(ctx.res, 200, { read: read + pending.length });
    },
  },
  {
    method: "POST",
    path: "/v1/notifications/:id/read",
    auth: "source",
    async handle(ctx) {
      const principal = viewer(ctx);
      if (!principal || !ctx.deps.notifications) return sendJson(ctx.res, 404, { error: "not_found" });
      const projectId = projectJoinIdOf(ctx.params.id!);
      if (projectId !== null) {
        const seen = await ctx.deps.projectJoins?.markSeen(personKey(principal), projectId, Date.now());
        return sendJson(ctx.res, seen ? 200 : 404, seen ? { ok: true } : { error: "not_found" });
      }
      const announcementId = announcementIdOf(ctx.params.id!);
      if (announcementId !== null) {
        const announcements = ctx.deps.announcements;
        if (!announcements || !(await announcements.get(announcementId)))
          return sendJson(ctx.res, 404, { error: "not_found" });
        await announcements.dismiss(principal, announcementId);
        return sendJson(ctx.res, 200, { ok: true });
      }
      const sessions = await ctx.app.listSessions(principal);
      const read = await ctx.deps.notifications.read(principal, sessions, ctx.params.id!);
      return sendJson(ctx.res, read ? 200 : 404, read ? { ok: true } : { error: "not_found" });
    },
  },
];
