import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { JSDOM } from "jsdom";

const core = createServer((req: IncomingMessage, res) => {
  if ((req.url ?? "").startsWith("/v1/surface-config")) {
    res.writeHead(200, { "content-type": "application/json" });
    return void res.end(JSON.stringify({ branding: { accent: "#f0652f", mark: "Y", selfLabel: "QM" } }));
  }
  res.writeHead(200, { "content-type": "application/json" });
  res.end("{}");
});
await new Promise<void>((r) => core.listen(0, r));

process.env.CORE_API_URL = `http://localhost:${(core.address() as AddressInfo).port}`;
process.env.CORE_SIGNING_SECRET = "web-ui-branding-test";
process.env.WEB_UI_PRINCIPALS = "alice";

const distDir = join(dirname(fileURLToPath(import.meta.url)), "..", "dist-web");
const distIndex = join(distDir, "index.html");
if (!existsSync(distIndex)) {
  mkdirSync(distDir, { recursive: true });
  writeFileSync(
    distIndex,
    '<!doctype html><html><head><meta name="brand-self-label" content="Agent" /></head><body></body></html>',
  );
}

const { handler } = await import("../server/index.ts");
const surface = createServer((req, res) => void handler(req, res));
await new Promise<void>((r) => surface.listen(0, r));
const base = `http://localhost:${(surface.address() as AddressInfo).port}`;

test.after(() => {
  surface.close();
  core.close();
});

