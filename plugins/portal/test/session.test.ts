import test from "node:test";
import assert from "node:assert/strict";
import {
  REMEMBER_TTL_S,
  UNREMEMBERED_TTL_S,
  readTmpCookies,
  deriveKey,
  seal,
  sealSession,
  open,
  openSession,
  openImpersonation,
  openTmp,
  setCookie,
  sessionCookieHeaders,
  clearCookie,
  readCookie,
  safeEqual,
  sanitizeReturnTo,
  type SessionClaims,
  type ImpersonationClaims,
  type TmpClaims,
} from "../src/session.ts";

const secret = "portal-test-secret";
const sessionKey = deriveKey(secret, "portal.session.v1");
const tmpKey = deriveKey(secret, "portal.tmp.v1");
const impersonateKey = deriveKey(secret, "portal.impersonate.v1");

test("seal/open round-trips a payload and rejects tampering", () => {
  const token = seal({ hello: "world", n: 1 }, sessionKey);
  assert.deepEqual(open(token, sessionKey), { hello: "world", n: 1 });

  const [body, sig] = token.split(".");
  const tampered = `${(body ?? "").slice(0, -1)}${(body ?? "").slice(-1) === "A" ? "B" : "A"}.${sig}`;
  assert.equal(open(tampered, sessionKey), null);

  assert.equal(open(token, deriveKey("other-secret", "portal.session.v1")), null);
  assert.equal(open("not-a-token", sessionKey), null);
  assert.equal(open(null, sessionKey), null);
});

test("domain-separated keys make session and tmp tokens non-interchangeable", () => {
  const now = Math.floor(Date.now() / 1000);
  const session: SessionClaims = { k: "session", sub: "U1", org: "acme", iat: now, exp: now + 3600 };
  const sealed = seal(session, sessionKey);
  assert.equal(open(sealed, tmpKey), null);
});

test("openSession enforces kind, sub, and expiry", () => {
  const now = Math.floor(Date.now() / 1000);
  const good = seal(
    { k: "session", sub: "U1", org: "acme", iat: now, exp: now + 60 } satisfies SessionClaims,
    sessionKey,
  );
  assert.equal(openSession(good, sessionKey, Date.now())?.sub, "U1");
  assert.equal(openSession(good, sessionKey, Date.now(), "acme")?.sub, "U1");
  assert.equal(openSession(good, sessionKey, Date.now(), "other-org"), null);

  const expired = seal(
    { k: "session", sub: "U1", org: "acme", iat: now - 120, exp: now - 60 } satisfies SessionClaims,
    sessionKey,
  );
  assert.equal(openSession(expired, sessionKey, Date.now()), null);

  const tmp = seal(
    { k: "tmp", state: "s", nonce: "n", pkceVerifier: "v", returnTo: "/", iat: now, exp: now + 60 } satisfies TmpClaims,
    sessionKey,
  );
  assert.equal(openSession(tmp, sessionKey, Date.now()), null);
});

test("openSession enforces an absolute session lifetime", () => {
  const now = Math.floor(Date.now() / 1000);
  const current = seal(
    {
      k: "session",
      sub: "U1",
      org: "acme",
      auth: now - 300,
      iat: now - 10,
      exp: now + 60,
    } satisfies SessionClaims,
    sessionKey,
  );
  assert.equal(openSession(current, sessionKey, Date.now(), "acme", 600)?.sub, "U1");

  const tooOld = seal(
    {
      k: "session",
      sub: "U1",
      org: "acme",
      auth: now - 601,
      iat: now - 10,
      exp: now + 60,
    } satisfies SessionClaims,
    sessionKey,
  );
  assert.equal(openSession(tooOld, sessionKey, Date.now(), "acme", 600), null);
});

test("openTmp enforces kind and required fields", () => {
  const now = Math.floor(Date.now() / 1000);
  const tmp = seal(
    {
      k: "tmp",
      state: "abc",
      nonce: "xyz",
      pkceVerifier: "v",
      returnTo: "/web-ui/",
      iat: now,
      exp: now + 600,
    } satisfies TmpClaims,
    tmpKey,
  );
  const opened = openTmp(tmp, tmpKey, Date.now());
  assert.equal(opened?.state, "abc");
  assert.equal(opened?.nonce, "xyz");
  const session = seal(
    { k: "session", sub: "U1", org: "acme", iat: now, exp: now + 600 } satisfies SessionClaims,
    tmpKey,
  );
  assert.equal(openTmp(session, tmpKey, Date.now()), null);
});

