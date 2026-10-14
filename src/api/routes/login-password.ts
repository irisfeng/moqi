import { loginSessionHash } from "../../auth/login-password-store.ts";
import { randomUUID } from "node:crypto";
import { sendJson } from "../http.ts";
import type { ApiCtx, Route } from "./route.ts";

function principalIdOf(body: Record<string, unknown>): string | null {
  const id = body.principalId;
  if (typeof id !== "string") return null;
  const trimmed = id.trim().toLowerCase();
  return trimmed.length > 0 && trimmed.length <= 254 ? trimmed : null;
}

function passwordOf(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0 || value.length > 128) return null;
  return value;
}

function bodyObject(ctx: ApiCtx): Record<string, unknown> {
  const body = ctx.body;
  return body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
}

async function verifyPassword(ctx: ApiCtx): Promise<void> {
  const { res, deps } = ctx;
  if (!deps.loginPasswords) return sendJson(res, 501, { error: "not_configured" });
  const body = bodyObject(ctx);
  const principalId = principalIdOf(body);
  if (!principalId || typeof body.password !== "string" || !body.password)
    return sendJson(res, 400, { error: "bad_request" });
  const password = passwordOf(body.password);
  if (password === null || !deps.identity || !(await deps.identity.isActive(principalId)))
    return sendJson(res, 200, { status: "invalid" });
  const outcome = await deps.loginPasswords.verify(principalId, password);
  if (outcome.status === "ok")
    return sendJson(res, 200, { status: "ok", forceChange: outcome.forceChange, version: outcome.version });
  if (outcome.status === "locked") return sendJson(res, 200, { status: "locked", retryInMs: outcome.retryInMs });
  return sendJson(res, 200, { status: "invalid" });
}

async function setPassword(ctx: ApiCtx): Promise<void> {
  const { res, deps } = ctx;
  if (!deps.loginPasswords) return sendJson(res, 501, { error: "not_configured" });
  const body = bodyObject(ctx);
  const principalId = principalIdOf(body);
  const next = passwordOf(body.nextPassword);
  const current = passwordOf(body.currentPassword);
  if (!principalId || next === null) return sendJson(res, 400, { error: "bad_request" });
  if (!deps.identity || !(await deps.identity.isActive(principalId)))
    return sendJson(res, 403, { error: "invalid_session" });
  const version = randomUUID();
  const expectedVersion = typeof body.version === "string" ? body.version : "";
  const outcome = await deps.loginPasswords.setNew(principalId, next, current, Date.now(), expectedVersion, version);
  if (outcome === "ok") return sendJson(res, 200, { ok: true, version });
  if (outcome === "weak-password")
    return sendJson(res, 400, { error: "weak_password", message: "password must be 8-128 characters" });
  if (outcome === "same-as-initial")
    return sendJson(res, 400, {
      error: "same_as_initial",
      message: "the new password must differ from the initial one",
    });
  return sendJson(res, 403, { error: "wrong_current", message: "the current password does not match" });
}

async function putCredential(ctx: ApiCtx): Promise<void> {
  const { res, deps } = ctx;
  if (!deps.loginPasswords) return sendJson(res, 501, { error: "not_configured" });
  const body = bodyObject(ctx);
  const principalId = principalIdOf(body);
  const initialPassword = passwordOf(body.initialPassword);
  if (!principalId || initialPassword === null) return sendJson(res, 400, { error: "bad_request" });
  try {
    const record = await deps.loginPasswords.putInitial({
      id: principalId,
      initialPassword,
      updatedBy: "operator-import",
    });
    return sendJson(res, 200, { ok: true, forceChange: record.forceChange });
  } catch (e) {
    const message = e instanceof Error ? e.message : "invalid initial password";
    return sendJson(res, 400, { error: "bad_request", message });
  }
}

async function sessionValid(ctx: ApiCtx, body: Record<string, unknown>): Promise<boolean> {
  const { deps } = ctx;
  const principalId = principalIdOf(body);
  if (!principalId || !deps.loginPasswords || (body.version !== undefined && typeof body.version !== "string"))
    return false;
  if (!deps.identity || !(await deps.identity.isActive(principalId))) return false;
  if (
    body.impersonatedPrincipalId !== undefined &&
    (typeof body.impersonatedPrincipalId !== "string" || !(await deps.identity.isActive(body.impersonatedPrincipalId)))
  )
    return false;
  const record = await deps.loginPasswords.get(principalId);
  if (body.sid !== undefined) {
    if (
      typeof body.sid !== "string" ||
      !/^[a-f0-9]{64}$/.test(body.sid) ||
      !record ||
      record.forceChange ||
      (record.version ?? "") !== (body.version ?? "")
    )
      return false;
    const hash = loginSessionHash(body.sid);
    return (record.devices ?? []).some((device) => device.sidHash === hash && device.expiresAt > Date.now());
  }
  if (!record) return !body.version;
  return !record.forceChange && (record.version ?? "") === (body.version ?? "");
}

