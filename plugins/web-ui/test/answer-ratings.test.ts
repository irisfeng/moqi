import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { nextRating, ratingTargetId } from "../src/answer-ratings.ts";

const read = (path: string): string => readFileSync(new URL(path, import.meta.url), "utf8");

test("clicking the same thumb again removes the rating, the other one switches it", () => {
  assert.equal(nextRating(undefined, "up"), "up");
  assert.equal(nextRating("up", "up"), null);
  assert.equal(nextRating("up", "down"), "down");
});

test("a message and a file in it are rated separately", () => {
  assert.equal(ratingTargetId("s1", 4), "entry:s1:4");
  assert.equal(ratingTargetId("s1", 4, "f9"), "file:s1:f9");
});

test("ratings are offered on assistant messages and delivered files, never while viewing as someone else", () => {
  const chat = read("../src/chat.ts");
  assert.match(chat, /message\.role === "assistant" && rateable\(\) && chatState\.sessionId/);
  assert.match(chat, /ratingButtons\(sessionId, seq, redrawTranscript, f\.artifactId\)/);
  assert.match(chat, /return !isReadOnlySlackView\(\) && !appState\.me\?\.impersonatedBy;/);
  assert.match(chat, /hit\.ratings === ratingsVersion\(\)/);
  const server = read("../server/index.ts");
  const put = server.slice(server.indexOf('path: "/api/ratings",\n    handle: async ({ req, res, user })'));
  assert.match(put.slice(0, 300), /impersonation_forbidden/);
});

test("a given rating stays on the answer as a chip that removes it, in the same button so focus stays", () => {
  const ratings = read("../src/answer-ratings.ts");
  assert.match(ratings, /class=\$\{given \? `msg-rated \$\{value\}` : "msg-copy"\}/);
  assert.match(ratings, /@click=\$\{\(\) => void rate\(sessionId, seq, fileId, value, redraw\)\}/);
  assert.equal(ratings.match(/return html`\$\{button\(/g)?.length, 1);
  const css = read("../src/shell.css");
  assert.match(css, /\.message-meta:has\(\.msg-rated\) \{\n {2}opacity: 1;\n {2}pointer-events: auto;/);
  assert.match(
    css,
    /@media \(hover: hover\) \{\n {2}\.message-meta > \* \{\n {4}transition: opacity 0\.12s ease;\n {2}\}\n {2}\.message-row:not\(:hover\) \.message-meta:not\(:focus-within\) > :not\(\.msg-rated\) \{/,
  );
});
