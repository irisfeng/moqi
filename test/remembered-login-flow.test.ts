import "./support/auto-fake-sprites.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import { buildApp } from "../src/wiring.ts";
import { createServer } from "../src/api/server.ts";
import { signedHeaders, withSourceAuthNonce } from "../plugins/chassis/src/core-client.ts";
import { testConfig } from "./support/test-config.ts";
import { deriveKey, open, openSession, sealSession } from "../plugins/portal/src/session.ts";

const origin = "http://portal.example.test";
const sourceSecret = "remembered-login-source-fixture".repeat(2);
const portalSecret = "remembered-login-portal-fixture";
const built = buildApp(testConfig());
const passwords = built.loginPasswords;
const id = "admin@example.com";
await built.app.upsertDirectory([{ principalId: id, displayName: "Fixture", type: "internal" }]);
await passwords.putInitial({ id, initialPassword: "fixture-initial", updatedBy: "fixture" });
await passwords.setNew(id, "fixture-private", "fixture-initial");
const core = createServer(built.app, {
  config: built.config,
  identity: built.identity,
  loginPasswords: passwords,
  emailAuthPrincipals: [id],
  signingSecret: sourceSecret,
  requireSignedPortalIdentity: true,
  capabilitySecret: "remembered-login-capability-fixture-distinct",
  portalIdentitySecret: portalSecret,
});
await new Promise<void>((resolve) => core.listen(0, "127.0.0.1", resolve));
const coreBase = `http://127.0.0.1:${(core.address() as AddressInfo).port}`;
Object.assign(process.env, { CORE_API_URL: coreBase, CORE_SIGNING_SECRET: sourceSecret, CORE_ORG_ID: "fixture" });
const { startHarness, hiddenRequestToken, CLIENT_ID, CLIENT_SECRET } = await import("../plugins/auth/test/helpers.ts");
const broker = await startHarness({
  env: {
    AUTH_LOGIN_MODE: "password",
    AUTH_REDIRECT_URI: `${origin}/auth/callback`,
    CORE_API_URL: coreBase,
    CORE_SIGNING_SECRET: sourceSecret,
  },
});
Object.assign(process.env, {
  PORTAL_PUBLIC_URL: origin,
  PORTAL_SESSION_SECRET: portalSecret,
  CORE_SIGNING_SECRET: sourceSecret,
  CORE_ORG_ID: "fixture",
  CORE_API_URL: coreBase,
  AUTH_BROKER_UPSTREAM: broker.base,
  OIDC_AUTH_ENDPOINT: `${origin}/idp/authorize`,
  OIDC_TOKEN_ENDPOINT: `${broker.base}/token`,
  OIDC_USERINFO_ENDPOINT: `${broker.base}/userinfo`,
  OIDC_JWKS_URI: `${broker.base}/.well-known/jwks.json`,
  OIDC_ISSUER: broker.cfg.issuer,
  OIDC_PRINCIPAL_CLAIM: "email",
  OIDC_ALLOWED_EMAILS: id,
  OIDC_CLIENT_ID: CLIENT_ID,
  OIDC_CLIENT_SECRET: CLIENT_SECRET,
});
const { server } = await import("../plugins/portal/src/index.ts");
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
const key = deriveKey(portalSecret, "portal.session.v1");
const originalFetch = globalThis.fetch;
let droppedRegistrationResponses = 0;
globalThis.fetch = async (...args) => {
  const response = await originalFetch(...args);
  if (
    droppedRegistrationResponses === 0 &&
    String(args[0]).includes("/v1/auth/password/devices") &&
    args[1]?.body?.toString().includes('"action":"remember"') &&
    response.ok
  ) {
    await response.text();
    droppedRegistrationResponses++;
    throw new Error("fixture lost committed registration response");
  }
  return response;
};
const get = (path: string, cookie = "") =>
  fetch(base + path, { headers: { cookie, accept: "text/html" }, redirect: "manual" });
const post = (path: string, cookie: string, body: Record<string, string>, requestOrigin = origin) =>
  fetch(base + path, {
    method: "POST",
    headers: { cookie, origin: requestOrigin, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body),
    redirect: "manual",
  });
async function passwordRequest(path: string, data: Record<string, unknown>) {
  const body = JSON.stringify({ principalId: id, ...data });
  const target = withSourceAuthNonce(path, sourceSecret);
  return fetch(coreBase + target, {
    method: "POST",
    headers: signedHeaders(sourceSecret, "POST", target, body),
    body,
  });
}
let failedFormChecks = 0;
async function login(remember: boolean) {
  const start = await get("/auth/login?returnTo=/auth/devices");
  const transaction = start.headers
    .getSetCookie()
    .filter((cookie) => !cookie.includes("Max-Age=0"))
    .map((cookie) => cookie.split(";")[0])
    .join("; ");
  const authorize = new URL(start.headers.get("location")!);
  const form = await get(authorize.pathname + authorize.search, transaction);
  const html = await form.text();
  assert.match(html, /autocomplete="username"/);
  assert.match(html, /name="remember" type="checkbox" value="1">/);
  const request = hiddenRequestToken(html);
  if (failedFormChecks < 2) {
    const bad = await post(authorize.pathname + authorize.search, transaction, {
      request,
      email: id,
      password: "wrong",
      ...(remember ? { remember: "1" } : {}),
    });
    assert.equal(bad.status, 401);
    const retry = await bad.text();
    if (remember) assert.match(retry, /name="remember" type="checkbox" value="1" checked/);
    failedFormChecks++;
  }
  const grant = await post(authorize.pathname + authorize.search, transaction, {
    request,
    email: id,
    password: "fixture-private",
    ...(remember ? { remember: "1" } : {}),
  });
  assert.equal(grant.status, 302, await grant.text());
  const callback = new URL(grant.headers.get("location")!);
  callback.searchParams.set("remember", "1");
  const result = await get(callback.pathname + callback.search, transaction);
  const body = await result.text();
  assert.equal(result.status, 302, body);
  const header = result.headers
    .getSetCookie()
    .find((cookie) => cookie.startsWith("portal_session=") && !cookie.includes("Max-Age=0"))!;
  assert.ok(header);
  const cookie = header.split(";")[0]!;
  const claims = openSession(
    decodeURIComponent(cookie.slice("portal_session=".length)),
    key,
    Date.now(),
    "fixture",
    86400,
  )!;
  assert.ok(claims);
  if (remember) assert.equal(open(decodeURIComponent(cookie.slice("portal_session=".length)), key)!.iat, undefined);
  return { header, cookie, claims };
}
test.after(async () => {
  globalThis.fetch = originalFetch;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await broker.close();
  await new Promise<void>((resolve) => core.close(() => resolve()));
});

