import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { createHash, generateKeyPairSync, randomUUID } from "node:crypto";
import { exportJWK, SignJWT } from "jose";
import { deriveKey, seal, open } from "../src/session.ts";

const secret = "login-resume-test-secret";
const issuer = "https://identity.example.test";
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = { ...(await exportJWK(publicKey)), kid: "test-key", alg: "RS256", use: "sig" };
const codes = new Map<string, { nonce: string; challenge: string }>();
let exchanges = 0;
let authorizeViews = 0;
const identity = createServer((req, res) => {
  void (async () => {
    const url = new URL(req.url ?? "/", "http://identity.test");
    if (url.pathname === "/v1/auth/password/session") return void res.end(JSON.stringify({ valid: true }));
    if (url.pathname === "/v1/auth/broker/email-allowed") return void res.end(JSON.stringify({ allowed: true }));
    if (url.pathname === "/jwks") return void res.end(JSON.stringify({ keys: [jwk] }));
    if (url.pathname === "/authorize") {
      authorizeViews++;
      return void res.end("<form>Sign in</form>");
    }
    if (url.pathname === "/userinfo")
      return void res.end(
        JSON.stringify({ sub: "member-one", email: "member-one@example.test", email_verified: true }),
      );
    if (url.pathname === "/token") {
      exchanges++;
      let body = "";
      for await (const chunk of req) body += chunk;
      const form = new URLSearchParams(body);
      const pending = codes.get(form.get("code") ?? "");
      if (
        !pending ||
        createHash("sha256")
          .update(form.get("code_verifier") ?? "")
          .digest("base64url") !== pending.challenge
      ) {
        res.writeHead(400);
        return void res.end(JSON.stringify({ error: "invalid_grant" }));
      }
      codes.delete(form.get("code")!);
      const token = await new SignJWT({ nonce: pending.nonce })
        .setProtectedHeader({ alg: "RS256", kid: "test-key" })
        .setIssuer(issuer)
        .setAudience("portal-client")
        .setSubject("member-one")
        .setIssuedAt()
        .setExpirationTime("2m")
        .sign(privateKey);
      return void res.end(JSON.stringify({ access_token: "synthetic-access", id_token: token }));
    }
    res.end("{}");
  })().catch(() => {
    res.writeHead(500);
    res.end();
  });
});
await new Promise<void>((resolve) => identity.listen(0, "127.0.0.1", resolve));
const idp = `http://127.0.0.1:${(identity.address() as AddressInfo).port}`;
Object.assign(process.env, {
  PORTAL_PUBLIC_URL: "http://portal.example.test",
  PORTAL_SESSION_SECRET: secret,
  CORE_SIGNING_SECRET: "synthetic-core-secret",
  CORE_ORG_ID: "acme",
  CORE_API_URL: idp,
  WEB_UI_UPSTREAM: idp,
  ADMIN_UPSTREAM: idp,
  AUTH_BROKER_UPSTREAM: idp,
  OIDC_AUTH_ENDPOINT: "http://portal.example.test/idp/authorize",
  OIDC_TOKEN_ENDPOINT: `${idp}/token`,
  OIDC_USERINFO_ENDPOINT: `${idp}/userinfo`,
  OIDC_JWKS_URI: `${idp}/jwks`,
  OIDC_ISSUER: issuer,
  OIDC_PRINCIPAL_CLAIM: "sub",
  OIDC_CLIENT_ID: "portal-client",
  OIDC_CLIENT_SECRET: "synthetic-client-secret",
});
const { server } = await import("../src/index.ts");
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
const sessionKey = deriveKey(secret, "portal.session.v1");
const tmpKey = deriveKey(secret, "portal.tmp.v1");
const get = (path: string, cookie = "") => fetch(base + path, { redirect: "manual", headers: { cookie } });
function session(expired = false) {
  const now = Math.floor(Date.now() / 1000);
  return `portal_session=${seal({ k: "session", sub: "member-one", org: "acme", iat: now - 60, exp: now + (expired ? -1 : 3600) }, sessionKey)}`;
}
async function begin() {
  const response = await get("/auth/login?returnTo=/files");
  const url = new URL(response.headers.get("location")!);
  const cookie = response.headers
    .getSetCookie()
    .filter((s) => !s.includes("Max-Age=0"))
    .map((s) => s.split(";")[0])
    .join("; ");
  const code = randomUUID();
  codes.set(code, { nonce: url.searchParams.get("nonce")!, challenge: url.searchParams.get("code_challenge")! });
  return { url, cookie, state: url.searchParams.get("state")!, code };
}
test.after(() => {
  server.close();
  identity.close();
});

