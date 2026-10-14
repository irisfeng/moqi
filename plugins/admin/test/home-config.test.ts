import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { homeSummary, homeTemplate, parseHomeDraft } from "../ui/home-config.ts";

const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const server = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");

test("the home page view is registered and reads through the admin server", () => {
  assert.match(html, /home: "Home page"/);
  assert.match(html, /home: renderHome/);
  assert.match(html, /home: "webui-home"/);
  assert.match(server, /"webui-home",/);
});

test("the template shows all six featured scenes and passes its own check", () => {
  const template = homeTemplate();
  assert.deepEqual(homeSummary(template), { scenes: 6, tips: 6, roles: 0 });
  assert.deepEqual(parseHomeDraft(JSON.stringify(template)).home, template);
});

test("a draft that the core would refuse is refused before saving", () => {
  assert.equal(parseHomeDraft("{").error, "The configuration is not valid JSON.");
  assert.equal(parseHomeDraft("[]").error, "The configuration must be a JSON object.");
  assert.equal(parseHomeDraft("{}").error, "The configuration needs a welcome section.");
  assert.equal(parseHomeDraft('{"welcome":{},"tips":{}}').error, "Tips must be a list.");
});

test("the summary counts only active tips and known scenes", () => {
  const home = {
    welcome: { roles: [{ id: "sales" }] },
    tips: [
      { id: "W01", status: "active" },
      { id: "W11", status: "deferred" },
      { id: "other", status: "active" },
    ],
  };
  assert.deepEqual(homeSummary(home), { scenes: 1, tips: 2, roles: 1 });
});
