import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { ratingRows, upShare } from "../ui/ratings.ts";

const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const server = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");

test("the ratings view is registered and reads through the admin server", () => {
  assert.match(html, /ratings: "Ratings"/);
  assert.match(html, /ratings: renderRatings/);
  assert.match(html, /ratings: "ratings"/);
  assert.match(server, /"ratings",/);
});

test("rating rows show counts and the share of thumbs up, naming the unnamed", () => {
  assert.equal(upShare({ up: 2, down: 1 }), "67%");
  assert.equal(upShare({ up: 0, down: 0 }), "");
  assert.deepEqual(
    ratingRows(
      [
        { name: "model-a", up: 3, down: 1 },
        { name: "", up: 0, down: 2 },
      ],
      "Unknown model",
    ),
    [
      ["model-a", 3, 1, "75%"],
      ["Unknown model", 0, 2, "0%"],
    ],
  );
  assert.deepEqual(ratingRows(null, "Unknown model"), []);
});
