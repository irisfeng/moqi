import assert from "node:assert/strict";
import test from "node:test";
import { litFixture } from "./lit-fixture.ts";

const PERSON = "alex@example.com";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

type Reply = { ok: boolean; status: number; data: any };

async function openPerson(password: (method: string, body: any) => Reply, confirm = () => true) {
  const f = litFixture();
  await f.ui.userDetail.detail(f.root, PERSON, {
    pageShell() {},
    current: () => true,
    labelRole: () => "member",
    scopeKind: () => "personal",
    fmtTime: String,
    plural: (n: number, noun: string) => `${n} ${noun}s`,
    stateToUrl: () => "/admin",
    webUiAsButton: () => f.document.createElement("button"),
    confirm,
    api: async (method: string, path: string, body?: any) => {
      if (path.startsWith("/api/users/" + encodeURIComponent(PERSON) + "/password")) return password(method, body);
      if (path.startsWith("/api/keychain")) return { ok: true, status: 200, data: { credentials: [], grants: [] } };
      return { ok: true, status: 200, data: { principalId: PERSON, scopeId: "personal:" + PERSON, stats: {} } };
    },
  });
  await settle();
  return f;
}

async function settle() {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
}

function passwordCard(f: ReturnType<typeof litFixture>) {
  const card = [...f.root.querySelectorAll("section.card")].find(
    (section) => section.querySelector("h2")?.textContent === "Password",
  );
  assert.ok(card, "the person page shows a Password card");
  return card;
}

async function press(f: ReturnType<typeof litFixture>) {
  passwordCard(f).querySelector<HTMLButtonElement>("button.danger-link")!.click();
  await settle();
}

test("an administrator restores a locked person's initial password and sees the new state", async () => {
  const posts: any[] = [];
  let state = { version: "v1", forceChange: false, locked: true };
  const f = await openPerson((method, body) => {
    if (method === "GET") return { ok: true, status: 200, data: state };
    posts.push(body);
    state = { version: body.operationId, forceChange: true, locked: false };
    return { ok: true, status: 200, data: { ok: true, forceChange: true } };
  });
  assert.equal(passwordCard(f).querySelector(".badge")?.textContent, "locked after failed sign-ins");
  await press(f);
  assert.equal(posts.length, 1);
  assert.equal(posts[0].version, "v1");
  assert.match(posts[0].operationId, UUID);
  assert.equal(passwordCard(f).querySelector(".badge")?.textContent, "initial password, change due at sign-in");
  assert.equal(
    passwordCard(f).querySelector(".hint")?.textContent,
    "Done. They sign in with their initial password and choose a new one.",
  );
  f.dom.window.close();
});

test("a cancelled confirmation sends nothing", async () => {
  const posts: any[] = [];
  const f = await openPerson(
    (method, body) => {
      if (method !== "GET") posts.push(body);
      return { ok: true, status: 200, data: { version: "v1", forceChange: false, locked: false } };
    },
    () => false,
  );
  assert.equal(passwordCard(f).querySelector(".badge")?.textContent, "chosen by the person");
  await press(f);
  assert.equal(posts.length, 0);
  f.dom.window.close();
});

test("a request lost on the network retries the same operation; an answered failure starts a new one", async () => {
  const posts: any[] = [];
  const replies: Reply[] = [
    { ok: false, status: 0, data: { message: "Network request failed." } },
    { ok: false, status: 409, data: { message: "The password state changed. Refresh and confirm again." } },
    { ok: true, status: 200, data: { ok: true, forceChange: true } },
  ];
  const f = await openPerson((method, body) => {
    if (method === "GET") return { ok: true, status: 200, data: { version: "v1", forceChange: false, locked: false } };
    posts.push(body);
    return replies.shift()!;
  });
  await press(f);
  assert.equal(passwordCard(f).querySelector(".hint")?.textContent, "Network request failed.");
  await press(f);
  assert.equal(
    passwordCard(f).querySelector(".hint")?.textContent,
    "The password state changed. Refresh and confirm again.",
  );
  await press(f);
  assert.equal(posts.length, 3);
  assert.equal(posts[1].operationId, posts[0].operationId);
  assert.notEqual(posts[2].operationId, posts[1].operationId);
  f.dom.window.close();
});

test("with nothing to restore the card says why and offers no button", async () => {
  const f = await openPerson(() => ({
    ok: false,
    status: 400,
    data: { message: "Ask another administrator to reset your password." },
  }));
  assert.equal(passwordCard(f).querySelector("button"), null);
  assert.equal(
    passwordCard(f).querySelector(".hint")?.textContent,
    "Ask another administrator to reset your password.",
  );
  f.dom.window.close();
});
