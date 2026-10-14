import { sendJson } from "../../http.ts";
import { audit, authorizeAdmin, isObj, orgScope } from "../shared.ts";
import { type ApiCtx } from "../route.ts";
import {
  ANNOUNCEMENT_LEVELS,
  isAnnouncementLevel,
  type AnnouncementLevel,
  type AnnouncementPatch,
} from "../../../announcements/announcement-store.ts";

const MAX_TITLE_CHARS = 200;
const MAX_BODY_CHARS = 20_000;

function validImageCount(body: string): boolean {
  return [...body.matchAll(/\/api\/announcement-images\/[a-f0-9]{32}/g)].length <= 6;
}

function parseEpochMs(value: unknown): number | null {
  return typeof value === "number" && value >= 0 && value <= Number.MAX_SAFE_INTEGER ? Math.floor(value) : null;
}

export async function createAnnouncement(ctx: ApiCtx): Promise<void> {
  const { res, deps, body } = ctx;
  const actor = await authorizeAdmin(ctx, orgScope(deps));
  if (!actor) return;
  if (!deps.announcements) return sendJson(res, 404, { error: "not_found" });
  const b = isObj(body) ? body : {};
  if (b.popup !== undefined && typeof b.popup !== "boolean")
    return sendJson(res, 400, { error: "bad_request", message: "popup must be boolean" });
  const title = typeof b.title === "string" ? b.title.trim() : "";
  const text = typeof b.body === "string" ? b.body : "";
  const startsAt = parseEpochMs(b.startsAt);
  const endsAt = parseEpochMs(b.endsAt);
  if (!isAnnouncementLevel(b.level)) {
    return sendJson(res, 400, {
      error: "bad_request",
      message: `level must be one of ${ANNOUNCEMENT_LEVELS.join("|")}`,
    });
  }
  if (!title || title.length > MAX_TITLE_CHARS) {
    return sendJson(res, 400, {
      error: "bad_request",
      message: `title required (1-${MAX_TITLE_CHARS} characters)`,
    });
  }
  if (text.length > MAX_BODY_CHARS) {
    return sendJson(res, 400, { error: "bad_request", message: `body must be at most ${MAX_BODY_CHARS} characters` });
  }
  if (!validImageCount(text))
    return sendJson(res, 400, { error: "too_many_images", message: "An announcement can have at most 6 images." });
  if (startsAt === null || (b.endsAt !== null && (endsAt === null || endsAt <= startsAt))) {
    return sendJson(res, 400, {
      error: "bad_request",
      message: "startsAt required; endsAt must be null or epoch ms after startsAt",
    });
  }
  const announcement = await deps.announcements.create(
    { level: b.level, title, body: text, startsAt, endsAt, popup: b.popup === true },
    actor.id,
  );
  audit(deps, {
    principalId: actor.id,
    action: "announcement.create",
    resource: announcement.id,
    scopeLabel: orgScope(deps),
  });
  return sendJson(res, 201, { announcement });
}

export async function listAnnouncements(ctx: ApiCtx): Promise<void> {
  const { res, deps } = ctx;
  const actor = await authorizeAdmin(ctx, orgScope(deps));
  if (!actor) return;
  if (!deps.announcements) return sendJson(res, 404, { error: "not_found" });
  return sendJson(res, 200, { announcements: await deps.announcements.list() });
}

export async function putAnnouncement(ctx: ApiCtx): Promise<void> {
  const { res, deps, body, params } = ctx;
  const actor = await authorizeAdmin(ctx, orgScope(deps));
  if (!actor) return;
  if (!deps.announcements) return sendJson(res, 404, { error: "not_found" });
  const id = params.id!;
  const current = await deps.announcements.get(id);
  if (!current) return sendJson(res, 404, { error: "not_found" });
  const b = isObj(body) ? body : {};
  if (b.popup !== undefined && typeof b.popup !== "boolean")
    return sendJson(res, 400, { error: "bad_request", message: "popup must be boolean" });
  const patch: AnnouncementPatch = {};
  if (b.popup !== undefined) patch.popup = b.popup as boolean;
  if (b.level !== undefined) {
    if (!isAnnouncementLevel(b.level)) {
      return sendJson(res, 400, {
        error: "bad_request",
        message: `level must be one of ${ANNOUNCEMENT_LEVELS.join("|")}`,
      });
    }
    patch.level = b.level as AnnouncementLevel;
  }
  if (b.title !== undefined) {
    if (typeof b.title !== "string" || !b.title.trim() || b.title.trim().length > MAX_TITLE_CHARS) {
      return sendJson(res, 400, {
        error: "bad_request",
        message: `title must be 1-${MAX_TITLE_CHARS} characters`,
      });
    }
    patch.title = b.title.trim();
  }
  if (b.body !== undefined) {
    if (typeof b.body !== "string" || b.body.length > MAX_BODY_CHARS) {
      return sendJson(res, 400, { error: "bad_request", message: `body must be at most ${MAX_BODY_CHARS} characters` });
    }
    if (!validImageCount(b.body))
      return sendJson(res, 400, { error: "too_many_images", message: "An announcement can have at most 6 images." });
    patch.body = b.body;
  }
  if (b.startsAt !== undefined) {
    const startsAt = parseEpochMs(b.startsAt);
    if (startsAt === null) {
      return sendJson(res, 400, { error: "bad_request", message: "startsAt must be epoch ms" });
    }
    patch.startsAt = startsAt;
  }
  if (b.endsAt !== undefined) {
    const endsAt = parseEpochMs(b.endsAt);
    if (b.endsAt !== null && endsAt === null) {
      return sendJson(res, 400, { error: "bad_request", message: "endsAt must be null or epoch ms" });
    }
    patch.endsAt = endsAt;
  }
  const startsAt = patch.startsAt ?? current.startsAt;
  const endsAt = patch.endsAt === undefined ? current.endsAt : patch.endsAt;
  if (endsAt !== null && endsAt <= startsAt) {
    return sendJson(res, 400, { error: "bad_request", message: "endsAt must stay after startsAt" });
  }
  const announcement = await deps.announcements.update(id, patch);
  if (!announcement) return sendJson(res, 404, { error: "not_found" });
  audit(deps, {
    principalId: actor.id,
    action: "announcement.update",
    resource: `${id}/${Object.keys(patch).join(",") || "noop"}`,
    scopeLabel: orgScope(deps),
  });
  return sendJson(res, 200, { announcement });
}
