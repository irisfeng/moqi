import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { decodeJwt } from "jose";
import { createLoginPasswordStore } from "../src/auth/login-password-store.ts";
import {
  startHarness,
  authorizeQuery,
  hiddenRequestToken,
  pkcePair,
  basicAuth,
  CLIENT_ID,
  CLIENT_SECRET,
  REDIRECT_URI,
} from "../plugins/auth/test/helpers.ts";

const form = (body: Record<string, string>) => ({
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams(body).toString(),
  redirect: "manual" as const,
});

test("password broker binds verified credential versions through change and OIDC code exchange", async () => {
  const passwords = createLoginPasswordStore();
  const id = "admin@example.com";
  const initial = await passwords.putInitial({ id, initialPassword: "synthetic-initial", updatedBy: "fixture" });
  const core = createServer((req, res) => {
    void (async () => {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw);
      res.setHeader("content-type", "application/json");
      if (req.url?.startsWith("/v1/auth/password/verify"))
        return void res.end(JSON.stringify(await passwords.verify(body.principalId, body.password)));
      if (req.url?.startsWith("/v1/auth/password/set")) {
        const version = randomUUID();
        const result = await passwords.setNew(
          body.principalId,
          body.nextPassword,
          null,
          undefined,
          body.version,
          version,
        );
        res.writeHead(result === "ok" ? 200 : 403);
        return void res.end(JSON.stringify(result === "ok" ? { ok: true, version } : { error: "wrong_current" }));
      }
      res.writeHead(404);
      res.end("{}");
    })().catch(() => {
      res.writeHead(500);
      res.end();
    });
  });
  await new Promise<void>((resolve) => core.listen(0, "127.0.0.1", resolve));
  const h = await startHarness({
    env: { AUTH_LOGIN_MODE: "password", CORE_API_URL: `http://127.0.0.1:${(core.address() as AddressInfo).port}` },
  });
  const { verifier, challenge } = pkcePair();
  async function begin() {
    const page = await fetch(`${h.base}/authorize?${authorizeQuery({ code_challenge: challenge })}`);
    const request = hiddenRequestToken(await page.text());
    const result = await fetch(
      `${h.base}/authorize`,
      form({ request, email: id, password: "synthetic-initial", remember: "1" }),
    );
    assert.equal(result.status, 200);
    const html = await result.text();
    const token = /name="change" value="([^"]+)"/.exec(html)?.[1];
    assert.ok(token);
    return token;
  }
  try {
    const staleToken = await begin();
    const resetVersion = randomUUID();
    assert.equal(await passwords.resetInitial(id, "fixture-admin", initial.version!, resetVersion), "ok");
    const stale = await fetch(
      `${h.base}/change-password`,
      form({ change: staleToken, next: "synthetic-attack", confirm: "synthetic-attack" }),
    );
    assert.notEqual(stale.status, 302);
    await stale.text();
    assert.equal((await passwords.get(id))!.version, resetVersion);
    const fresh = await begin();
    const changed = await fetch(
      `${h.base}/change-password`,
      form({ change: fresh, next: "synthetic-private", confirm: "synthetic-private" }),
    );
    assert.equal(changed.status, 302);
    const code = new URL(changed.headers.get("location")!).searchParams.get("code")!;
    const response = await fetch(`${h.base}/token`, {
      ...form({ grant_type: "authorization_code", code, redirect_uri: REDIRECT_URI, code_verifier: verifier }),
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        authorization: basicAuth(CLIENT_ID, CLIENT_SECRET),
      },
    });
    assert.equal(response.status, 200);
    const tokens = (await response.json()) as { id_token: string };
    assert.equal(decodeJwt(tokens.id_token).remember_login, true);
    assert.equal(decodeJwt(tokens.id_token).password_version, (await passwords.get(id))!.version);
    assert.notEqual(decodeJwt(tokens.id_token).password_version, resetVersion);
    const replay = await fetch(
      `${h.base}/change-password`,
      form({ change: fresh, next: "synthetic-attack", confirm: "synthetic-attack" }),
    );
    assert.notEqual(replay.status, 302);
    await replay.text();
    assert.equal((await passwords.verify(id, "synthetic-private")).status, "ok");
  } finally {
    await h.close();
    await new Promise<void>((resolve) => core.close(() => resolve()));
  }
});
