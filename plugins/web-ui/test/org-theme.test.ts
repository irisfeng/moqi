import { test } from "node:test";
import assert from "node:assert/strict";
import { injectBranding, themeCss } from "../../chassis/src/branding.ts";

const page = "<html><head><title>QM</title></head><body></body></html>";

test("an organisation theme becomes light and dark token overrides in the page head", () => {
  const out = injectBranding(page, {
    theme: {
      light: { background: "#f7f5ef", foreground: "oklch(0.22 0.02 250)" },
      dark: { background: "#14161c" },
    },
  });
  assert.match(
    out,
    /<style>html:not\(\.dark\)\{--background:#f7f5ef;--foreground:oklch\(0\.22 0\.02 250\)\}html\.dark\{--background:#14161c\}<\/style><\/head>/,
  );
});

test("with no theme the page is left as it was", () => {
  assert.equal(injectBranding(page, {}), page);
  assert.equal(injectBranding(page, { theme: {} }), page);
  assert.equal(themeCss(undefined), "");
});

test("a token or color that could break out of the style element is dropped", () => {
  const css = themeCss({
    light: {
      background: "#fff}</style><script>alert(1)</script>",
      "bad name": "#fff",
      border: "#e5e2d8",
    },
  });
  assert.equal(css, "html:not(.dark){--border:#e5e2d8}");
});

test("a person's own custom theme, added later with the same weight, still wins", () => {
  assert.doesNotMatch(themeCss({ light: { background: "#ffffff" }, dark: { background: "#000000" } }), /:root/);
});
