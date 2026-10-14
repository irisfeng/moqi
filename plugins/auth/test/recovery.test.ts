import assert from "node:assert/strict";
import { test } from "node:test";
import { startHarness } from "./helpers.ts";

test("recovery explains administrator verification and never accepts an initial password", async () => {
  const h = await startHarness({ env: { AUTH_LOGIN_MODE: "password" } });
  try {
    const page = await fetch(`${h.base}/forgot`);
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, /Ask your administrator to recover your account/);
    assert.match(html, /href="https:\/\/agent\.example\.test\/auth\/login">Back to sign-in<\/a>/);
    assert.doesNotMatch(html, /<form|name="initial"/);
    const response = await fetch(`${h.base}/forgot`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ email: "admin@example.com", initial: "initial-password" }),
    });
    assert.equal(response.status, 404);
    await response.text();
    assert.equal(h.mailer.sent.length, 0);
  } finally {
    await h.close();
  }
});
