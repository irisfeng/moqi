import assert from "node:assert/strict";
import test from "node:test";
import { litFixture } from "./lit-fixture.ts";

const PERSON = "alex@example.com";

type Reply = { ok: boolean; status: number; data: any };

async function openPerson(contact: (method: string, body: any) => Reply) {
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
    confirm: () => true,
    api: async (method: string, path: string, body?: any) => {
      if (path === "/api/users/" + encodeURIComponent(PERSON) + "/contact") return contact(method, body);
      if (path.startsWith("/api/users/" + encodeURIComponent(PERSON) + "/password"))
        return { ok: true, status: 200, data: { version: "v1", forceChange: false, locked: false } };
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

function contactCard(f: ReturnType<typeof litFixture>) {
  const card = [...f.root.querySelectorAll("section.card")].find(
    (section) => section.querySelector("h2")?.textContent === "Contact",
  );
  assert.ok(card, "the person page shows a Contact card");
  return card;
}

async function save(f: ReturnType<typeof litFixture>, phone: string) {
  const input = contactCard(f).querySelector<HTMLInputElement>("#contact-phone")!;
  input.value = phone;
  input.dispatchEvent(new f.dom.window.Event("input"));
  contactCard(f).querySelector<HTMLButtonElement>("button.primary")!.click();
  await settle();
}

test("an administrator sees the email, then saves and clears a phone number", async () => {
  const puts: any[] = [];
  let phone: string | null = null;
  const f = await openPerson((method, body) => {
    if (method === "PUT") {
      puts.push(body);
      phone = body.phone.trim() || null;
    }
    return { ok: true, status: 200, data: { email: PERSON, phone } };
  });
  assert.match(contactCard(f).textContent ?? "", /alex@example\.com/);
  assert.equal(contactCard(f).querySelector<HTMLInputElement>("#contact-phone")!.value, "");
  await save(f, "0123-0123 4567 转 806");
  assert.deepEqual(
    puts.map((body) => body.phone),
    ["0123-0123 4567 转 806"],
  );
  assert.equal(contactCard(f).querySelector<HTMLInputElement>("#contact-phone")!.value, "0123-0123 4567 转 806");
  assert.equal(contactCard(f).querySelector(".hint")?.textContent, "Saved. Colleagues see it in the Directory.");
  await save(f, "");
  assert.equal(puts.length, 2);
  assert.equal(contactCard(f).querySelector(".hint")?.textContent, "Phone number removed.");
  f.dom.window.close();
});

test("a refused number keeps what was typed and shows the reason", async () => {
  const f = await openPerson((method) =>
    method === "PUT"
      ? { ok: false, status: 400, data: { message: "A phone number is up to 32 characters." } }
      : { ok: true, status: 200, data: { email: PERSON, phone: null } },
  );
  await save(f, "call me");
  assert.equal(contactCard(f).querySelector(".hint")?.textContent, "A phone number is up to 32 characters.");
  assert.equal(contactCard(f).querySelector<HTMLInputElement>("#contact-phone")!.value, "call me");
  f.dom.window.close();
});
