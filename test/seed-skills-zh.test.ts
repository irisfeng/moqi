import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import test from "node:test";

const root = new URL("..", import.meta.url).pathname;
const upstream = join(root, "skills-seed");
const chinese = join(root, "deploy/layers/qm-cn/seed/skills-zh");

function files(dir: string): string[] {
  return readdirSync(dir)
    .flatMap((entry) => {
      const path = join(dir, entry);
      return statSync(path).isDirectory() ? files(path) : [path];
    })
    .sort();
}

const translatedFrom = JSON.parse(
  readFileSync(join(root, "deploy/layers/qm-cn/seed/skills-zh.upstream.json"), "utf8"),
) as Record<string, string>;
const sha256 = (path: string): string => createHash("sha256").update(readFileSync(path)).digest("hex");

const nameOf = (path: string): string => /^name:\s*(.+)$/m.exec(readFileSync(path, "utf8"))?.[1]?.trim() ?? "";

for (const skill of readdirSync(chinese).sort()) {
  test(`the Chinese ${skill} seed skill still mirrors upstream's`, () => {
    const mine = files(join(chinese, skill)).map((path) => relative(join(chinese, skill), path));
    const theirs = files(join(upstream, skill)).map((path) => relative(join(upstream, skill), path));
    assert.deepEqual(mine, theirs, "the same files as upstream's seed skill; an upstream change needs a translation");
    assert.equal(nameOf(join(chinese, skill, "SKILL.md")), nameOf(join(upstream, skill, "SKILL.md")));
    for (const path of mine.filter((file) => !file.endsWith(".md")))
      assert.ok(
        readFileSync(join(chinese, skill, path)).equals(readFileSync(join(upstream, skill, path))),
        `${skill}/${path} is copied unchanged from upstream`,
      );
  });
}

test("every translated Markdown file was translated from upstream's current text", () => {
  const translated = files(chinese)
    .filter((path) => path.endsWith(".md"))
    .map((path) => relative(chinese, path));
  assert.deepEqual(Object.keys(translatedFrom).sort(), translated);
  for (const path of translated)
    assert.equal(
      sha256(join(upstream, path)),
      translatedFrom[path],
      `upstream changed ${path}; update the translation, then its hash in skills-zh.upstream.json`,
    );
});