test("restored login entry reuses an existing session", async () => {
  const response = await get("/auth/login?returnTo=/files", session());
  assert.equal(response.status, 302);
  assert.equal(response.headers.get("location"), "/files");
  assert.equal(response.headers.get("set-cookie"), null);
});

test("restored callback with an active session returns to the app without exchanging old code", async () => {
  const before = exchanges;
  const response = await get("/auth/callback?code=used&state=old", session());
  assert.equal(response.status, 302);
  assert.equal(response.headers.get("location"), "/");
  assert.equal(exchanges, before);
});

test("expired or absent browser session restarts an expired callback without accepting its code", async () => {
  for (const cookie of ["", session(true)]) {
    const before = exchanges;
    const response = await get("/auth/callback?code=expired&state=old", cookie);
    assert.equal(response.status, 302);
    assert.equal(response.headers.get("location"), "/auth/login");
    assert.equal(exchanges, before);
    assert.doesNotMatch(response.headers.get("set-cookie") ?? "", /portal_session=/);
  }
});

test("restored broker pages cannot issue a fresh form for a lost browser transaction", async () => {
  const before = authorizeViews;
  const response = await get("/idp/authorize?state=stale&client_id=portal-client");
  assert.equal(response.status, 302);
  assert.equal(response.headers.get("location"), "/auth/login");
  assert.equal(authorizeViews, before);
  const active = await get("/idp/authorize?state=stale", session());
  assert.equal(active.headers.get("location"), "/");
});

test("two pending tabs keep distinct transactions and can complete concurrently", async () => {
  const a = await begin();
  const b = await begin();
  assert.notEqual(a.cookie.split("=")[0], b.cookie.split("=")[0]);
  const cookies = `${a.cookie}; ${b.cookie}`;
  const responses = await Promise.all(
    [a, b].map((flow) => get(`/auth/callback?code=${flow.code}&state=${flow.state}`, cookies)),
  );
  for (let i = 0; i < responses.length; i++) {
    const response = responses[i]!;
    assert.equal(response.status, 302, await response.text());
    assert.equal(response.headers.get("location"), "/files");
    const values = response.headers.getSetCookie();
    assert.ok(values.some((value) => value.startsWith("portal_session=")));
    assert.ok(
      values.some((value) => value.startsWith([a, b][i]!.cookie.split("=")[0] + "=") && value.includes("Max-Age=0")),
    );
    assert.ok(!values.some((value) => value.startsWith([b, a][i]!.cookie.split("=")[0] + "=")));
  }
});

test("a stale tab does not clear another tab's pending login", async () => {
  const pending = await begin();
  const response = await get("/auth/callback?code=old&state=old", pending.cookie);
  assert.equal(response.status, 302);
  assert.ok(!response.headers.getSetCookie().some((value) => value.startsWith(pending.cookie.split("=")[0] + "=")));
  const completed = await get(`/auth/callback?code=${pending.code}&state=${pending.state}`, pending.cookie);
  assert.equal(completed.status, 302);
  assert.equal(completed.headers.get("location"), "/files");
});

test("matching broker navigation accepts the transaction cookie, while expired and tampered cookies do not", async () => {
  const pending = await begin();
  const path = pending.url.pathname + pending.url.search;
  const valid = await get(path, pending.cookie);
  assert.equal(valid.status, 200);
  const equal = pending.cookie.indexOf("=");
  const name = pending.cookie.slice(0, equal);
  const claims = open(decodeURIComponent(pending.cookie.slice(equal + 1)), tmpKey)!;
  for (const value of [seal({ ...claims, exp: 1 }, tmpKey), "invalid-signature"]) {
    const before = authorizeViews;
    const response = await get(path, `${name}=${value}`);
    assert.equal(response.headers.get("location"), "/auth/login");
    assert.equal(authorizeViews, before);
  }
});

