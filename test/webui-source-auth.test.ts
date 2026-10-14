import "./support/auto-fake-sprites.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import type { AddressInfo } from "node:net";
import { buildApp } from "../src/wiring.ts";
import { createServer } from "../src/api/server.ts";
import { CONTROL_PLANE_AUD, mintCapabilityToken } from "../src/auth/capability-token.ts";
import { signedHeaders, withSourceAuthNonce } from "../plugins/chassis/src/core-client.ts";
import { mintPortalIdentity, PORTAL_IDENTITY_HEADER } from "../plugins/chassis/src/portal-identity.ts";
import { testConfig } from "./support/test-config.ts";

const SOURCE = "webui-source-signing-secret-distinct-123456";
const IDENTITY = "webui-portal-identity-secret-distinct-123456";
const CAPABILITY = "webui-agent-capability-secret-distinct-123456";

test("Web-only routes require signed source requests and keep personal writes bound to the portal actor", async () => {
  const built = buildApp(testConfig());
  const home = { welcome: { headline: "test" } };
  await built.webuiHome.put("org:default-org", home);
  const announcement = await built.announcements.create(
    { level: "notice", title: "test", body: "test", startsAt: Date.now() - 1000, endsAt: Date.now() + 60_000 },
    "admin",
  );
  const server = createServer(built.app, {
    signingSecret: SOURCE,
    portalIdentitySecret: IDENTITY,
    capabilitySecret: CAPABILITY,
    requireSignedPortalIdentity: true,
    announcements: built.announcements,
    webuiHome: built.webuiHome,
    webuiEvents: built.webuiEvents,
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const routes = [
    { method: "GET", path: "/v1/announcements?principalId=U1", status: 200 },
    { method: "GET", path: "/v1/webui-home", status: 200 },
    { method: "POST", path: `/v1/announcements/${announcement.id}/dismiss`, body: { principalId: "U1" }, status: 200 },
    {
      method: "POST",
      path: "/v1/webui-events",
      body: { principalId: "U1", type: "guide_page_open", ref: "auth-test" },
      status: 204,
    },
  ];
  try {
    for (const route of routes) {
      const body = route.body ? JSON.stringify(route.body) : "";
      const request = (headers: Record<string, string>, raw = body, path = route.path) =>
        fetch(`${base}${path}`, {
          method: route.method,
          headers,
          ...(raw ? { body: raw } : {}),
        });
      assert.equal((await request({})).status, 401, route.path);
      for (const aud of [undefined, CONTROL_PLANE_AUD]) {
        const token = await mintCapabilityToken(
          { actorId: "U1", scopeId: "personal:U1", exp: Date.now() + 60_000, ...(aud ? { aud } : {}) },
          CAPABILITY,
        );
        const response = await request({ "x-agent-capability": token, "content-type": "application/json" });
        assert.equal(response.status, 403, `${route.path} with ${aud ?? "legacy"}`);
        assert.equal(
          ((await response.json()) as { message: string }).message,
          "capability token not valid for this route",
        );
      }
      const sourceRequest = (raw = body, actor = "U1", secret = SOURCE, identitySecret = IDENTITY) => {
        const path = withSourceAuthNonce(route.path, SOURCE);
        return request(
          {
            ...signedHeaders(secret, route.method, path, raw),
            ...(actor
              ? { [PORTAL_IDENTITY_HEADER]: mintPortalIdentity({ p: actor, exp: Date.now() + 60_000 }, identitySecret) }
              : {}),
          },
          raw,
          path,
        );
      };
      assert.equal((await sourceRequest(body, "U1", "wrong-source-secret")).status, 401);
      if (route.body) {
        assert.equal((await sourceRequest(body, "")).status, 401);
        assert.equal((await sourceRequest(body, "U1", SOURCE, "wrong-identity-secret")).status, 401);
        const foreignBody = JSON.stringify({ ...route.body, principalId: "U2" });
        assert.equal((await sourceRequest(foreignBody)).status, 404, route.path);
      }
      const response = await sourceRequest();
      assert.equal(response.status, route.status, `${route.path}: ${await response.text()}`);
    }
    assert.deepEqual(await built.announcements.dismissals("U1"), [announcement.id]);
    assert.deepEqual(await built.announcements.dismissals("U2"), []);
    const events = await built.webuiEvents.list({});
    assert.equal(events.length, 1);
    assert.equal(events[0]!.principalId, "U1");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
