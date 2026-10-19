import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const chat = readFileSync(new URL("../src/chat.ts", import.meta.url), "utf8");

test("in a shared conversation every named message is labeled, even when one person has spoken", () => {
  const rule = chat.match(/function updateSpeakerLabels[\s\S]*?\n {2}\}/)?.[0] ?? "";
  assert.match(
    rule,
    /if \(names\.size > 0 && chatState\.scopeId !== null && chatState\.scopeId !== `personal:\$\{appState\.me\?\.user\}`\)\n\s+chatState\.labelSpeakers = true;\n\s+chatState\.assistantSpeakerLabel = chatState\.labelSpeakers \? brandName\(\) : "";\n {2}\}$/,
  );
});