test("openImpersonation enforces kind, actor, target, and expiry; key is domain-separated", () => {
  const now = Math.floor(Date.now() / 1000);
  const good = seal(
    {
      k: "impersonate",
      actor: "U-admin",
      target: "alice@acme",
      org: "acme",
      iat: now,
      exp: now + 3600,
    } satisfies ImpersonationClaims,
    impersonateKey,
  );
  const opened = openImpersonation(good, impersonateKey, Date.now());
  assert.equal(opened?.actor, "U-admin");
  assert.equal(opened?.target, "alice@acme");

  const expired = seal(
    {
      k: "impersonate",
      actor: "U-admin",
      target: "alice@acme",
      org: "acme",
      iat: now - 7200,
      exp: now - 60,
    } satisfies ImpersonationClaims,
    impersonateKey,
  );
  assert.equal(openImpersonation(expired, impersonateKey, Date.now()), null);

  const session = seal(
    { k: "session", sub: "U-admin", org: "acme", iat: now, exp: now + 3600 } satisfies SessionClaims,
    impersonateKey,
  );
  assert.equal(openImpersonation(session, impersonateKey, Date.now()), null);
  assert.equal(
    openImpersonation(good, sessionKey, Date.now()),
    null,
    "the impersonation key is domain-separated from the session key",
  );

  const noTarget = seal(
    { k: "impersonate", actor: "U-admin", target: "", org: "acme", iat: now, exp: now + 3600 },
    impersonateKey,
  );
  assert.equal(openImpersonation(noTarget, impersonateKey, Date.now()), null);
});

test("cookie helpers set HttpOnly/SameSite/Path and Secure only when asked", () => {
  const secure = setCookie("portal_session", "v v", { path: "/", maxAge: 100, secure: true });
  assert.match(secure, /^portal_session=v%20v; HttpOnly; SameSite=Lax; Path=\/; Secure; Max-Age=100$/);
  const insecure = setCookie("portal_oidc_tmp", "x", { path: "/auth", maxAge: 600, secure: false });
  assert.ok(!insecure.includes("Secure"));
  assert.match(clearCookie("portal_session", "/", true), /Max-Age=0/);
});

test("a cross-site cookie is only emitted when it is also Secure", () => {
  const crossSite = setCookie("portal_session_x", "v", { path: "/", maxAge: 100, secure: true, sameSite: "None" });
  assert.match(crossSite, /SameSite=None/);
  assert.match(crossSite, /Secure/);
  const insecure = setCookie("portal_session_x", "v", { path: "/", maxAge: 100, secure: false, sameSite: "None" });
  assert.match(insecure, /SameSite=Lax/);
  assert.ok(!insecure.includes("Secure"));
});

test("readCookie extracts a named cookie and survives other pairs", () => {
  const header = "a=1; portal_session=abc.def; webuiuser=EVIL";
  assert.equal(readCookie(header, "portal_session"), "abc.def");
  assert.equal(readCookie(header, "missing"), null);
  assert.equal(readCookie(undefined, "portal_session"), null);
});

test("safeEqual is length-aware and value-correct", () => {
  assert.equal(safeEqual("abc", "abc"), true);
  assert.equal(safeEqual("abc", "abd"), false);
  assert.equal(safeEqual("abc", "abcd"), false);
});

test("sanitizeReturnTo with an apps domain admits exactly one-label app subdomains", () => {
  const origin = "https://agent.example.com";
  const apps = "apps.agent.example.com";
  assert.equal(
    sanitizeReturnTo("https://mysite.apps.agent.example.com/consultants?x=1", origin, apps),
    "https://mysite.apps.agent.example.com/consultants?x=1",
  );
  for (const bad of [
    "https://evil.com/?u=.apps.agent.example.com",
    "https://apps.agent.example.com/",
    "https://a.b.apps.agent.example.com/",
    "https://evilapps.agent.example.com/",
    "https://mysite.apps.agent.example.evil.com/",
    "http://mysite.apps.agent.example.com/",
    "https://user:pw@mysite.apps.agent.example.com/",
  ]) {
    assert.equal(sanitizeReturnTo(bad, origin, apps), "/", `expected "/" for ${bad}`);
  }
  assert.equal(
    sanitizeReturnTo("https://mysite.apps.agent.example.com/x", origin),
    "/",
    "no apps domain configured ⇒ same-origin only",
  );
  assert.equal(sanitizeReturnTo("/web-ui/?x=1", origin, apps), "/web-ui/?x=1", "portal-relative paths still pass");
});

