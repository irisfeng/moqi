import assert from "node:assert/strict";
import test from "node:test";
import { harness } from "./deep-link-boot-fixture.ts";

const themes = {
  themes: [
    {
      id: "paper",
      name: "素白",
      light: { background: "#ffffff", foreground: "#1b1d21", cta: "#1c6a8a", sidebar: "#f7f7f8" },
      dark: { background: "#161719", foreground: "#ececed", cta: "#1f6f8f", sidebar: "#1b1c1f" },
    },
    {
      id: "mist",
      name: "雾蓝",
      light: { background: "#f5f7fa", foreground: "#1a2230", cta: "#1c6a8a", sidebar: "#edf1f6" },
      dark: { background: "#101419", foreground: "#e8ecf2", cta: "#2a7ca0", sidebar: "#161b22" },
    },
  ],
};

const orgCss =
  "html:not(.dark){--background:#ffffff;--foreground:#1b1d21;--cta:#1c6a8a}html.dark{--background:#000000}";

function followLink(): HTMLButtonElement | undefined {
  return [...document.querySelectorAll<HTMLButtonElement>(".settings-palette .settings-theme-link")].find((button) =>
    /organization's colors/.test(button.textContent ?? ""),
  );
}

function cards(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>(".settings-palette-card")];
}

test("settings lists the palettes, applies a pick at once and follows the organisation again on its default", async () => {
  const h = await harness({ path: "/", welcome: true });
  const block = document.createElement("script");
  block.type = "application/json";
  block.id = "coworker-themes";
  block.textContent = JSON.stringify(themes);
  const org = document.createElement("style");
  org.textContent = orgCss;
  document.head.append(block, org);
  localStorage.removeItem("theme:palette");
  try {
    h.releaseSessions();
    await h.boot();
    h.switchView("settings");
    assert.equal(cards().length, 2);
    assert.equal(document.querySelector("[aria-label=Colors]")?.getAttribute("role"), "radiogroup");
    assert.match(cards()[0].textContent ?? "", /Org default/);
    assert.doesNotMatch(cards()[1].textContent ?? "", /Org default/);
    assert.equal(cards()[0].getAttribute("aria-checked"), "true");
    assert.equal(document.getElementById("gallery-theme"), null);

    cards()[1].click();
    assert.equal(localStorage.getItem("theme:palette"), "mist");
    assert.equal(followLink(), undefined, "the org-default card is the way back while the org matches a card");
    const style = document.getElementById("gallery-theme");
    assert.ok(style, "a picked palette is painted at once");
    assert.match(style.textContent ?? "", /html:root:not\(\.dark\)\{--background:#f5f7fa/);
    assert.equal(cards()[1].getAttribute("aria-checked"), "true");
    assert.equal(cards()[0].getAttribute("aria-checked"), "false");

    cards()[0].click();
    assert.equal(localStorage.getItem("theme:palette"), null);
    assert.equal(document.getElementById("gallery-theme"), null);
    assert.equal(cards()[0].getAttribute("aria-checked"), "true");
  } finally {
    localStorage.removeItem("theme:palette");
    block.remove();
    org.remove();
    document.getElementById("gallery-theme")?.remove();
    await h.close();
  }
});

test("a pick can return to the organisation's colors when they match no palette", async () => {
  const h = await harness({ path: "/", welcome: true });
  const block = document.createElement("script");
  block.type = "application/json";
  block.id = "coworker-themes";
  block.textContent = JSON.stringify(themes);
  const org = document.createElement("style");
  org.textContent = "html:not(.dark){--background:#fafafa;--foreground:#222222;--cta:#335577}";
  document.head.append(block, org);
  localStorage.setItem("theme:palette", "mist");
  try {
    h.releaseSessions();
    await h.boot();
    h.switchView("settings");
    window.dispatchEvent(new window.StorageEvent("storage", { key: "theme:palette" }));
    assert.ok(document.getElementById("gallery-theme"), "a pick made in another tab is painted here");
    assert.doesNotMatch(document.querySelector(".settings-palette")?.textContent ?? "", /Org default/);
    assert.equal(cards()[1].getAttribute("aria-checked"), "true");
    followLink()!.click();
    assert.equal(localStorage.getItem("theme:palette"), null);
    assert.equal(document.getElementById("gallery-theme"), null);
    assert.equal(followLink(), undefined);
    assert.ok(cards().every((card) => card.getAttribute("aria-checked") === "false"));
  } finally {
    localStorage.removeItem("theme:palette");
    block.remove();
    org.remove();
    document.getElementById("gallery-theme")?.remove();
    await h.close();
  }
});

test("settings shows no colors row when the page carries no palettes", async () => {
  const h = await harness({ path: "/", welcome: true });
  try {
    h.releaseSessions();
    await h.boot();
    h.switchView("settings");
    assert.equal(document.querySelector(".settings-palette"), null);
  } finally {
    await h.close();
  }
});
