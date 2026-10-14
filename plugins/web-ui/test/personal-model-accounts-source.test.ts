import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const settings = readFileSync(new URL("../src/settings.ts", import.meta.url), "utf8");
const server = readFileSync(new URL("../server/index.ts", import.meta.url), "utf8");

test("the AI access row is hidden when core does not offer personal AI accounts", () => {
  assert.match(server, /personalModelAccounts: parsed\.offered !== false,/);
  assert.match(settings, /\$\{appState\.me\?\.personalModelAccounts === false \? nothing : aiAccountsRow\(\)\}/);
  assert.equal(settings.match(/aiAccountsRow\(\)/g)?.length, 2, "the row renders from one place, behind the switch");
});