test("real password broker and core register before issuing a fixed long-lived cookie and revoke through every portal gate", async () => {
  const ordinary = await login(false);
  assert.doesNotMatch(ordinary.header, /Max-Age|Expires/);
  assert.equal(ordinary.claims.remember, undefined);
  assert.equal(ordinary.claims.sid, undefined);
  const first = await login(true);
  assert.equal(droppedRegistrationResponses, 1);
  assert.match(first.header, /Max-Age=259[12]\d{3}/);
  assert.match(first.header, /Expires=/);
  assert.equal(first.claims.remember, true);
  assert.equal(first.claims.exp - first.claims.auth!, 30 * 86400);
  assert.equal((await passwords.get(id))!.devices!.length, 1);
  assert.ok(!JSON.stringify(await passwords.get(id)).includes(first.claims.sid!));
  const check = await get("/auth/session-check", first.cookie);
  assert.equal(check.status, 204);
  const aged = {
    ...first.claims,
    iat: first.claims.iat - 20000,
    auth: first.claims.auth! - 20000,
    exp: first.claims.exp - 20000,
  };
  const agedResponse = await get("/auth/devices", `portal_session=${sealSession(aged, key)}`);
  assert.equal(agedResponse.status, 200);
  assert.doesNotMatch(agedResponse.headers.get("set-cookie") ?? "", /portal_session=/);
  await agedResponse.text();
  const page = await get("/auth/devices", ordinary.cookie);
  assert.equal(page.status, 200);
  assert.equal(page.headers.get("cache-control"), "no-store");
  assert.match(await page.text(), /Sign out that device/);
  const deviceId = (await passwords.get(id))!.devices![0]!.id;
  assert.equal((await post("/auth/devices", ordinary.cookie, { deviceId }, "http://evil.example.test")).status, 403);
  assert.equal((await get("/auth/session-check", first.cookie)).status, 204);
  const revoked = await post("/auth/devices", ordinary.cookie, { deviceId });
  assert.equal(revoked.status, 303);
  assert.equal((await get("/auth/session-check", first.cookie)).status, 401);
  const second = await login(true);
  const logout = await post("/auth/logout", second.cookie, {});
  assert.equal(logout.status, 200);
  assert.match(logout.headers.get("set-cookie") ?? "", /portal_session=;.*Max-Age=0/);
  assert.equal((await get("/auth/session-check", second.cookie)).status, 401);
  assert.equal((await post("/auth/logout", second.cookie, {})).status, 200);
  for (const source of ["manual", "directory-sync"] as const) {
    const short = await login(false);
    const remembered = await login(true);
    if (source === "manual") await built.identity.deactivate(id.toUpperCase());
    else await built.identity.recordDirectorySync([id], []);
    assert.equal((await get("/auth/session-check", remembered.cookie)).status, 401);
    assert.deepEqual((await passwords.get(id))!.devices, []);
    const disabledRecord = (await passwords.get(id))!;
    const deniedLogin = await passwordRequest("/v1/auth/password/verify", { password: "fixture-private" });
    assert.equal(deniedLogin.status, 200);
    assert.deepEqual(await deniedLogin.json(), { status: "invalid" });
    const deniedChange = await passwordRequest("/v1/auth/password/set", {
      currentPassword: "fixture-private",
      nextPassword: "fixture-replacement",
      version: disabledRecord.version,
    });
    assert.equal(deniedChange.status, 403);
    assert.deepEqual(await deniedChange.json(), { error: "invalid_session" });
    assert.deepEqual(await passwords.get(id), disabledRecord);
    if (source === "manual") await built.identity.reactivate(id);
    else await built.identity.recordDirectorySync([], [id]);
    assert.equal(built.identity.classify(id).type, "internal");
    assert.equal((await get("/auth/session-check", remembered.cookie)).status, 401);
    assert.equal((await get("/auth/session-check", short.cookie)).status, 401);
    const renewed = await login(true);
    assert.equal((await get("/auth/session-check", renewed.cookie)).status, 204);
  }
  const third = await login(true);
  const version = (await passwords.get(id))!.version!;
  await passwords.resetInitial(id, "admin", version, randomUUID());
  assert.deepEqual((await passwords.get(id))!.devices, []);
  assert.equal((await get("/auth/session-check", third.cookie)).status, 401);
  assert.equal((await get("/auth/session-check", ordinary.cookie)).status, 401);
});
