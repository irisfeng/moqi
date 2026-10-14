import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { injectBranding } from "../../chassis/src/branding.ts";

const read = (path: string): string => readFileSync(new URL(path, import.meta.url), "utf8");
const MARK = "https://cdn.example.com/mark.svg";

test("a configured mark image becomes the browser tab icon, replacing the built-in one", () => {
  const withIcon = '<html><head><link rel="icon" href="/favicon.svg" /></head><body></body></html>';
  const replaced = injectBranding(withIcon, { markUrl: MARK });
  assert.match(replaced, /<link rel="icon" href="https:\/\/cdn\.example\.com\/mark\.svg" \/>/);
  assert.doesNotMatch(replaced, /favicon\.svg/);
  assert.equal(replaced.match(/rel="icon"/g)?.length, 1);

  const withoutIcon = "<html><head></head><body></body></html>";
  assert.match(
    injectBranding(withoutIcon, { markUrl: MARK }),
    /<link rel="icon" href="https:\/\/cdn\.example\.com\/mark\.svg" \/><\/head>/,
  );
  assert.equal(injectBranding(withIcon, { selfLabel: "Moqi" }), withIcon, "no mark image leaves the icon alone");
  assert.equal(injectBranding(withIcon, { markUrl: "http://cdn.example.com/mark.svg" }), withIcon);
  const kept = injectBranding(withIcon, { markUrl: MARK }, { keepIcon: true });
  assert.match(kept, /<link rel="icon" href="\/favicon\.svg" \/>/, "an operator's own favicon setting wins");
  assert.equal(kept.match(/rel="icon"/g)?.length, 1);
  const twoIcons =
    '<html><head><link rel="icon" href="/a.svg" /><link rel="icon" href="/b.png" /></head><body></body></html>';
  assert.equal(injectBranding(twoIcons, { markUrl: MARK }).match(/rel="icon"/g)?.length, 1);
});

test("no surface names the product by a fixed word any more", () => {
  for (const file of ["../src/banner.ts", "../src/announcement-reader.ts"]) {
    const source = read(file);
    assert.doesNotMatch(source, /COWORKER/, file);
    assert.match(source, /\$\{brandName\(\)\}/, file);
  }
  const portal = read("../../portal/src/index.ts");
  assert.equal(portal.match(/· \$\{escapeHtml\(brandLabel\)\}<\/title>/g)?.length, 2);
  assert.doesNotMatch(portal, /· Portal<\/title>/);
  assert.match(portal, /typeof body\.branding\?\.selfLabel === "string"/);
});
