import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

function read(path: string): string {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

const page = read("public/index.html");

test("slackOff reads the data-slack flag on the document element", () => {
  assert.match(
    read("ui/shared.ts"),
    /export function slackOff\(\): boolean \{\s*return document\.documentElement\.dataset\.slack === "off";/,
  );
  assert.match(
    page,
    /function slackOff\(\) \{\s+return globalThis\.document\?\.documentElement\?\.dataset\.slack === "off";/,
  );
});

test("the admin server passes its page through markSlackOff on QM_SLACK", () => {
  assert.match(
    read("src/index.ts"),
    /markSlackOff\(\s*injectBranding\(BASE_HTML, branding, \{ titleSuffix: "Admin" \}\),\s*process\.env\.QM_SLACK === "off",\s*\)/,
  );
});

test("the nav drops the Slack and Slack messages views", () => {
  const tabs = page.slice(page.indexOf("function renderTabs()"), page.indexOf("function stateToUrl("));
  assert.match(tabs, /slackOff\(\) && \(v === "slack" \|\| v === "slack-settings"\)/);
});

test("the Slack installation card, the external audience card and its status are hidden by CSS", () => {
  assert.match(page, /html\[data-slack="off"\] #card-slack-installation,/);
  assert.match(page, /html\[data-slack="off"\] #card-external-slack,/);
  assert.match(page, /html\[data-slack="off"\] #governance-status-audience \{\s*display: none !important;/);
});

test("onboarding drops the Slack app step and renumbers the rest", () => {
  const source = read("ui/onboarding.ts");
  assert.match(source, /slackOff\(\) \? \["model", "oauth"\] : \["model", "slack", "oauth"\]/);
  assert.match(source, /\? \["1\. Model provider", "2\. OAuth apps"\]/);
  assert.match(source, /<h2>\$\{titles\[i\]\}<\/h2>/);
});

test("the users page drops the Slack email allowlist row", () => {
  assert.match(read("ui/users.ts"), /\.\.\.\(slackOff\(\)\s+\? \[\]\s+: \[\s+\[\s+"Slack email allowlist",/);
});

test("the cron editor drops the slack destination unless the cron already uses it", () => {
  assert.match(
    read("ui/artifacts.ts"),
    /slackOff\(\) && cron\.destination\?\.type !== "slack" \? nothing : html`<option value="slack"/,
  );
  assert.equal(
    (read("ui/artifacts.ts").match(/\|\| \(slackOff\(\) && cron\.destination\?\.type !== "slack"\)/g) ?? []).length,
    2,
    "a new or reset cron draft defaults to principal when Slack is off",
  );
});

test("the feature flag list drops the Slack loading indicator", () => {
  assert.match(read("ui/settings-flags.ts"), /slackOff\(\) \? nothing : html`<option value="slack_loading_indicator">/);
});

test("a direct link to a hidden Slack view falls back to the default view", () => {
  assert.match(
    read("public/index.html"),
    /function route\(\) \{\s+const st = urlToState\(\);\s+if \(slackOff\(\) && \(st\.view === "slack" \|\| st\.view === "slack-settings"\)\) st\.view = DEFAULT_VIEW;/,
  );
});
