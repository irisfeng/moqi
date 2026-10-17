import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (f: string): string => readFileSync(new URL(`../${f}`, import.meta.url), "utf8");
const sessions = read("src/sessions.ts");
const dialog = read("src/bring-into-project.ts");
const bridge = read("src/core-bridge.ts");
const server = read("server/index.ts");
const split = read("src/split.ts");

const fn = (src: string, name: string): string => {
  const body = src.match(new RegExp(`^(?:export )?(?:async )?function ${name}\\([\\s\\S]*?\\n\\}`, "m"))?.[0] ?? "";
  assert.ok(body, `${name} not found`);
  return body;
};

test("the menu offers Bring into project only on the person's own personal chats", () => {
  const gate = fn(sessions, "canBringIntoProject");
  assert.match(gate, /Boolean\(s\.id\)/, "unsaved chats cannot be copied");
  assert.match(gate, /s\.scopeId === personalScope/);
  const option = fn(sessions, "bringIntoProjectOption");
  assert.match(option, /if \(!canBringIntoProject\(s, personalScopeId\(\)\)\) return nothing;/);
  assert.match(option, /Bring into project…/);
  const menu = fn(sessions, "sessionMenuPopover");
  assert.match(menu, /\$\{bringIntoProjectOption\(s\)\}/);
});

test("the original links to its project copies through fork provenance", () => {
  const copies = fn(sessions, "projectCopiesOf");
  assert.match(copies, /candidate\.forkedFrom\?\.sessionId === s\.id/);
  assert.match(copies, /candidate\.scopeId !== s\.scopeId/);
  assert.match(fn(sessions, "bringIntoProjectOption"), /Open copy in/);
});

test("the dialog states what becomes visible and what stays private", () => {
  assert.match(dialog, /including tool output and attachments/);
  assert.match(dialog, /Every current and future member of the project will be able to see it/);
  assert.match(dialog, /Your personal memory is not carried over/);
  assert.match(dialog, /The original conversation stays private and unchanged/);
  assert.match(dialog, /context\.project \?/, "only projects the person belongs to are listed");
  assert.match(dialog, /forkSession\(session\.id, undefined, chosen\)/);
});

test("the target scope travels through the client and the relay", () => {
  assert.match(bridge, /targetScopeId\?: string/);
  assert.match(bridge, /\.\.\.\(targetScopeId !== undefined \? \{ targetScopeId \} : \{\}\)/);
  assert.match(server, /\.\.\.\(targetScopeId !== undefined \? \{ targetScopeId \} : \{\}\)/);
  assert.match(
    server,
    /if \(targetScopeId !== undefined && resolveIdentity\(req\)\?\.impersonator !== null\)\s*return json\(res, 403, \{ error: "impersonation_forbidden" \}\);/,
  );
});

test("the dialog keeps stable test ids for automated checks", () => {
  assert.match(fn(sessions, "bringIntoProjectOption"), /data-testid="bring-into-project-open"/);
  assert.match(dialog, /dialog\.dataset\.testid = "bring-into-project-dialog"/);
  for (const id of ["close", "loading", "option", "empty", "error", "cancel", "confirm"])
    assert.match(dialog, new RegExp(`data-testid="bring-into-project-${id}"`), id);
  assert.match(dialog, /data-testid="bring-into-project-option"\s+data-scope=\$\{project\.scopeId\}/);
});

test("a personal chat's header offers Bring into project first, through the same dialog as the menu", () => {
  const action = fn(sessions, "bringIntoProjectAction");
  assert.match(action, /if \(!s \|\| !canBringIntoProject\(s, personalScopeId\(\)\)\) return null;/);
  assert.match(action, /return \(\) => startBringIntoProject\(s\);/);
  assert.match(fn(sessions, "bringIntoProjectOption"), /startBringIntoProject\(s\);/);
  const items = fn(split, "sessionActionItems");
  assert.match(
    items,
    /const items: SessionAction\[\] = \[\];\s+const bringIntoProject = bringIntoProjectAction\(sessionId\);/,
  );
  assert.match(items, /label: "Bring into project…",\s+glyph: Folder,\s+cls: "split-tab-bring-into-project",/);
});

test("the header redraws once the person's scope is known, so a cold load still shows the button", () => {
  const notify = split.match(/^export function notifyPanesChanged\(\)[\s\S]*?\n\}/m)?.[0] ?? "";
  assert.match(notify, /if \(computeHeaderSignature\(\) === headerSignature && scope === headerScope\) return;/);
  assert.match(notify, /headerScope = scope;\s+refreshHeaders\(\);/);
});