async function validateSession(ctx: ApiCtx): Promise<void> {
  const { res, deps } = ctx;
  res.setHeader("cache-control", "no-store");
  if (!deps.loginPasswords) return sendJson(res, 501, { error: "not_configured" });
  const body = bodyObject(ctx);
  const principalId = principalIdOf(body);
  if (!principalId || (body.version !== undefined && typeof body.version !== "string"))
    return sendJson(res, 400, { error: "bad_request" });
  return sendJson(res, 200, { valid: await sessionValid(ctx, body) });
}

async function rememberedDevices(ctx: ApiCtx): Promise<void> {
  const { res, deps } = ctx;
  res.setHeader("cache-control", "no-store");
  const body = bodyObject(ctx);
  const principalId = principalIdOf(body);
  if (!principalId || !deps.loginPasswords) return sendJson(res, 400, { error: "bad_request" });
  if (body.action === "logout") {
    if (typeof body.sid !== "string" || !/^[a-f0-9]{64}$/.test(body.sid))
      return sendJson(res, 400, { error: "bad_request" });
    await deps.loginPasswords.revokeSession(principalId, body.sid);
    return sendJson(res, 200, { ok: true });
  }
  if (!(await sessionValid(ctx, body))) return sendJson(res, 403, { error: "invalid_session" });
  const record = await deps.loginPasswords.get(principalId);
  if (!record || typeof body.version !== "string" || record.forceChange || (record.version ?? "") !== body.version)
    return sendJson(res, 403, { error: "password_login_required" });
  if (
    typeof body.sid === "string" &&
    !(record.devices ?? []).some(
      (device) => device.sidHash === loginSessionHash(body.sid as string) && device.expiresAt > Date.now(),
    )
  )
    return sendJson(res, 403, { error: "invalid_session" });
  if (body.action === "remember") {
    if (
      typeof body.newSid !== "string" ||
      typeof body.deviceId !== "string" ||
      typeof body.label !== "string" ||
      typeof body.createdAt !== "number" ||
      typeof body.expiresAt !== "number"
    )
      return sendJson(res, 400, { error: "bad_request" });
    const result = await deps.loginPasswords.remember(principalId, body.version, body.newSid, {
      id: body.deviceId,
      label: body.label,
      createdAt: body.createdAt,
      expiresAt: body.expiresAt,
    });
    let status = 403;
    if (result === "ok") status = 200;
    else if (result === "limit") status = 409;
    return sendJson(res, status, {
      ok: result === "ok",
      error: result === "ok" ? undefined : result,
    });
  }
  if (body.action === "revoke") {
    if (typeof body.deviceId !== "string" || body.deviceId.length > 64)
      return sendJson(res, 400, { error: "bad_request" });
    const revokedCurrent =
      typeof body.sid === "string" &&
      (record.devices ?? []).some(
        (device) => device.id === body.deviceId && device.sidHash === loginSessionHash(body.sid as string),
      );
    const ok = await deps.loginPasswords.revokeDevice(
      principalId,
      body.version,
      body.deviceId,
      typeof body.sid === "string" ? body.sid : undefined,
    );
    return sendJson(res, ok ? 200 : 403, { ok, revokedCurrent: ok && revokedCurrent });
  }
  if (body.action !== "list") return sendJson(res, 400, { error: "bad_request" });
  const current = typeof body.sid === "string" ? loginSessionHash(body.sid) : "";
  return sendJson(res, 200, {
    devices: (record.devices ?? [])
      .filter((device) => device.expiresAt > Date.now())
      .map(({ sidHash, ...device }) => ({ ...device, current: sidHash === current })),
  });
}

export const loginPasswordRoutes: ReadonlyArray<Route<ApiCtx>> = [
  { method: "POST", path: "/v1/auth/password/devices", auth: "source", handle: rememberedDevices },
  { method: "POST", path: "/v1/auth/password/session", auth: "source", handle: validateSession },
  { method: "POST", path: "/v1/auth/password/verify", auth: "source", handle: verifyPassword },
  { method: "POST", path: "/v1/auth/password/set", auth: "source", handle: setPassword },
  { method: "PUT", path: "/v1/auth/password/credential", auth: "source", handle: putCredential },
];
