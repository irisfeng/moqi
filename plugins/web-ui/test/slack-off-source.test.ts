import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { markDesktopOff, markSlackOff } from "../../chassis/src/branding.ts";

function read(name: string): string {
  return readFileSync(new URL(`../src/${name}`, import.meta.url), "utf8");
}

function body(source: string, header: string): string {
  const start = source.indexOf(header);
  assert.notEqual(start, -1, `${header} is missing`);
  const lineStart = source.lastIndexOf("\n", start) + 1;
  const indent = /^ */.exec(source.slice(lineStart))![0];
  const end = source.indexOf(`\n${indent}}`, start);
  assert.notEqual(end, -1, `${header} has no end`);
  return source.slice(start, end);
}

test("markSlackOff marks the opening html tag and keeps its attributes", () => {
  const page = '<!doctype html><html lang="en" class="dark"><head></head><body><html-note></html-note></body></html>';
  assert.equal(
    markSlackOff(page, true),
    '<!doctype html><html data-slack="off" lang="en" class="dark"><head></head><body><html-note></html-note></body></html>',
  );
  assert.equal(markSlackOff("<html><head></head></html>", true), '<html data-slack="off"><head></head></html>');
});

test("markSlackOff leaves the page byte for byte the same when the switch is off", () => {
  const page = '<!doctype html><html lang="en"><head></head><body></body></html>';
  assert.equal(markSlackOff(page, false), page);
});

test("the web UI server passes its page through markSlackOff on QM_SLACK", () => {
  const server = readFileSync(new URL("../server/index.ts", import.meta.url), "utf8");
  assert.match(server, /markSlackOff\(branded, process\.env\.QM_SLACK === "off"\)/);
});

test("slackOff reads the data-slack flag on the document element", () => {
  assert.match(
    read("ui.ts"),
    /export function slackOff\(\): boolean \{\s*return document\.documentElement\.dataset\.slack === "off";/,
  );
});

test("Settings hides the sidebar conversations row and the Slack account block", () => {
  const pane = body(read("settings.ts"), "function settingsPane()");
  assert.match(pane, /slackOff\(\) \? nothing : sidebarSurfaceRow\(\)/);
  assert.match(pane, /slackOff\(\)\s*\? nothing\s*: html`<div class="settings-row settings-slack-account">/);
});

test("onboarding skips the Slack workspace check, the admin Slack card and the Slack account row", () => {
  const source = read("onboarding-welcome.ts");
  assert.match(body(source, "private async refreshWorkspace()"), /slackOff\(\) \|\|/);
  assert.match(
    body(source, "protected render()"),
    /!slackOff\(\) && !\["apps", "slack-account"\]\.includes\(this\.widget\)/,
  );
  assert.match(source, /this\.workspaceConnected && this\.widget !== "apps"/);
});

test("the connectors page drops the Slack card", () => {
  assert.match(body(read("connectors.ts"), "function drawConnectors()"), /!\(slackOff\(\) && id === "slack"\)/);
});

test("the chat does not draw the Add QM to Slack card or a Slack connector card", () => {
  assert.match(
    body(read("chat.ts"), "function connectorWidget("),
    /slackOff\(\) && \(link\.provider === "slack-bot" \|\| link\.provider === "slack"\)\) return html``/,
  );
});

test("the Chats surface filter drops the Slack option", () => {
  assert.match(
    body(read("sessions.ts"), "export function drawChatsPage()"),
    /!\(slackOff\(\) && option\.value === "slack"\)/,
  );
});

test("the inbox drops the Slack default view", () => {
  const source = read("inbox.ts");
  assert.match(body(source, "function defaultViews()"), /!\(slackOff\(\) && view\.id === "slack"\)/);
  assert.match(body(source, "function isInboxViewId("), /defaultViews\(\)/);
  assert.match(body(source, "function inboxViewSegment("), /defaultViews\(\)/);
});

test("a project hides the Slack channel link and unlink form", () => {
  assert.match(
    body(read("contexts.ts"), "function detailTpl("),
    /c\.project && !slackOff\(\) \? projectSlackSection\(c\)/,
  );
});

test("a loop offers no Slack events ingestion source", () => {
  assert.match(body(read("loops.ts"), "function ingestionTpl("), /!\(slackOff\(\) && kind === "slack"\)/);
});

test("the webhook form drops the Slack scheme", () => {
  assert.match(body(read("webhooks.ts"), "function webhookForm()"), /scheme\.value === "slack"/);
  assert.match(body(read("webhooks.ts"), "function webhookForm()"), /slackOff\(\)/);
});

test("markDesktopOff marks the page alongside the Slack flag, and leaves it unchanged when off", () => {
  const page = '<!doctype html><html lang="en"><head></head></html>';
  assert.equal(
    markDesktopOff(markSlackOff(page, true), true),
    '<!doctype html><html data-desktop="off" data-slack="off" lang="en"><head></head></html>',
  );
  assert.equal(markDesktopOff(page, false), page);
});

test("the web UI server marks the page on QM_DESKTOP, and Settings then drops the Mac download row", () => {
  const server = readFileSync(new URL("../server/index.ts", import.meta.url), "utf8");
  assert.match(
    server,
    /markDesktopOff\(markSlackOff\(branded, process\.env\.QM_SLACK === "off"\), process\.env\.QM_DESKTOP === "off"\)/,
  );
  assert.match(
    read("ui.ts"),
    /export function desktopOff\(\): boolean \{\s*return document\.documentElement\.dataset\.desktop === "off";/,
  );
  assert.match(body(read("settings.ts"), "function settingsPane()"), /desktopOff\(\) \? nothing : desktopRow\(\)/);
});
