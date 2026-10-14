import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../src/files.ts", import.meta.url), "utf8");

function fileRowSource(): string {
  const start = source.indexOf("function fileRow(");
  const end = source.indexOf("\nasync function trashFile", start);
  return source.slice(start, end);
}

test("Files moves a file to the recycle bin with DELETE", () => {
  assert.match(source, /api\(`\/api\/files\/\$\{encodeURIComponent\(f\.id\)\}`, \{ method: "DELETE" \}\)/);
  assert.match(source, /canTrash\?: boolean/);
  assert.match(source, /aria-label="Move to recycle bin"/);
});

test("Files restores a file with POST to the restore path", () => {
  assert.match(source, /api\(`\/api\/files\/\$\{encodeURIComponent\(f\.id\)\}\/restore`, \{ method: "POST" \}\)/);
});

test("Files lists the recycle bin from the trash path", () => {
  assert.match(source, /`\/api\/files\/trash\?\$\{q\.toString\(\)\}`/);
  assert.match(source, /The recycle bin is empty\./);
  assert.match(source, /"Back to files"/);
});

test("Files draws the recycle bin button only for canTrash and outside the link", () => {
  const row = fileRowSource();
  assert.match(row, /<a\s+class="list-row file-row"\s+href=\$\{contentUrl\}\s+target="_blank"/);
  assert.match(row, /f\.canTrash\s*\?\s*html`<button/);
  assert.equal(row.match(/<button/g)?.length, 1);
  const linkEnd = row.indexOf("</a>");
  assert.ok(linkEnd > 0);
  assert.ok(row.indexOf("<button") > linkEnd);
  assert.ok(row.indexOf("${content}") < linkEnd);
});

test("Files ignores recycle bin responses that arrive after a switch", () => {
  const start = source.indexOf("async function loadTrash(");
  const end = source.indexOf("async function setTrashView(", start);
  assert.match(source.slice(start, end), /const requestSeq = \+\+filesRequestSeq;/);
  assert.match(source.slice(start, end), /requestSeq !== filesRequestSeq/);
});

test("Files offers an explicit download link for a file that can be opened", () => {
  const row = fileRowSource();
  assert.match(
    row,
    /f\.openable\s*\? html`<a\s+class="icon-btn subtle compact"\s+href=\$\{contentUrl \+ "\?download=1"\}/,
  );
  assert.match(row, /aria-label="Download"/);
});
