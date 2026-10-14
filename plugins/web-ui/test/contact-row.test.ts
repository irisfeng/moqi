import assert from "node:assert/strict";
import test from "node:test";
import { harness } from "./deep-link-boot-fixture.ts";

async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 100 && !check(); i++) await new Promise((resolve) => setTimeout(resolve, 10));
}

async function type(row: Element, value: string): Promise<void> {
  const input = row.querySelector("input")!;
  input.value = value;
  input.dispatchEvent(new window.Event("input"));
  await (row as unknown as { updateComplete: Promise<boolean> }).updateComplete;
}

function submit(row: Element): void {
  row.querySelector("form")!.dispatchEvent(new window.Event("submit", { cancelable: true }));
}

test("settings lets a person add, refuse and clear their own phone", async () => {
  const h = await harness({ path: "/", welcome: true });
  const previousFetch = globalThis.fetch;
  const puts: string[] = [];
  let phone: string | null = null;
  globalThis.fetch = async (input, init) => {
    if (String(input) !== "/api/me/contact") return previousFetch(input, init);
    if (init?.method === "PUT") {
      const sent = String(JSON.parse(String(init.body)).phone);
      puts.push(sent);
      if (sent === "call me")
        return Response.json({ error: "bad_request", message: "Not a phone number." }, { status: 400 });
      phone = sent.trim() || null;
    }
    return Response.json({ email: "tester@example.com", phone });
  };
  try {
    h.releaseSessions();
    await h.boot();
    h.switchView("settings");
    const row = document.querySelector("qm-contact-row")!;
    assert.ok(row, "settings mounts the contact row");
    await until(() => !!row.querySelector("input"));
    assert.equal((row as HTMLElement).hidden, false);
    assert.match(row.textContent ?? "", /tester@example\.com/);
    const button = row.querySelector("button")!;
    assert.equal(button.disabled, true, "nothing to save until the number changes");

    await type(row, "0123-0123 4567 转 806");
    assert.equal(button.disabled, false);
    submit(row);
    await until(() => /Saved/.test(row.textContent ?? ""));
    assert.deepEqual(puts, ["0123-0123 4567 转 806"]);
    assert.equal(row.querySelector("input")!.value, "0123-0123 4567 转 806");

    await type(row, "call me");
    submit(row);
    await until(() => !!row.querySelector("[role=alert]"));
    assert.equal(row.querySelector("[role=alert]")!.textContent, "Not a phone number.");
    assert.equal(row.querySelector("input")!.value, "call me", "a refused number keeps what was typed");

    await type(row, "");
    submit(row);
    await until(() => /Phone number removed/.test(row.textContent ?? ""));
    assert.deepEqual(puts, ["0123-0123 4567 转 806", "call me", ""]);
    assert.equal(row.querySelector("[role=alert]"), null);
  } finally {
    globalThis.fetch = previousFetch;
    await h.close();
  }
});

test("the contact row hides once the person has no directory entry", async () => {
  const h = await harness({ path: "/", welcome: true });
  const previousFetch = globalThis.fetch;
  let found = true;
  let asked = 0;
  globalThis.fetch = async (input, init) => {
    if (String(input) !== "/api/me/contact") return previousFetch(input, init);
    asked++;
    return found
      ? Response.json({ email: "tester@example.com", phone: null })
      : Response.json({ error: "not_found" }, { status: 404 });
  };
  try {
    h.releaseSessions();
    await h.boot();
    h.switchView("settings");
    const row = document.querySelector("qm-contact-row") as HTMLElement;
    await until(() => !!row.querySelector("input"));
    assert.equal(row.hidden, false);
    found = false;
    const parent = row.parentElement!;
    row.remove();
    parent.append(row);
    await until(() => asked >= 2 && row.hidden);
    assert.ok(asked >= 2, "reconnecting asks again");
    assert.equal(row.hidden, true);
  } finally {
    globalThis.fetch = previousFetch;
    await h.close();
  }
});
