import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test } from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { buildApp } from "../src/wiring.ts";
import { createServer } from "../src/api/server.ts";
import { createLoginPasswordStore } from "../src/auth/login-password-store.ts";
import { testConfig } from "./support/test-config.ts";

test("old initial passwords cannot reset a changed password through the HTTP API", async () => {
  const built = buildApp(testConfig({ dataDir: mkdtempSync(join(tmpdir(), "password-recovery-")) }));
  const loginPasswords = createLoginPasswordStore();
  await loginPasswords.putInitial({
    id: "member@example.test",
    initialPassword: "initial-password",
    updatedBy: "test",
  });
  await loginPasswords.setNew(
    "member@example.test",
    "private-new-password",
    null,
    undefined,
    (await loginPasswords.get("member@example.test"))!.version,
  );
  const signingSecret = "source-test-secret".repeat(3);
  const portalIdentitySecret = "portal-test-secret".repeat(3);
  const server = createServer(built.app, {
    config: built.config,
    loginPasswords,
    signingSecret,
    portalIdentitySecret,
    capabilitySecret: "capability-test-secret".repeat(3),
    requireSignedPortalIdentity: true,
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const body = JSON.stringify({ principalId: "member@example.test", initialPassword: "initial-password" });
    const timestamp = String(Math.floor(Date.now() / 1000));
    const payload = Buffer.from(JSON.stringify({ p: "member@example.test", exp: Date.now() + 60_000 })).toString(
      "base64url",
    );
    const identity = payload + "." + createHmac("sha256", portalIdentitySecret).update(payload).digest("base64url");
    const signature =
      "v0=" +
      createHmac("sha256", signingSecret)
        .update(`v0:${timestamp}:POST\n/v1/auth/password/reset-to-initial\n${body}`)
        .digest("hex");
    const response = await fetch(`${base}/v1/auth/password/reset-to-initial`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-timestamp": timestamp,
        "x-signature": signature,
        "x-portal-identity": identity,
      },
      body,
    });
    assert.equal(response.status, 404);
    await response.text();
    assert.deepEqual(await loginPasswords.verify("member@example.test", "private-new-password"), {
      status: "ok",
      forceChange: false,
      version: (await loginPasswords.get("member@example.test"))!.version,
    });
    assert.deepEqual(await loginPasswords.verify("member@example.test", "initial-password"), { status: "invalid" });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
