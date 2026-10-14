import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const layer = fileURLToPath(new URL("../deploy/layers/qm-cn/", import.meta.url));
const script = join(layer, "scripts/stamp-product-version.py");
const version = readFileSync(join(layer, "VERSION"), "utf8").trim();
const page = fileURLToPath(new URL("../plugins/web-ui/index.html", import.meta.url));

function scratch(t: { after: (fn: () => void) => void }, prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("the changelog carries notes for the current version", () => {
  const changelog = readFileSync(join(layer, "deploy/CHANGELOG.md"), "utf8");
  assert.match(changelog, new RegExp(`^## ${version.replaceAll(".", "\\.")}(?![\\w.-])`, "m"));
});

test("the web page is stamped with the version and only this version's notes, once", (t) => {
  const target = join(scratch(t, "version-stamp-"), "index.html");
  copyFileSync(page, target);
  execFileSync("python3", ["-I", script, target]);
  const html = readFileSync(target, "utf8");
  assert.match(html, new RegExp(`<meta name="coworker-product-version" content="${version.replaceAll(".", "\\.")}">`));
  const raw = html.match(/<script type="application\/json" id="coworker-release-notes">([^<]*)<\/script>/)?.[1];
  assert.ok(raw);
  const release = JSON.parse(raw) as { version: string; notes: string; history: { version: string; notes: string }[] };
  assert.equal(release.version, version);
  assert.ok(release.notes.trim());
  assert.doesNotMatch(release.notes, /^## /m, "the notes stop before the next version's heading");
  const changelog = readFileSync(join(layer, "deploy/CHANGELOG.md"), "utf8");
  const headings = changelog
    .split(/^## /m)
    .slice(1)
    .filter((part) => part.slice(part.indexOf("\n")).trim())
    .map((part) => part.match(/^\d+\.\d+\.[\dx]+(?![\w.-])/)?.[0])
    .filter((heading) => heading !== undefined);
  assert.deepEqual(
    release.history.map((past) => past.version),
    headings.slice(headings.indexOf(version) + 1),
    "every older version follows, newest first",
  );
  for (const past of release.history) {
    assert.ok(past.notes.trim());
    assert.doesNotMatch(past.notes, /^## /m);
  }
  execFileSync("python3", ["-I", script, target]);
  assert.equal(readFileSync(target, "utf8"), html, "stamping again changes nothing");
  execFileSync("python3", ["-I", script, "--check", target]);
});

test("a version without release notes cannot be stamped, even beside a longer version's heading", (t) => {
  const copy = scratch(t, "version-layer-");
  mkdirSync(join(copy, "scripts"));
  mkdirSync(join(copy, "deploy"));
  copyFileSync(script, join(copy, "scripts/stamp-product-version.py"));
  writeFileSync(join(copy, "VERSION"), "9.9.9\n");
  writeFileSync(join(copy, "deploy/CHANGELOG.md"), "# Log\n\n## 9.9.9.1\n\n- not this one\n\n## 9.9.8\n\n- older\n");
  const target = join(copy, "index.html");
  copyFileSync(page, target);
  const run = spawnSync("python3", ["-I", join(copy, "scripts/stamp-product-version.py"), target], {
    encoding: "utf8",
  });
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /No release notes for v9\.9\.9/);
  assert.equal(readFileSync(target, "utf8"), readFileSync(page, "utf8"));
});

test("history holds only the versions below the current one, skipping empty sections", (t) => {
  const copy = scratch(t, "version-history-");
  mkdirSync(join(copy, "scripts"));
  mkdirSync(join(copy, "deploy"));
  copyFileSync(script, join(copy, "scripts/stamp-product-version.py"));
  writeFileSync(join(copy, "VERSION"), "9.9.9\n");
  writeFileSync(
    join(copy, "deploy/CHANGELOG.md"),
    "# Log\n\nIntro.\n\n## 9.9.10\n\n- draft\n\n## 9.9.9\n\n- this\n\n## 9.9.8（热修复）\n\n### 修复\n\n- older <b>\n\n## 说明\n\n- not a version\n\n## 9.9.7\n\n## 9.8.x\n\n- oldest\n",
  );
  const target = join(copy, "index.html");
  copyFileSync(page, target);
  execFileSync("python3", ["-I", join(copy, "scripts/stamp-product-version.py"), target]);
  const raw = readFileSync(target, "utf8").match(/id="coworker-release-notes">([^<]*)<\/script>/)?.[1];
  assert.ok(raw);
  assert.deepEqual(JSON.parse(raw), {
    version: "9.9.9",
    notes: "- this",
    history: [
      { version: "9.9.8", notes: "### 修复\n\n- older <b>" },
      { version: "9.8.x", notes: "- oldest" },
    ],
  });
});

const themesFile = join(layer, "deploy/themes.json");

function themedLayer(
  t: { after: (fn: () => void) => void },
  themes: string | null,
): { script: string; target: string } {
  const copy = scratch(t, "version-themes-");
  mkdirSync(join(copy, "scripts"));
  mkdirSync(join(copy, "deploy"));
  copyFileSync(script, join(copy, "scripts/stamp-product-version.py"));
  writeFileSync(join(copy, "VERSION"), "9.9.9\n");
  writeFileSync(join(copy, "deploy/CHANGELOG.md"), "# Log\n\n## 9.9.9\n\n- this\n");
  if (themes !== null) writeFileSync(join(copy, "deploy/themes.json"), themes);
  const target = join(copy, "index.html");
  copyFileSync(page, target);
  return { script: join(copy, "scripts/stamp-product-version.py"), target };
}

function themeBlocks(html: string): string[] {
  return [...html.matchAll(/<script type="application\/json" id="coworker-themes">([^<]*)<\/script>/g)].map(
    (match) => match[1] ?? "",
  );
}

const sampleTheme = (id: string, color: string) => ({
  id,
  name: "样例",
  light: { background: color, foreground: "#111111", cta: "#1c6a8a" },
  dark: { background: "#161719", foreground: "#ececed", cta: "#1f6f8f" },
});

test("the web page carries the five palettes in order, once, even when stamped again", (t) => {
  const target = join(scratch(t, "version-themes-real-"), "index.html");
  copyFileSync(page, target);
  execFileSync("python3", ["-I", script, target]);
  execFileSync("python3", ["-I", script, target]);
  const stray = '<script type="application/json" id="coworker-themes">{"themes":[]}</script>';
  writeFileSync(target, readFileSync(target, "utf8").replace("</title>", `</title>\n${stray}`));
  execFileSync("python3", ["-I", script, target]);
  const blocks = themeBlocks(readFileSync(target, "utf8"));
  assert.equal(blocks.length, 1);
  const stamped = JSON.parse(blocks[0] ?? "") as { themes: { id: string }[] };
  assert.deepEqual(
    stamped.themes.map((theme) => theme.id),
    ["paper", "mist", "celadon", "ivory", "ink"],
  );
  assert.deepEqual(stamped, JSON.parse(readFileSync(themesFile, "utf8")));
});

test("a palette with a bad id, name, token or colour is refused and the page is left alone", (t) => {
  const bad = [
    sampleTheme("Paper", "#ffffff"),
    { ...sampleTheme("paper", "#ffffff"), name: "" },
    { ...sampleTheme("paper", "#ffffff"), name: "一二三四五六七八九十一二三" },
    sampleTheme("paper", "oklch(1 0 0)"),
    { ...sampleTheme("paper", "#ffffff"), light: { Background: "#ffffff" } },
    { ...sampleTheme("paper", "#ffffff"), dark: undefined },
  ];
  for (const theme of bad) {
    const copy = themedLayer(t, JSON.stringify({ themes: [theme] }));
    const run = spawnSync("python3", ["-I", copy.script, copy.target], { encoding: "utf8" });
    assert.notEqual(run.status, 0, JSON.stringify(theme));
    assert.equal(readFileSync(copy.target, "utf8"), readFileSync(page, "utf8"));
  }
  const twice = themedLayer(
    t,
    JSON.stringify({ themes: [sampleTheme("paper", "#ffffff"), sampleTheme("paper", "#eeeeee")] }),
  );
  const run = spawnSync("python3", ["-I", twice.script, twice.target], { encoding: "utf8" });
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /Duplicate theme id paper/);
});

test("a valid palette file is stamped, and without one the page gets no themes block", (t) => {
  const withThemes = themedLayer(t, JSON.stringify({ themes: [sampleTheme("paper", "#ffffff")] }));
  execFileSync("python3", ["-I", withThemes.script, withThemes.target]);
  const blocks = themeBlocks(readFileSync(withThemes.target, "utf8"));
  assert.equal(blocks.length, 1);
  assert.match(blocks[0] ?? "", /样例/);
  const without = themedLayer(t, null);
  execFileSync("python3", ["-I", without.script, without.target]);
  assert.doesNotMatch(readFileSync(without.target, "utf8"), /coworker-themes/);
});
