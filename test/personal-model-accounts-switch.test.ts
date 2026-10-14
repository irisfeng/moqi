import "./support/auto-fake-sprites.ts";
import assert from "node:assert/strict";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { createServer } from "../src/api/server.ts";
import { mintPortalIdentity } from "../src/auth/portal-identity.ts";
import { signRequest } from "../src/auth/source-auth.ts";
import { loadConfig } from "../src/config.ts";
import { resolveBrowserModel } from "../src/model/browser-model.ts";
import { createMemoryConfigStore } from "../src/resolution/config-store.ts";
import { buildApp, serverDeps } from "../src/wiring.ts";
import { testConfig } from "./support/test-config.ts";

const SECRET = "personal-accounts-switch-signing-secret";
const PORTAL = SECRET + "-portal";
const PRINCIPAL = "alice@default-org";

test("personal AI accounts default on and can be explicitly turned off", () => {
  assert.equal(loadConfig({}).personalModelAccountsEnabled, true);
  assert.equal(loadConfig({ PERSONAL_MODEL_ACCOUNTS_ENABLED: "true" }).personalModelAccountsEnabled, true);
  assert.equal(loadConfig({ PERSONAL_MODEL_ACCOUNTS_ENABLED: "false" }).personalModelAccountsEnabled, false);
  assert.throws(() => loadConfig({ PERSONAL_MODEL_ACCOUNTS_ENABLED: "maybe" }));
});

test("with personal AI accounts off, a stored personal choice and the org-wide requirement both read as company access", async () => {
  const store = createMemoryConfigStore("default-org", { personalModelAccounts: false });
  await store.setPersonalModelAuth(PRINCIPAL, true, "anthropic");
  store.setIndividualModelAuth(true);
  await store.flushScope("org:default-org");
  assert.equal(await store.getModelAccountDurable(PRINCIPAL), "company");
  assert.equal(await store.getModelAccountDurable("bob@default-org"), "company");
  assert.equal(await store.getIndividualModelAuthDurable(PRINCIPAL), false);
  assert.equal(await store.getIndividualModelAuthDurable(), false);
  const browser = await resolveBrowserModel({ actorId: PRINCIPAL, config: store, companyModel: "company-model" });
  assert.equal(browser.account, "company");
  assert.equal(browser.routing, null);
});

test("with personal AI accounts off, everyone stays on company access and no connect flow starts", async () => {
  const config = testConfig({
    signingSecret: SECRET,
    portalIdentitySecret: PORTAL,
    personalModelAccountsEnabled: false,
  });
  const built = buildApp(config);
  built.config.setInternalMemberOverrides([PRINCIPAL]);
  built.config.setIndividualModelAuth(true);
  await built.config.flushScope("org:default-org");
  const server = createServer(built.app, { ...serverDeps(config, built), requireSignedPortalIdentity: true });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  async function call(method: "GET" | "POST", path: string, body?: Record<string, unknown>) {
    const text = body ? JSON.stringify({ ...body, principalId: PRINCIPAL, nonce: crypto.randomUUID() }) : "";
    const ts = Math.floor(Date.now() / 1000);
    return fetch(base + path, {
      method,
      headers: {
        ...(body ? { "content-type": "application/json" } : {}),
        "x-timestamp": String(ts),
        "x-signature": signRequest(SECRET, ts, `${method}\n${path}\n${text}`),
        "x-portal-identity": await mintPortalIdentity({ p: PRINCIPAL, exp: Date.now() + 60_000 }, PORTAL),
      },
      ...(body ? { body: text } : {}),
    });
  }
  try {
    const status = await call("GET", `/v1/user-model-auth/status?principalId=${encodeURIComponent(PRINCIPAL)}`);
    assert.equal(status.status, 200);
    assert.deepEqual(await status.json(), {
      offered: false,
      individualModelAuth: false,
      required: false,
      account: "company",
      connections: [],
    });
    for (const [path, body] of [
      ["/v1/user-model-auth/account", { account: "personal", provider: "anthropic" }],
      ["/v1/user-model-auth/api-key", { provider: "claude", apiKey: "synthetic-personal-key" }],
      ["/v1/user-model-auth/claude/start", {}],
      ["/v1/user-model-auth/chatgpt/start", {}],
      ["/v1/user-model-auth/chatgpt/poll", { deviceAuthId: "synthetic-device" }],
      ["/v1/user-model-auth/claude/complete", { code: "synthetic-code", verifier: "synthetic-verifier" }],
      ["/v1/user-model-auth/disconnect", { provider: "claude" }],
    ] as const) {
      assert.equal((await call("POST", path, body)).status, 404, path);
    }
    assert.deepEqual(await built.userModelCredentials.connections(PRINCIPAL), []);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
