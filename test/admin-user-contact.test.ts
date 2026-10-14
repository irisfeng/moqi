import "./support/auto-fake-sprites.ts";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test } from "node:test";
import type { AddressInfo } from "node:net";
import { buildApp } from "../src/wiring.ts";
import { createServer } from "../src/api/server.ts";
import { agentApiMatches } from "../src/api/agent-api-catalog.ts";
import { isUnclassifiedWrite } from "../src/api/user-scoped-routes.ts";
import { parsePhone, type PersonContact } from "../src/directory/person-contact.ts";
import { createMemoryMap } from "../src/persistence/durable-map.ts";
import { testConfig } from "./support/test-config.ts";
import { signedHeaders, withSourceAuthNonce } from "../plugins/chassis/src/core-client.ts";

const person = "Member-Contact@Example.test";
const secret = "fixture-source-secret".repeat(3);
const identitySecret = "fixture-portal-secret".repeat(3);

async function harness() {
  const built = buildApp(testConfig());
  await built.app.upsertDirectory([
    { principalId: person.toLowerCase(), displayName: "Member Contact", type: "internal" as const },
  ]);
  const contacts = createMemoryMap<PersonContact>();
  const server = createServer(built.app, {
    config: built.config,
    admin: built.admin,
    identity: built.identity,
    directory: built.directory,
    auditLog: built.auditLog,
    personContacts: contacts,
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
      const claims = { p: actor, exp: Date.now() + 60_000, ...(imp ? { imp } : {}) };
      const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
      headers["x-portal-identity"] =
        `${payload}.${createHmac("sha256", identitySecret).update(payload).digest("base64url")}`;
    }
    const response = await fetch(base + target, { method, headers, ...(body ? { body: raw } : {}) });
    return { status: response.status, data: (await response.json()) as Record<string, any> };
  }
  return { built, contacts, call, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

test("a phone number is digits with spaces, + - ( ) and 转, folded from full width", () => {
  assert.deepEqual(parsePhone(" 0123-0123  4567 转 806 "), { phone: "0123-0123 4567 转 806" });
  assert.deepEqual(parsePhone("＋86 138 0013 8000"), { phone: "+86 138 0013 8000" });
  assert.deepEqual(parsePhone("（0123）01234567"), { phone: "(0123)01234567" });
  assert.deepEqual(parsePhone(""), { phone: null });
  assert.deepEqual(parsePhone(null), { phone: null });
  for (const bad of ["call me", "12", "1".repeat(33), "138-0013-8000 ext 5", 13800138000, undefined]) {
    assert.equal(parsePhone(bad), null, `${String(bad)} is refused`);
  }
});

test("only an administrator reads and sets a person's phone, each save is audited without the number", async () => {
  const h = await harness();
  try {
    const path = `/v1/admin/users/${encodeURIComponent(person)}/contact`;
    assert.equal((await h.call("GET", path)).status, 401);
    assert.equal((await h.call("PUT", path, { phone: "0123-01234567" }, person.toLowerCase())).status, 403);
    assert.deepEqual((await h.call("GET", path, undefined, "admin-alice")).data, {
      email: person.toLowerCase(),
      phone: null,
    });
    assert.equal((await h.call("PUT", path, { phone: "call me" }, "admin-alice")).status, 400);
    const saved = await h.call("PUT", path, { phone: "0123-0123 4567 转 806" }, "admin-alice");
    assert.equal(saved.status, 200);
    assert.equal(saved.data.phone, "0123-0123 4567 转 806");
    assert.deepEqual(await h.contacts.get(person.toLowerCase()), { phone: "0123-0123 4567 转 806" });
    assert.equal((await h.call("GET", path, undefined, "admin-alice")).data.phone, "0123-0123 4567 转 806");
    assert.equal((await h.call("PUT", path, { phone: "" }, "admin-alice")).data.phone, null);
    assert.equal(await h.contacts.get(person.toLowerCase()), null, "an empty number clears the entry");
    const missing = `/v1/admin/users/${encodeURIComponent("nobody@example.test")}/contact`;
    assert.equal((await h.call("PUT", missing, { phone: "0123-01234567" }, "admin-alice")).status, 404);
    const audit = (await h.built.auditLog.events()).filter((event) => event.action === "user.contact.set");
    assert.equal(audit.length, 2);
    assert.deepEqual(new Set(audit.map((event) => event.resource)), new Set([person.toLowerCase()]));
    assert.doesNotMatch(JSON.stringify(audit), /0123\D*4567/, "the number itself stays out of the audit log");
  } finally {
    await h.close();
  }
});

test("the assistant cannot reach the contact routes through the admin plane", () => {
  assert.equal(agentApiMatches("GET", "/v1/admin/users/someone@example.test/contact"), false);
  assert.equal(agentApiMatches("PUT", "/v1/admin/users/someone@example.test/contact"), false);
  assert.equal(agentApiMatches("GET", "/v1/admin/users/someone@example.test"), true);
});

test("a signed-in person reads and sets only their own phone", async () => {
  const h = await harness();
  try {
    const self = person.toLowerCase();
    const own = `/v1/me/contact?principalId=${encodeURIComponent(self)}`;
    assert.equal((await h.call("GET", own)).status, 401);
    assert.deepEqual((await h.call("GET", own, undefined, self)).data, { email: self, phone: null });
    assert.equal((await h.call("GET", "/v1/me/contact?principalId=admin-alice", undefined, self)).status, 404);
    const other = await h.call("PUT", "/v1/me/contact", { phone: "138 0013 8000", principalId: "admin-alice" }, self);
    assert.equal(other.status, 404);
    assert.equal((await h.call("PUT", "/v1/me/contact", { phone: "call me", principalId: self }, self)).status, 400);
    const impersonated = await h.call(
      "PUT",
      "/v1/me/contact",
      { phone: "138", principalId: self },
      self,
      "admin-alice",
    );
    assert.equal(impersonated.status, 403);
    assert.equal(await h.contacts.get(self), null, "an impersonating admin cannot set the phone as the person");
    const saved = await h.call("PUT", "/v1/me/contact", { phone: "１３８ 0013 8000", principalId: self }, self);
    assert.equal(saved.status, 200);
    assert.deepEqual(saved.data, { email: self, phone: "138 0013 8000" });
    assert.deepEqual(await h.contacts.get(self), { phone: "138 0013 8000" });
    assert.equal((await h.call("GET", own, undefined, self)).data.phone, "138 0013 8000");
    const audit = (await h.built.auditLog.events()).filter((event) => event.action === "user.contact.set");
    assert.equal(audit.length, 1);
    assert.equal(audit[0]?.principalId, self);
    assert.equal(audit[0]?.resource, self);
    assert.doesNotMatch(JSON.stringify(audit), /0013/);
  } finally {
    await h.close();
  }
});

test("the own-contact routes are per-person and closed to the assistant", () => {
  assert.equal(isUnclassifiedWrite("PUT", "/v1/me/contact"), false);
  assert.equal(agentApiMatches("GET", "/v1/me/contact"), false);
  assert.equal(agentApiMatches("PUT", "/v1/me/contact"), false);
});
