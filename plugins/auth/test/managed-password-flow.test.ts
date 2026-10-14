import test from "node:test";
import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { decodeJwt } from "jose";
import {
  authorizeQuery,
  basicAuth,
  CLIENT_ID,
  CLIENT_SECRET,
  hiddenRequestToken,
  pkcePair,
  REDIRECT_URI,
  startHarness,
  type Harness,
} from "./helpers.ts";

const form = (entries: Record<string, string>, headers: Record<string, string> = {}): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
  body: new URLSearchParams(entries).toString(),
  redirect: "manual",
});

interface Account {
  password: string;
  initial: string;
  version: string;
  forceChange: boolean;
  locked?: boolean;
}

async function startCore(accounts: Record<string, Account>) {
  const calls: string[] = [];
  let failing = false;
  let revision = 0;
  const server = createServer((req, res) => {
    void (async () => {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw) as Record<string, string>;
      const path = new URL(req.url ?? "/", "http://core.local").pathname;
      calls.push(path);
      const reply = (status: number, data: unknown): void => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(data));
      };
      if (failing) return reply(500, { error: "unavailable" });
      const account = accounts[body.principalId ?? ""];
      if (path === "/v1/auth/password/verify") {
        if (account?.locked) return reply(200, { status: "locked", retryInMs: 9 * 60_000 + 1 });
        if (!account || account.password !== body.password) return reply(200, { status: "invalid" });
        return reply(200, { status: "ok", forceChange: account.forceChange, version: account.version });
      }
      if (path === "/v1/auth/password/set") {
        if (!account || account.version !== body.version) return reply(403, { error: "wrong_current" });
        if (body.nextPassword === account.initial) return reply(400, { error: "same_as_initial" });
        revision += 1;
        account.password = body.nextPassword!;
        account.version = `changed-${revision}`;
        account.forceChange = false;
        return reply(200, { ok: true, version: account.version });
      }
      return reply(404, {});
    })().catch(() => {
      res.writeHead(500);
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    calls,
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    fail(value: boolean) {
      failing = value;
    },
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

const settled = (): Account => ({
  password: "a private password",
  initial: "initial-password",
  version: "v1",
  forceChange: false,
});

async function managed(accounts: Record<string, Account>, t: { after(fn: () => Promise<void>): void }) {
  const core = await startCore(accounts);
  const h = await startHarness({ env: { AUTH_LOGIN_MODE: "password", CORE_API_URL: core.url } });
  t.after(async () => {
    await h.close();
    await core.close();
  });
  return { core, h };
}

async function signInPage(h: Harness, challenge = pkcePair().challenge) {
  const query = authorizeQuery({ code_challenge: challenge });
  const response = await fetch(`${h.base}/authorize?${query}`);
  assert.equal(response.status, 200);
  const html = await response.text();
  return { response, html, request: hiddenRequestToken(html), state: query.get("state")! };
}

async function submit(h: Harness, fields: Record<string, string>, challenge?: string): Promise<Response> {
  const { request } = await signInPage(h, challenge);
  return fetch(`${h.base}/authorize`, form({ request, method: "password", ...fields }));
}

async function idTokenFor(h: Harness, location: string, verifier: string): Promise<Record<string, unknown>> {
  const code = new URL(location).searchParams.get("code")!;
  const response = await fetch(`${h.base}/token`, {
    ...form({ grant_type: "authorization_code", code, redirect_uri: REDIRECT_URI, code_verifier: verifier }),
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      authorization: basicAuth(CLIENT_ID, CLIENT_SECRET),
    },
  });
  assert.equal(response.status, 200);
  return decodeJwt(((await response.json()) as { id_token: string }).id_token);
}

test("the managed sign-in page offers the password form, a remember choice and recovery, and no email link", async (t) => {
  const { h } = await managed({}, t);
  const { html } = await signInPage(h);
  assert.match(html, /type="password"/);
  assert.match(html, /<input name="remember" type="checkbox" value="1">/);
  assert.match(html, /<a href="\/idp\/forgot">Forgot your password\?<\/a>/);
  assert.doesNotMatch(html, /Email me a sign-in link|meant for getting started/);
});

test("a correct password signs in without a broker cookie and carries the credential version and remember choice", async (t) => {
  const { h, core } = await managed({ "admin@example.com": settled() }, t);
  for (const remember of [true, false]) {
    const { verifier, challenge } = pkcePair();
    const response = await submit(
      h,
      { email: "Admin@Example.com", password: "a private password", ...(remember ? { remember: "1" } : {}) },
      challenge,
    );
    assert.equal(response.status, 302);
    assert.equal(response.headers.get("set-cookie"), null);
    const claims = await idTokenFor(h, response.headers.get("location")!, verifier);
    assert.equal(claims.email, "admin@example.com");
    assert.equal(claims.password_version, "v1");
    assert.equal(claims.remember_login, remember);
    assert.equal(claims.auth_time, Math.floor(h.now.ms / 1000));
  }
  assert.equal(h.remembered.size, 0);
  assert.deepEqual(
    h.claims.calls.filter((ids) => ids[0]!.startsWith("rate:")),
    [],
  );
  assert.deepEqual(core.calls, ["/v1/auth/password/verify", "/v1/auth/password/verify"]);
});

test("a wrong password, an unknown account and an unlisted email fail the same way and keep the remember choice", async (t) => {
  const { h, core } = await managed({ "admin@example.com": settled(), "outsider@elsewhere.test": settled() }, t);
  const pages: string[] = [];
  for (const fields of [
    { email: "admin@example.com", password: "wrong" },
    { email: "ops@example.com", password: "a private password" },
    { email: "outsider@elsewhere.test", password: "a private password" },
  ]) {
    const response = await submit(h, { ...fields, remember: "1" });
    assert.equal(response.status, 401);
    const html = await response.text();
    assert.match(html, /That email address or password is incorrect\./);
    assert.match(html, /<input name="remember" type="checkbox" value="1" checked>/);
    assert.doesNotMatch(html, /wrong|a private password/);
    pages.push(html.replace(/name="request" value="[^"]+"/, "").replace(/value="[^"]*@[^"]*"/, ""));
  }
  assert.equal(new Set(pages).size, 1);
  assert.equal(core.calls.length, 2);
});

test("only failed attempts spend the attempt limits, and a spent limit answers 429", async (t) => {
  const { h } = await managed({ "admin@example.com": settled() }, t);
  for (let attempt = 0; attempt < h.cfg.passwordLimitPerEmail + 2; attempt++) {
    const ok = await submit(h, { email: "admin@example.com", password: "a private password" });
    assert.equal(ok.status, 302);
  }
  assert.deepEqual(h.claims.calls, []);
  for (let attempt = 0; attempt < h.cfg.passwordLimitPerEmail; attempt++) {
    const wrong = await submit(h, { email: "admin@example.com", password: "wrong" });
    assert.equal(wrong.status, 401);
  }
  const limited = await submit(h, { email: "admin@example.com", password: "wrong" });
  assert.equal(limited.status, 429);
  assert.match(await limited.text(), /Too many sign-in attempts/);
});

test("a locked account reports roughly how long to wait", async (t) => {
  const { h } = await managed({ "admin@example.com": { ...settled(), locked: true } }, t);
  const response = await submit(h, { email: "admin@example.com", password: "a private password" });
  assert.equal(response.status, 429);
  assert.match(await response.text(), /Try again in about 10 minutes\./);
  assert.deepEqual(h.claims.calls, []);
});

test("a core outage reads as an outage and never signs anyone in", async (t) => {
  const { h, core } = await managed({ "admin@example.com": settled() }, t);
  core.fail(true);
  const response = await submit(h, { email: "admin@example.com", password: "a private password" });
  assert.equal(response.status, 503);
  assert.match(await response.text(), /Sign-in is temporarily unavailable/);
  assert.equal(response.headers.get("location"), null);
});

test("a first sign-in must set a new password before any code is issued", async (t) => {
  const accounts = {
    "admin@example.com": { ...settled(), password: "initial-password", forceChange: true },
  };
  const { h, core } = await managed(accounts, t);
  const { verifier, challenge } = pkcePair();
  const first = await submit(h, { email: "admin@example.com", password: "initial-password", remember: "1" }, challenge);
  assert.equal(first.status, 200);
  assert.equal(first.headers.get("location"), null);
  const html = await first.text();
  assert.match(html, /Set a new password/);
  const change = /name="change" value="([^"]+)"/.exec(html)![1]!;
  const post = (fields: Record<string, string>): Promise<Response> =>
    fetch(`${h.base}/change-password`, form({ change, ...fields }));

  const mismatch = await post({ next: "a new private one", confirm: "a different one" });
  assert.equal(mismatch.status, 400);
  assert.match(await mismatch.text(), /The two passwords do not match\./);
  const short = await post({ next: "short", confirm: "short" });
  assert.equal(short.status, 400);
  assert.match(await short.text(), /Use at least 8 characters\./);
  const same = await post({ next: "initial-password", confirm: "initial-password" });
  assert.equal(same.status, 400);
  const sameHtml = await same.text();
  assert.match(sameHtml, /The new password must differ from the initial one\./);
  assert.equal(/name="change" value="([^"]+)"/.exec(sameHtml)![1], change);
  assert.equal(accounts["admin@example.com"].password, "initial-password");

  const changed = await post({ next: "a new private one", confirm: "a new private one" });
  assert.equal(changed.status, 302);
  assert.equal(changed.headers.get("set-cookie"), null);
  const claims = await idTokenFor(h, changed.headers.get("location")!, verifier);
  assert.equal(claims.password_version, "changed-1");
  assert.equal(claims.remember_login, true);

  const replay = await post({ next: "an attacker's choice", confirm: "an attacker's choice" });
  assert.equal(replay.status, 400);
  assert.match(await replay.text(), /This password change expired/);
  assert.equal(accounts["admin@example.com"].password, "a new private one");
  assert.equal(core.calls.filter((path) => path === "/v1/auth/password/set").length, 3);
});