test("cold start: the FIRST shell render already carries accent, mark, and self-label", async () => {
  const r = await fetch(`${base}/`, { headers: { cookie: "webuiuser=alice" } });
  assert.equal(r.status, 200);
  const html = await r.text();
  assert.match(html, /--brand-accent:#f0652f/, "accent injected on the first render");
  assert.match(html, /--brand-mark:"Y"/, "mark injected on the first render");
  assert.match(
    html,
    /<meta name="brand-self-label" content="QM"\s*\/?>/,
    "self-label meta injected regardless of template formatting",
  );
});

test("the vite template carries the self-label anchor the server injects into", () => {
  const template = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  assert.match(template, /<meta name="brand-self-label" content="QM"\s*\/?>/);
});

test("the static favicon asset is the product's geometric mark", async () => {
  const { BRAND_MARK_SVG } = await import("../../chassis/src/branding.ts");
  const asset = readFileSync(new URL("../public/favicon.svg", import.meta.url), "utf8")
    .replace(/>\s+</g, "><")
    .trim();
  assert.equal(asset, BRAND_MARK_SVG);
});

test("the sidebar mark is drawn by the stylesheet, so the organisation's text mark or image shows", () => {
  const sidebar = readFileSync(new URL("../src/ui.ts", import.meta.url), "utf8");
  assert.match(sidebar, /<span class="brand-mark" aria-hidden="true"/);
  assert.equal(sidebar.match(/<span class="brand-mark-half"><\/span/g)?.length, 2, "two halves of one image");
  assert.doesNotMatch(sidebar, /BRAND_MARK_GEOMETRY/);
  const css = readFileSync(new URL("../src/shell.css", import.meta.url), "utf8");
  assert.match(css, /\.brand-mark::before \{\s*content: var\(--brand-mark\);/);
  assert.match(css, /\.brand-mark-half \{[^}]*var\(--brand-mark-image, url\("\.\/assets\/brand-mark\.svg"\)\)/);
  assert.match(
    css,
    /\.brand-mark-half:first-child \{\s*clip-path: polygon\(0 0, 42% 0, 42% 46%, 58% 46%, 58% 100%, 0 100%\);/,
  );
  assert.match(
    css,
    /\.brand-mark-half:last-child \{\s*clip-path: polygon\(42% 0, 100% 0, 100% 100%, 58% 100%, 58% 46%, 42% 46%\);/,
    "the halves meet along the tally's seam without a gap",
  );
  assert.match(
    css,
    /\.dark \.brand-mark-half \{\s*background-image: var\(--brand-mark-image, url\("\.\/assets\/brand-mark-dark\.svg"\)\);/,
    "dark mode swaps to the light-on-dark mark unless the organisation set its own image",
  );
  assert.match(css, /\.brand-mark::before \{[^}]*z-index: 1;/, "a text mark covers the image halves");
});

test("opening the sidebar assembles the mark from its two halves, only after a toggle and gently", () => {
  const css = readFileSync(new URL("../src/shell.css", import.meta.url), "utf8");
  const shell = readFileSync(new URL("../src/shell.ts", import.meta.url), "utf8");
  const setOpen =
    shell.match(/function setSidebarOpen\(open: boolean, moveFocus = true\): void \{[\s\S]*?\n\}/)?.[0] ?? "";
  assert.match(setOpen, /layout\?\.classList\.add\("brand-motion"\);/, "a toggle, not a page load, starts the motion");
  assert.match(
    css,
    /\.layout\.brand-motion:not\(\.sidebar-closed\) \.brand-lockup \.brand-mark-half:first-child \{\s*animation: brand-join-left 320ms/,
  );
  assert.match(
    css,
    /\.layout\.brand-motion:not\(\.sidebar-closed\) \.brand-lockup \.brand-mark-half:last-child \{\s*animation: brand-join-right 320ms/,
  );
  assert.match(
    css,
    /@media \(prefers-reduced-motion: reduce\) \{\s*\.layout\.brand-motion[^{]*\{\s*animation: brand-fade-in 160ms ease-out both;/,
    "reduced motion fades without moving",
  );
});

test("injectBranding rewrites the tab title with the escaped label when a suffix is given", async () => {
  const { injectBranding } = await import("../../chassis/src/branding.ts");
  const shell =
    '<!doctype html><html><head><title>QM · Web</title><meta name="brand-self-label" content="Agent" /></head><body></body></html>';
  const branded = injectBranding(shell, { selfLabel: "straylight" }, { titleSuffix: "· Web" });
  assert.match(branded, /<title>straylight · Web<\/title>/);
  assert.match(injectBranding(shell, {}, { titleSuffix: "· Web" }), /<title>QM · Web<\/title>/);
  const hostile = injectBranding(shell, { selfLabel: "x</title><script>alert(1)</script>" }, { titleSuffix: "· Web" });
  assert.doesNotMatch(hostile, /<script>/i);
  assert.match(hostile, /<title>x&lt;\/title&gt;/);
});

test("injectBranding refuses any CSS value that could escape the style block it writes", async () => {
  const { injectBranding } = await import("../../chassis/src/branding.ts");
  const shell = "<!doctype html><html><head></head><body></body></html>";
  assert.match(
    injectBranding(shell, { markUrl: "https://cdn.example.com/icon.png" }),
    /--brand-mark-image:url\("https:\/\/cdn\.example\.com\/icon\.png"\)/,
  );
  for (const markUrl of [
    "https://a/</style><script>alert(1)</script>",
    'https://a/");background:url("evil',
    "https://a/x;color:red",
    "https://a/}:root{color:red",
    "http://cdn.example.com/icon.png",
    "javascript:alert(1)",
  ]) {
    assert.equal(injectBranding(shell, { markUrl }), shell, `markUrl rejected: ${markUrl}`);
  }
  assert.equal(injectBranding(shell, { accent: "red;}</style><script>alert(1)</script>" }), shell);
  assert.equal(injectBranding(shell, { mark: '"}</style><script>alert(1)</script>' }), shell);
  assert.match(
    injectBranding(shell, { mark: "A " }),
    /--brand-mark:"A "/,
    "a two-char mark whose second char is a space is legal and still ships",
  );
});

test("brandName() reads the injected self-label and falls back to the product name", async () => {
  const ui = await import("../src/ui.ts");
  const brandName = (ui as { brandName?: () => string }).brandName;
  assert.equal(typeof brandName, "function", "ui.ts exports brandName()");
  const dom = new JSDOM('<head><meta name="brand-self-label" content="Acme"></head>');
  (globalThis as { document?: Document }).document = dom.window.document;
  try {
    assert.equal(brandName!(), "Acme");
  } finally {
    delete (globalThis as { document?: Document }).document;
  }
  assert.equal(brandName!(), "QM");
});

test("the installable-app metadata follows the brand: manifest link, touch icon, home-screen title", async () => {
  const { injectBranding } = await import("../../chassis/src/branding.ts");
  const shell =
    '<html><head><meta name="brand-self-label" content="QM" /><meta name="apple-mobile-web-app-title" content="QM" /></head></html>';
  const branded = injectBranding(shell, { selfLabel: 'Ship "Q"' });
  assert.match(branded, /<meta name="apple-mobile-web-app-title" content="Ship &quot;Q&quot;" \/>/);
  assert.match(injectBranding(shell, {}), /<meta name="apple-mobile-web-app-title" content="QM" \/>/);
});
