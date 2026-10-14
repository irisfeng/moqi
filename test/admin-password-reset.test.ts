import "./support/auto-fake-sprites.ts";
import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { test } from "node:test";
import type { AddressInfo } from "node:net";
import { buildApp } from "../src/wiring.ts";
import { createServer } from "../src/api/server.ts";
import { createLoginPasswordStore } from "../src/auth/login-password-store.ts";
import { testConfig } from "./support/test-config.ts";
import { signedHeaders, withSourceAuthNonce } from "../plugins/chassis/src/core-client.ts";

const id = "member-reset@example.test";
const secret = "fixture-source-secret".repeat(3);
const identitySecret = "fixture-portal-secret".repeat(3);

async function harness() {
  const built = buildApp(testConfig());
  const passwords = createLoginPasswordStore();
  const initial = await passwords.putInitial({ id, initialPassword: "fixture-initial", updatedBy: "fixture" });
  await passwords.setNew(id, "fixture-private", null, undefined, initial.version);
  const server = createServer(built.app, {
    config: built.config,
    admin: built.admin,
    identity: built.identity,
    auditLog: built.auditLog,
    loginPasswords: passwords,
    signingSecret: secret,
    portalIdentitySecret: identitySecret,
    capabilitySecret: "fixture-capability-secret".repeat(3),
    requireSignedPortalIdentity: true,
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  async function call(method: string, path: string, body?: unknown, actor?: string, imp?: string) {
    const target = withSourceAuthNonce(path, secret);
    const raw = body ? JSON.stringify(body) : "";
    const headers = signedHeaders(secret, method, target, raw);
    if (actor) {
      const payload = Buffer.from(
        JSON.stringify({ p: actor, exp: Date.now() + 60_000, ...(imp ? { imp } : {}) }),
      ).toString("base64url");
      headers["x-portal-identity"] =
        `${payload}.${createHmac("sha256", identitySecret).update(payload).digest("base64url")}`;
    }
    const response = await fetch(base + target, { method, headers, ...(body ? { body: raw } : {}) });
    return { status: response.status, data: (await response.json()) as Record<string, any> };
  }
  return { built, passwords, call, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

test("admin reset requires verified admin identity, persists audit and invalidates old sessions", async () => {
  const h = await harness();
  try {
    const version = (await h.passwords.get(id))!.version!;
    const body = { version, operationId: randomUUID() };
    const path = `/v1/admin/users/${id}/password-reset`;
    assert.equal((await h.call("POST", path, body)).status, 401);
    assert.equal((await h.call("POST", path, body, id)).status, 403);
    assert.equal((await h.call("POST", path, body, "admin-alice", "admin-bob")).status, 403);
    assert.equal((await h.call("POST", "/v1/admin/users/admin-alice/password-reset", body, "admin-alice")).status, 400);
    assert.equal((await h.call("POST", path, { version, operationId: "bad" }, "admin-alice")).status, 400);
    assert.equal((await h.call("POST", "/v1/auth/password/session", { principalId: id, version })).data.valid, true);
    assert.equal((await h.call("POST", path, body, "admin-alice")).status, 200);
    assert.equal((await h.call("POST", path, body, "admin-alice")).status, 200);
    assert.equal((await h.call("POST", "/v1/auth/password/session", { principalId: id, version })).data.valid, false);
    assert.equal(
      (await h.call("POST", "/v1/auth/password/session", { principalId: id, version: body.operationId })).data.valid,
      false,
    );
    const detail = await h.call("GET", `/v1/admin/users/${id}/password`, undefined, "admin-alice");
    assert.equal(detail.status, 200);
    assert.equal(detail.data.forceChange, true);
    assert.doesNotMatch(JSON.stringify(detail.data), /scrypt\$|fixture-initial|fixture-private|initialHash/);
    const audit = (await h.built.auditLog.events()).filter((event) => event.action === "user.password.reset");
    assert.deepEqual(audit.map((event) => event.status).sort(), ["ok", "requested"]);
    assert.ok(audit.every((event) => event.principalId === "admin-alice" && event.resource === id));
    assert.equal((await h.call("POST", path, { version, operationId: randomUUID() }, "admin-bob")).status, 409);
    const changed = await h.call("POST", "/v1/auth/password/set", {
      principalId: id,
      version: body.operationId,
      nextPassword: "fixture-new-private",
    });
    assert.equal(changed.status, 200);
    assert.equal((await h.call("POST", path, body, "admin-alice")).status, 409);
    assert.equal(
      (await h.call("POST", "/v1/auth/password/session", { principalId: id, version: changed.data.version })).data
        .valid,
      true,
    );
    assert.equal((await h.call("POST", "/v1/auth/password/session", { principalId: id, version })).data.valid, false);
    assert.equal((await h.call("POST", "/v1/auth/password/session", { principalId: "admin-alice" })).data.valid, true);
    assert.equal(
      (await h.call("POST", "/v1/auth/password/session", { principalId: "admin-alice", version })).data.valid,
      false,
    );
    await h.built.identity.deactivate(id);
    assert.equal(
      (await h.call("POST", "/v1/auth/password/session", { principalId: "admin-alice", impersonatedPrincipalId: id }))
        .data.valid,
      false,
    );
    assert.equal(
      (await h.call("POST", "/v1/auth/password/session", { principalId: id, version: changed.data.version })).data
        .valid,
      false,
    );
    assert.equal(
      (await h.call("POST", path, { version: changed.data.version, operationId: randomUUID() }, "admin-alice")).status,
      404,
    );
  } finally {
    await h.close();
  }
});

test("retry repairs a failed terminal audit without repeating the reset", async () => {
  const h = await harness();
  try {
    const before = (await h.passwords.get(id))!;
    const recordOnce = h.built.auditLog.recordOnce!.bind(h.built.auditLog);
    h.built.auditLog.recordOnce = async (key, event) => {
      if (event.status === "ok") throw new Error("fixture terminal audit unavailable");
      return recordOnce(key, event);
    };
    const path = `/v1/admin/users/${id}/password-reset`;
    const body = { version: before.version, operationId: randomUUID() };
    assert.equal((await h.call("POST", path, body, "admin-alice")).status, 500);
    const reset = (await h.passwords.get(id))!;
    assert.equal(reset.version, body.operationId);
    assert.equal(reset.lastReset?.actor, "admin-alice");
    assert.equal((await h.built.auditLog.events()).filter((event) => event.action === "user.password.reset").length, 1);
    h.built.auditLog.recordOnce = recordOnce;
    assert.equal((await h.call("POST", path, body, "admin-alice")).status, 200);
    assert.deepEqual(await h.passwords.get(id), reset);
    assert.deepEqual(
      (await h.built.auditLog.events())
        .filter((event) => event.action === "user.password.reset")
        .map((event) => event.status)
        .sort(),
      ["ok", "requested"],
    );
  } finally {
    await h.close();
  }
});

test("audit persistence failure blocks password mutation", async () => {
  const h = await harness();
  try {
    const before = await h.passwords.get(id);
    h.built.auditLog.recordOnce = async () => {
      throw new Error("fixture audit unavailable");
    };
    const result = await h.call(
      "POST",
      `/v1/admin/users/${id}/password-reset`,
      { version: before!.version, operationId: randomUUID() },
      "admin-alice",
    );
    assert.equal(result.status, 500);
    assert.deepEqual(await h.passwords.get(id), before);
  } finally {
    await h.close();
  }
});

test("session validation rejects a deactivated actor and impersonated target", async () => {
  const h = await harness();
  try {
    const version = (await h.passwords.get(id))!.version!;
    await h.built.identity.deactivate(id);
    assert.equal((await h.call("POST", "/v1/auth/password/session", { principalId: id, version })).data.valid, false);
    assert.equal(
      (await h.call("POST", "/v1/auth/password/session", { principalId: "admin-alice", impersonatedPrincipalId: id }))
        .data.valid,
      false,
    );
  } finally {
    await h.close();
  }
});