test("a password change page outlives neither its lifetime nor a credential reset", async (t) => {
  const accounts = {
    "admin@example.com": { ...settled(), password: "initial-password", forceChange: true },
  };
  const { h } = await managed(accounts, t);
  const begin = async (): Promise<string> => {
    const response = await submit(h, { email: "admin@example.com", password: "initial-password" });
    return /name="change" value="([^"]+)"/.exec(await response.text())![1]!;
  };
  const reset = await begin();
  accounts["admin@example.com"].version = "v2";
  const afterReset = await fetch(
    `${h.base}/change-password`,
    form({ change: reset, next: "a new private one", confirm: "a new private one" }),
  );
  assert.equal(afterReset.status, 400);
  const html = await afterReset.text();
  assert.match(html, /This password change expired/);
  assert.match(html, /href="https:\/\/agent\.example\.test\/auth\/login">Sign in again<\/a>/);

  const late = await begin();
  h.now.ms += 11 * 60_000;
  const expired = await fetch(
    `${h.base}/change-password`,
    form({ change: late, next: "a new private one", confirm: "a new private one" }),
  );
  assert.equal(expired.status, 400);
  assert.equal(accounts["admin@example.com"].password, "initial-password");
  for (const change of ["", "not-a-token"]) {
    const refused = await fetch(`${h.base}/change-password`, form({ change, next: "whatever1", confirm: "whatever1" }));
    assert.equal(refused.status, 400);
  }
});

