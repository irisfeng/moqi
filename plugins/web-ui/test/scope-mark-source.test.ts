import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const split = read("../src/split.ts");
const topbar = read("../src/session-scope.ts");
const chat = read("../src/chat.ts");
const css = read("../src/shell.css");

test("a pane header always says which scope it is in, and personal is labelled", () => {
  assert.match(split, /class="split-pane-crumb" data-scope=\$\{crumb \? "shared" : "personal"\}/);
  assert.match(split, /\$\{icon\(paneScopeGlyph\(panel\), 11\)\}<span dir="auto">\$\{crumb \?\? "Personal"\}<\/span>/);
});

test("a view opened from a chat or a pane carries the scope's icon with it", () => {
  assert.match(split, /crumb: paneCrumb\(panel\),\s*crumbGlyph: paneScopeGlyph\(panel\),/);
  assert.match(chat, /title: title \|\| "New chat",\s*crumb,\s*crumbGlyph,/);
  assert.match(topbar, /crumbGlyph: active\.crumbGlyph,/);
});

test("the session header marks personal chats and links a project marker to its project", () => {
  assert.match(topbar, /class="session-crumb" data-scope="personal">\$\{icon\(User, 12\)\}<span>Personal<\/span>/);
  assert.match(topbar, /class="session-crumb as-link"\s+data-scope="shared"/);
  assert.doesNotMatch(topbar, /if \(!o\.crumb\) return nothing/);
});

test("the two scopes look different and the marker stays on narrow screens", () => {
  const rule = (selector: RegExp) => css.match(selector)?.[1] ?? "";
  const base = rule(/\.session-crumb,\s*\.split-pane-crumb \{([^}]*)\}/);
  assert.match(base, /border: 1px solid var\(--border\)/);
  assert.match(base, /color: var\(--muted-foreground\)/);
  const shared = rule(
    /\.session-crumb\[data-scope="shared"\],\s*\.split-pane-crumb\[data-scope="shared"\] \{([^}]*)\}/,
  );
  assert.match(shared, /background: color-mix\(in srgb, var\(--cta\) \d+%, transparent\)/);
  assert.match(shared, /border-color: color-mix\(in srgb, var\(--cta\) \d+%, transparent\)/);
  assert.doesNotMatch(css, /\.session-crumb,\s*\.session-crumb-sep \{\s*display: none/);
  const cap = css.search(/\.session-crumb \{\s*max-width: 9em;\s*\}/);
  const media = css.lastIndexOf("@media (max-width: 860px) {", cap);
  const between = css.slice(media, cap);
  assert.ok(cap > css.search(/\.session-crumb,\s*\.split-pane-crumb \{/));
  assert.ok(media > 0 && (between.match(/\{/g) ?? []).length > (between.match(/\}/g) ?? []).length);
});
