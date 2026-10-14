import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (f: string): string => readFileSync(new URL(`../${f}`, import.meta.url), "utf8");
const sessions = read("src/sessions.ts");
const dialog = read("src/bring-into-project.ts");
const bridge = read("src/core-bridge.ts");
const server = read("server/index.ts");

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