test("setCookie/clearCookie carry a Domain attribute only when asked", () => {
  assert.match(
    setCookie("portal_session", "v", { secure: true, domain: "agent.example.com" }),
    /; Domain=agent\.example\.com;/,
  );
  assert.doesNotMatch(setCookie("portal_session", "v", { secure: true }), /Domain=/);
  assert.match(clearCookie("portal_session", "/", true, "agent.example.com"), /; Domain=agent\.example\.com;/);
  assert.doesNotMatch(clearCookie("portal_session", "/", true), /Domain=/);
});

test("sanitizeReturnTo accepts same-origin paths and rejects redirect escapes", () => {
  const origin = "https://agent.example.com";
  assert.equal(sanitizeReturnTo("/web-ui/?x=1", origin), "/web-ui/?x=1");
  assert.equal(sanitizeReturnTo("/", origin), "/");
  for (const bad of [
    "//evil.com",
    "/\\evil.com",
    "\\\\evil.com",
    "https://evil.com",
    "https:/evil.com",
    "/%2f%2fevil.com",
    "/%5cevil",
    "/	//evil",
    "",
    "x/y",
    null,
  ]) {
    assert.equal(sanitizeReturnTo(bad, origin), "/", `expected "/" for ${JSON.stringify(bad)}`);
  }
});

test("login preserves opaque callback query values while rejecting normalized redirect escapes", () => {
  const callback =
    "/api/composio/callback?session_uri=" + encodeURIComponent("https://backend.composio.dev/session/opaque");
  assert.equal(sanitizeReturnTo(callback, "https://qm.example"), callback);
  assert.equal(sanitizeReturnTo("/path/..//evil.example", "https://qm.example"), "/");
  assert.equal(sanitizeReturnTo("/%2f%2fevil.example?session_uri=ok", "https://qm.example"), "/");
});

for (const domain of [undefined, "example.test"]) {
  test(`login and renewal always issue the framed session twin (${domain ?? "host-only"})`, () => {
    const attrs = { path: "/", maxAge: 100, secure: true, domain };
    const headers = sessionCookieHeaders("signed-session", attrs);
    assert.ok(headers.some((header) => header.startsWith("portal_session=signed-session;")));
    const twins = headers.filter((header) => header.startsWith("portal_session_x=signed-session;"));
    assert.equal(twins.length, 1);
    assert.match(twins[0]!, /SameSite=None/);
    assert.match(twins[0]!, /Secure/);
    if (domain) {
      assert.match(twins[0]!, new RegExp(`Domain=${domain}`));
      assert.ok(headers.some((header) => header.startsWith("portal_session_x=;") && !header.includes("Domain=")));
    } else {
      assert.ok(!headers.some((header) => header.startsWith("portal_session_x=;")));
    }
  });
}

test("the framed session twin falls back to Lax on a non-https origin", () => {
  const twin = sessionCookieHeaders("signed-session", { path: "/", maxAge: 100, secure: false }).find((header) =>
    header.startsWith("portal_session_x="),
  );
  assert.match(twin ?? "", /SameSite=Lax/);
  assert.doesNotMatch(twin ?? "", /Secure/);
});

test("openSession preserves signed app-only authority and rejects malformed markers", () => {
  const now = Math.floor(Date.now() / 1000);
  const claims = { k: "session", sub: "guest@partner.test", org: "acme", iat: now, exp: now + 3600 };
  assert.equal(openSession(seal({ ...claims, appOnly: true }, sessionKey), sessionKey, Date.now())?.appOnly, true);
  assert.equal(openSession(seal(claims, sessionKey), sessionKey, Date.now())?.appOnly, undefined);
  for (const appOnly of ["true", "false", 1, 0, null, {}]) {
    assert.equal(openSession(seal({ ...claims, appOnly }, sessionKey), sessionKey, Date.now()), null);
  }
});