test("legacy in-flight login remains usable during rollout", async () => {
  const pending = await begin();
  const value = pending.cookie.slice(pending.cookie.indexOf("=") + 1);
  const response = await get(`/auth/callback?code=${pending.code}&state=${pending.state}`, `portal_oidc_tmp=${value}`);
  assert.equal(response.status, 302);
  assert.equal(response.headers.get("location"), "/files");
});

test("login return targets do not loop back into authentication", async () => {
  for (const destination of ["/auth/login", "/auth/callback?code=old", "/idp/authorize?state=old", "//evil.test"]) {
    const response = await get(`/auth/login?returnTo=${encodeURIComponent(destination)}`, session());
    assert.equal(response.headers.get("location"), "/");
  }
});

test("anonymous sessions can upgrade through the full sign-in flow", async () => {
  const now = Math.floor(Date.now() / 1000);
  const anonymous = `portal_session=${seal({ k: "session", sub: "anon-example", anon: true, org: "acme", iat: now, exp: now + 600 }, sessionKey)}`;
  const login = await get("/auth/login", anonymous);
  assert.equal(login.status, 302);
  assert.match(login.headers.get("location") ?? "", /\/idp\/authorize/);
  const pending = await begin();
  const page = await get(pending.url.pathname + pending.url.search, `${anonymous}; ${pending.cookie}`);
  assert.equal(page.status, 200);
  const completed = await get(
    `/auth/callback?code=${pending.code}&state=${pending.state}`,
    `${anonymous}; ${pending.cookie}`,
  );
  assert.equal(completed.status, 302);
  assert.ok(completed.headers.getSetCookie().some((cookie) => cookie.startsWith("portal_session=")));
});

test("new transactions cover both broker and callback paths and clear with the same path", async () => {
  const response = await get("/auth/login");
  const value = response.headers.getSetCookie().find((cookie) => !cookie.includes("Max-Age=0"))!;
  assert.match(value, /; Path=\/(?:;|$)/);
  const pending = await begin();
  const completed = await get(`/auth/callback?code=${pending.code}&state=${pending.state}`, pending.cookie);
  const cleared = completed.headers
    .getSetCookie()
    .find((cookie) => cookie.startsWith(pending.cookie.split("=")[0] + "="))!;
  assert.match(cleared, /; Path=\/(?:;|$)/);
  assert.match(cleared, /Max-Age=0/);
});

test("stale error callbacks restart without clearing another pending login", async () => {
  const pending = await begin();
  const response = await get("/auth/callback?error=access_denied&state=expired", pending.cookie);
  assert.equal(response.status, 302);
  assert.equal(response.headers.get("location"), "/auth/login");
  assert.equal(response.headers.getSetCookie().length, 0);
});

test("stale form POSTs cannot reach the broker or consume credentials", async () => {
  const pending = await begin();
  const before = authorizeViews;
  const response = await fetch(base + "/idp/authorize?state=expired", {
    method: "POST",
    redirect: "manual",
    headers: { cookie: pending.cookie, origin: "http://portal.example.test" },
    body: "request=expired&password=synthetic",
  });
  assert.equal(response.status, 303);
  assert.equal(response.headers.get("location"), "/auth/login");
  assert.equal(authorizeViews, before);
});

test("the newest three existing transactions survive same-second retention", async () => {
  const jar = new Map<string, string>();
  const states: string[] = [];
  for (let i = 0; i < 5; i++) {
    const response = await get("/auth/login", [...jar.values()].join("; "));
    states.push(new URL(response.headers.get("location")!).searchParams.get("state")!);
    for (const cookie of response.headers.getSetCookie()) {
      const pair = cookie.split(";")[0]!;
      const name = pair.slice(0, pair.indexOf("="));
      if (cookie.includes("Max-Age=0")) jar.delete(name);
      else jar.set(name, pair);
    }
  }
  assert.equal(jar.size, 4);
  assert.ok(!jar.has(`portal_oidc_tmp_${states[0]}`));
  for (const state of states.slice(1)) assert.ok(jar.has(`portal_oidc_tmp_${state}`));
});
