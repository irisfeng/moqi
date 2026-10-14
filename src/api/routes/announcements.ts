import { samePerson } from "../../directory/person.ts";
import { sniffImageDimensions } from "../../core/image-downscale.ts";
import { randomUUID } from "node:crypto";
import { fileArtifactId } from "../../files/file-artifact-store.ts";
import { audit, authorizeAdmin, orgScope } from "./shared.ts";
import { pipeToResponse, sendJson } from "../http.ts";
import { isObj } from "./shared.ts";
import { type ApiCtx, type Route } from "./route.ts";

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

async function listAnnouncementsForViewer(ctx: ApiCtx): Promise<void> {
  const { res, deps } = ctx;
  if (!deps.announcements) return sendJson(res, 404, { error: "not_found" });
  const requested = (ctx.url.searchParams.get("principalId") ?? "").trim();
  const principalId = actingPrincipalId(ctx, requested);
  if (principalId === null) return;
  const [announcements, dismissed] = await Promise.all([
    deps.announcements.listActive(),
    principalId ? deps.announcements.dismissals(principalId) : Promise.resolve([]),
  ]);
  return sendJson(res, 200, { announcements, dismissed });
}

async function dismissAnnouncement(ctx: ApiCtx): Promise<void> {
  const { res, deps, params, body } = ctx;
  if (!deps.announcements) return sendJson(res, 404, { error: "not_found" });
  const requested = isObj(body) && typeof body.principalId === "string" ? body.principalId.trim() : "";
  const principalId = actingPrincipalId(ctx, requested);
  if (principalId === null) return;
  if (!principalId) return sendJson(res, 400, { error: "bad_request", message: "principalId required" });
  const id = params.id!;
  if (!(await deps.announcements.get(id))) return sendJson(res, 404, { error: "not_found" });
  const dismissed = await deps.announcements.dismiss(principalId, id);
  return sendJson(res, 200, { ok: true, dismissed });
}

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const IMAGE_ID = /^[a-f0-9]{32}$/;

function imageType(data: Buffer): string | null {
  if (
    data.length >= 24 &&
    data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) &&
    data.toString("ascii", 12, 16) === "IHDR"
  )
    return "image/png";
  if (
    data.length >= 4 &&
    data[0] === 255 &&
    data[1] === 216 &&
    data[2] === 255 &&
    data[data.length - 2] === 255 &&
    data[data.length - 1] === 217
  )
    return "image/jpeg";
  if (
    data.length >= 20 &&
    data.toString("ascii", 0, 4) === "RIFF" &&
    data.toString("ascii", 8, 12) === "WEBP" &&
    data.readUInt32LE(4) + 8 === data.length
  )
    return "image/webp";
  return null;
}

async function uploadAnnouncementImage(ctx: ApiCtx): Promise<void> {
  const { deps, res, body } = ctx;
  const actor = await authorizeAdmin(ctx, orgScope(deps));
  if (!actor) return;
  if (!deps.files || !deps.blobTransfer) return sendJson(res, 503, { error: "not_configured" });
  const blobId = isObj(body) && typeof body.blobId === "string" ? body.blobId : "";
  if (!blobId) return sendJson(res, 400, { error: "bad_request" });
  const opened = await deps.blobTransfer.open(blobId);
  if (!opened) return sendJson(res, 404, { error: "not_found" });
  try {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of opened.stream) {
      size += chunk.length;
      if (size > MAX_IMAGE_BYTES) {
        opened.stream.destroy();
        return sendJson(res, 413, { error: "too_large", message: "Images cannot exceed 5 MB." });
      }
      chunks.push(Buffer.from(chunk));
    }
    const data = Buffer.concat(chunks);
    const mimetype = imageType(data);
    if (!mimetype) return sendJson(res, 400, { error: "invalid_image", message: "Choose a PNG, JPEG or WebP image." });
    const dimensions = sniffImageDimensions(data);
    if (
      !dimensions ||
      dimensions.width < 1 ||
      dimensions.height < 1 ||
      dimensions.width > 8192 ||
      dimensions.height > 8192 ||
      dimensions.width * dimensions.height > 20_000_000
    )
      return sendJson(res, 400, {
        error: "invalid_dimensions",
        message: "The longest image side cannot exceed 8192 pixels, and total pixels cannot exceed 20 million.",
      });
    const id = fileArtifactId(`announcement-image:${randomUUID()}`, "in", 0);
    const extension = mimetype === "image/jpeg" ? "jpg" : mimetype.split("/")[1]!;
    const name = `announcement-${id}.${extension}`;
    await deps.files.put({
      id,
      ownerScopeId: orgScope(deps),
      createdBy: actor.id,
      name,
      path: `announcement-images/${id}/${name}`,
      mimetype,
      data,
      direction: "in",
      maxBytes: MAX_IMAGE_BYTES,
    });
    audit(deps, {
      principalId: actor.id,
      action: "announcement.image.upload",
      resource: id,
      scopeLabel: orgScope(deps),
    });
    return sendJson(res, 201, { url: `/api/announcement-images/${id}`, id });
  } finally {
    opened.stream.destroy();
    await deps.blobTransfer.delete(blobId);
  }
}

async function readAnnouncementImage(ctx: ApiCtx): Promise<void> {
  const { deps, res, params } = ctx;
  const id = params.id ?? "";
  if (!IMAGE_ID.test(id) || !deps.files) return sendJson(res, 404, { error: "not_found" });
  const file = await deps.files.get(id);
  if (
    !file ||
    file.ownerScopeId !== orgScope(deps) ||
    !file.path.startsWith(`announcement-images/${id}/`) ||
    !["image/png", "image/jpeg", "image/webp"].includes(file.mimetype)
  )
    return sendJson(res, 404, { error: "not_found" });
  const opened = await deps.files.open(id);
  if (!opened) return sendJson(res, 404, { error: "not_found" });
  res.writeHead(200, {
    "content-type": file.mimetype,
    "content-length": String(opened.sizeBytes),
    "cache-control": "private, no-cache",
    "x-content-type-options": "nosniff",
    "content-security-policy": "default-src 'none'; sandbox",
  });
  pipeToResponse(res, opened.stream, "announcement image read failed");
}

export const announcementRoutes: ReadonlyArray<Route<ApiCtx>> = [
  { method: "POST", path: "/v1/admin/announcement-images", auth: "source", handle: uploadAnnouncementImage },
  { method: "GET", path: "/v1/announcement-images/:id", auth: "source", handle: readAnnouncementImage },
  { method: "GET", path: "/v1/announcements", auth: "source", handle: listAnnouncementsForViewer },
  { method: "POST", path: "/v1/announcements/:id/dismiss", auth: "source", handle: dismissAnnouncement },
];