test("remembered session lifetime is fixed at authentication and cannot be extended by renewal", () => {
  const now = Math.floor(Date.now() / 1000);
  const claims: SessionClaims = {
    k: "session",
    sub: "member",
    org: "test",
    auth: now,
    iat: now,
    exp: now + REMEMBER_TTL_S,
    remember: true,
    sid: "a".repeat(64),
    passwordVersion: "version",
  };
  const token = sealSession(claims, sessionKey);
  assert.equal(open(token, sessionKey)!.v, 2);
  assert.equal(
    open(token, sessionKey)!.iat,
    undefined,
    "older portal versions must reject remembered cookies after rollback",
  );
  assert.equal(openSession(token, sessionKey, (now + 86400 * 29) * 1000, "test", 86400)?.sub, "member");
  assert.equal(openSession(token, sessionKey, (now + REMEMBER_TTL_S) * 1000, "test", 86400), null);
  assert.equal(
    openSession(
      sealSession({ ...claims, iat: now + 86400, exp: now + REMEMBER_TTL_S + 86400 }, sessionKey),
      sessionKey,
      (now + 86400) * 1000,
      "test",
      86400,
    ),
    null,
  );
  for (const patch of [
    { sid: undefined },
    { sid: "guess" },
    { passwordVersion: undefined },
    { auth: undefined },
    { anon: true },
  ])
    assert.equal(
      openSession(
        sealSession({ ...claims, ...patch } as SessionClaims, sessionKey),
        sessionKey,
        now * 1000,
        "test",
        86400,
      ),
      null,
    );
  assert.equal(openSession(seal({ ...claims, remember: undefined }, sessionKey), sessionKey, now * 1000), null);
  assert.doesNotMatch(setCookie("portal_session", token, { secure: true }), /Max-Age|Expires/);
  const persistent = setCookie("portal_session", token, {
    secure: true,
    maxAge: REMEMBER_TTL_S,
    expires: new Date(claims.exp * 1000),
  });
  assert.match(persistent, /HttpOnly; SameSite=Lax; Path=\/; Secure; Max-Age=2592000; Expires=/);
});

test("a password session without the remember choice lasts a day at most, whatever the configured maximum", () => {
  const now = Math.floor(Date.now() / 1000);
  const claims: SessionClaims = {
    k: "session",
    sub: "member",
    org: "test",
    auth: now,
    iat: now,
    exp: now + UNREMEMBERED_TTL_S,
    passwordVersion: "version",
  };
  const month = 30 * 86400;
  const token = seal(claims, sessionKey);
  assert.equal(openSession(token, sessionKey, (now + UNREMEMBERED_TTL_S - 1) * 1000, "test", month)?.sub, "member");
  assert.equal(openSession(token, sessionKey, (now + UNREMEMBERED_TTL_S - 1) * 1000, "test")?.sub, "member");
  assert.equal(openSession(token, sessionKey, (now + UNREMEMBERED_TTL_S) * 1000, "test", month), null);
  const stretched = seal({ ...claims, exp: now + UNREMEMBERED_TTL_S + 1 }, sessionKey);
  assert.equal(openSession(stretched, sessionKey, now * 1000, "test", month), null);
  assert.equal(openSession(stretched, sessionKey, now * 1000, "test"), null);
  assert.equal(openSession(token, sessionKey, (now + 3600) * 1000, "test", 1800), null);
  const ordinary = seal({ ...claims, passwordVersion: undefined, exp: now + month }, sessionKey);
  assert.equal(openSession(ordinary, sessionKey, (now + 86400 * 2) * 1000, "test", month)?.sub, "member");
});

test("pending sign-in cookies are read per state, and a cookie under another state's name is ignored", () => {
  const now = Math.floor(Date.now() / 1000);
  const state = "a".repeat(64);
  const other = "b".repeat(64);
  const tmp: TmpClaims = { k: "tmp", state, nonce: "n", pkceVerifier: "v", returnTo: "/", iat: now, exp: now + 600 };
  const value = seal(tmp, tmpKey);
  const read = (header: string) => readTmpCookies(header, tmpKey, now * 1000);
  assert.deepEqual(read(`portal_oidc_tmp_${state}=${value}`), [{ name: `portal_oidc_tmp_${state}`, claims: tmp }]);
  assert.deepEqual(read(`portal_oidc_tmp=${value}`), [{ name: "portal_oidc_tmp", claims: tmp }]);
  assert.deepEqual(read(`portal_oidc_tmp_${other}=${value}`), [{ name: `portal_oidc_tmp_${other}`, claims: null }]);
  assert.deepEqual(read(`portal_oidc_tmp_short=${value}; unrelated=1`), []);
  assert.deepEqual(readTmpCookies(`portal_oidc_tmp_${state}=${value}`, tmpKey, (now + 601) * 1000), [
    { name: `portal_oidc_tmp_${state}`, claims: null },
  ]);
});