test("a remembered broker cookie never signs anyone in while passwords are managed", async (t) => {
  const { h } = await managed({ "admin@example.com": settled() }, t);
  const token = "a".repeat(43);
  h.remembered.set(token, {
    email: "admin@example.com",
    authTime: Math.floor(h.now.ms / 1000),
    expiresAtMs: h.now.ms + 60_000,
    absoluteMs: h.now.ms + 60_000,
    idleS: 60,
  });
  const signature = createHmac("sha256", h.cfg.tokenSecret)
    .update(`qm-auth.browser.v1\n${h.cfg.issuer}\n${h.cfg.clientId}\n${token}`)
    .digest("base64url");
  const response = await fetch(`${h.base}/authorize?${authorizeQuery()}`, {
    headers: { cookie: `qm_idp_session=${token}.${signature}` },
    redirect: "manual",
  });
  assert.equal(response.status, 200);
  assert.match(await response.text(), /type="password"/);
});

test("the password routes exist only while passwords are managed", async (t) => {
  const h = await startHarness();
  t.after(() => h.close());
  assert.equal((await fetch(`${h.base}/forgot`)).status, 404);
  const refused = await fetch(
    `${h.base}/change-password`,
    form({ change: "x", next: "whatever1", confirm: "whatever1" }),
  );
  assert.equal(refused.status, 404);
});

