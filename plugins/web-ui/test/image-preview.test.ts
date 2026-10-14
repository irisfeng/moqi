import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { imagePosition, stepImage } from "../src/image-preview.ts";

const read = (path: string): string => readFileSync(new URL(path, import.meta.url), "utf8");
const preview = read("../src/image-preview.ts");

test("stepping through images wraps at both ends", () => {
  assert.equal(stepImage(0, 8, 1), 1);
  assert.equal(stepImage(7, 8, 1), 0);
  assert.equal(stepImage(0, 8, -1), 7);
  assert.equal(stepImage(3, 1, 1), 0);
  assert.equal(stepImage(0, 0, 1), 0);
});

test("the position reads as a count from one", () => {
  assert.equal(imagePosition(2, 8), "3 of 8");
});

test("the preview offers arrow keys and on-screen controls, and only when there is more than one image", () => {
  assert.match(preview, /event\.key !== "ArrowLeft" && event\.key !== "ArrowRight"/);
  assert.match(preview, /aria-label="Previous image"/);
  assert.match(preview, /aria-label="Next image"/);
  assert.equal(preview.match(/images\.length > 1/g)?.length, 3);
});

test("the conversation offers only the images already drawn for this person", () => {
  assert.match(preview, /querySelectorAll<HTMLAnchorElement>\("a\.file-image"\)/);
  const chat = read("../src/chat.ts");
  assert.equal(chat.match(/@click=\$\{previewImage\}/g)?.length, 2);
  assert.match(chat, /previewLinkedImage\(event\.currentTarget as HTMLAnchorElement, ctx\.container\(\)\)/);
  assert.match(
    chat,
    /if \(!isPlainLeftClick\(event\)\) return;\n\s+event\.preventDefault\(\);\n\s+unpeekAttachment\(\);/,
  );
});
