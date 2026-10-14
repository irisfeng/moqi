import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { sanitizeTheme } from "../src/resolution/branding.ts";

const theme = JSON.parse(readFileSync(new URL("../deploy/layers/qm-cn/deploy/theme.json", import.meta.url), "utf8"));

function luminance(hex: string): number {
  const channel = (offset: number) => {
    const value = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}

function contrast(a: string, b: string): number {
  const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (high! + 0.05) / (low! + 0.05);
}

const TEXT_ON_SURFACE = [
  ["foreground", "background"],
  ["foreground", "card"],
  ["foreground", "secondary"],
  ["foreground", "sidebar"],
  ["muted-foreground", "background"],
  ["muted-foreground", "card"],
  ["muted-foreground", "sidebar"],
  ["cta-foreground", "cta"],
  ["cta-foreground", "cta-hover"],
  ["accent-foreground", "accent"],
  ["markdown-link", "background"],
  ["warning", "background"],
] as const;

test("the layer's theme is accepted whole by the core", () => {
  assert.deepEqual(sanitizeTheme(theme), theme);
});

for (const mode of ["light", "dark"] as const) {
  test(`the layer's ${mode} theme keeps text readable on every surface it sits on`, () => {
    for (const [text, surface] of TEXT_ON_SURFACE) {
      const ratio = contrast(theme[mode][text], theme[mode][surface]);
      assert.ok(ratio >= 4.5, `${mode} ${text} on ${surface}: ${ratio.toFixed(2)}`);
    }
  });
}