for (const mode of ["email", "password"]) {
  test(`${mode} form errors do not extend the original sign-in request`, async (t) => {
    const h = await startHarness({ env: { AUTH_LOGIN_MODE: mode } });
    t.after(() => h.close());
    const { request } = await signInPage(h);
    h.now.ms += (h.cfg.requestTtlS - 60) * 1000;
    const retry = await fetch(`${h.base}/authorize`, form({ request, email: "invalid" }));
    assert.equal(retry.status, 400);
    const retryToken = hiddenRequestToken(await retry.text());
    assert.equal(retryToken, request);
    h.now.ms += 120_000;
    const expired = await fetch(
      `${h.base}/authorize`,
      form({ request: retryToken, email: "admin@example.com", password: "never-forward-this" }),
    );
    assert.equal(expired.status, 400);
    assert.match(await expired.text(), /sign-in page expired/);
    assert.equal(h.claims.calls.length, 0);
    assert.equal(h.mailer.sent.length, 0);
  });
}

test("an invalid sign-in request offers a trusted restart without reflecting credentials or redirect input", async (t) => {
  const { h, core } = await managed({ "admin@example.com": settled() }, t);
  const { request: token } = await signInPage(h);
  for (const request of ["", "not-a-token", `x${token.slice(1)}`]) {
    const response = await fetch(
      `${h.base}/authorize`,
      form({
        request,
        email: "admin@example.com",
        password: "never-forward-this",
        returnTo: "https://evil.example/",
        redirect_uri: "https://evil.example/",
      }),
    );
    assert.equal(response.status, 400);
    const html = await response.text();
    assert.match(html, /sign-in page expired/);
    assert.match(html, /href="https:\/\/agent\.example\.test\/auth\/login">Sign in again<\/a>/);
    assert.doesNotMatch(html, /never-forward-this|evil\.example|admin@example\.com|<form/);
    assert.equal(response.headers.get("location"), null);
    assert.match(response.headers.get("cache-control") ?? "", /no-store/);
  }
  assert.equal(h.claims.calls.length, 0);
  assert.equal(core.calls.length, 0);
});

test("the sign-in form binds its state, and its policy permits only the resume script", async (t) => {
  const h = await startHarness();
  t.after(() => h.close());
  const { response, html, request, state } = await signInPage(h);
  const script = /<script>([\s\S]*?)<\/script>/.exec(html)?.[1];
  assert.ok(script);
  const hash = createHash("sha256").update(script).digest("base64");
  assert.ok(response.headers.get("content-security-policy")?.includes(`script-src 'sha256-${hash}'`));
  assert.ok(html.includes(`?state=${encodeURIComponent(state)}"`));
  assert.ok(script.includes("event.persisted"));
  const rejected = await fetch(`${h.base}/authorize?state=wrong`, form({ request, email: "admin@example.com" }));
  assert.equal(rejected.status, 400);
  assert.equal(h.mailer.sent.length, 0);
  const accepted = await fetch(
    `${h.base}/authorize?state=${encodeURIComponent(state)}`,
    form({ request, email: "admin@example.com" }),
  );
  assert.equal(accepted.status, 200);
  await h.settle();
  assert.equal(h.mailer.sent.length, 1);
});
