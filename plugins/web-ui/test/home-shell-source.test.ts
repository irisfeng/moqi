import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const shell = readFileSync(new URL("../src/shell.ts", import.meta.url), "utf8");
const browse = readFileSync(new URL("../src/browse.ts", import.meta.url), "utf8");
const homeConfig = readFileSync(new URL("../src/home-config.ts", import.meta.url), "utf8");
const composer = readFileSync(new URL("../src/composer.ts", import.meta.url), "utf8");
const banner = readFileSync(new URL("../src/banner.ts", import.meta.url), "utf8");
const css = readFileSync(new URL("../src/home-shell.css", import.meta.url), "utf8");
const sessions = readFileSync(new URL("../src/sessions.ts", import.meta.url), "utf8");
const split = readFileSync(new URL("../src/split.ts", import.meta.url), "utf8");
const chat = readFileSync(new URL("../src/chat.ts", import.meta.url), "utf8");

test("the sidebar carries one lightweight growth entry instead of the retired tip card", () => {
  assert.match(shell, /currentGrowthSnapshot\(\)/);
  assert.match(shell, /growthSidebarEntry\(\)/);
  assert.match(shell, /submitGrowthAction\(\{ action: "skip", key: reminder\.key \}\)/);
  assert.match(shell, /startGrowthPolling\(\)/);
  assert.doesNotMatch(shell, /tipOfTheDay|TIP_CLOSED_KEY|home-tip-card/);
});

test("the sidebar lists only Home, Search and Browse above New chat; Browse holds every other page", () => {
  const quickNav = shell.match(/<nav class="nav quick-nav"[\s\S]*?<\/nav>/)?.[0] ?? "";
  for (const [view, glyph, label] of [
    ["contexts", "Folder", "Projects"],
    ["files", "Files", "Files"],
    ["docs", "BookOpen", "Department docs"],
    ["pm", "FolderKanban", "Project management"],
    ["crons", "Clock", "Crons"],
    ["guide", "Compass", "Guide"],
  ]) {
    assert.doesNotMatch(quickNav, new RegExp(`navRow\\("${view}"`), `${label} is reached through Browse`);
    assert.match(browse, new RegExp(`to\\("${view}", ${glyph}, "${label}"`));
  }
});

test("the growth entry folds to one line once onboarding is done and no challenge is due", () => {
  assert.match(
    shell,
    /if \(!reminder && snapshot\.onboarding\.status === "complete"\)\n\s+return html`<button class="home-growth-entry home-growth-compact" type="button" @click=\$\{\(\) => switchView\("guide"\)\}>/,
  );
  assert.match(css, /\.quick-nav \{\n {2}margin-bottom: 2px;\n {2}padding-bottom: 4px;\n\}/);
});

test("the guide is a view reachable from the growth entry and Browse, with open and try events", () => {
  assert.match(shell, /class="home-growth-open" type="button" @click=\$\{\(\) => switchView\("guide"\)\}/);
  assert.match(browse, /to\("guide", Compass, "Guide"/);
  assert.match(shell, /case "guide":\n {6}renderGuideSurface\(\);/);
  assert.match(shell, /reportHomeEvent\("guide_page_open", ""\)/);
  assert.match(shell, /reportHomeEvent\("guide_try_click", tip\.id\)/);
  assert.match(shell, /renderGuidePage\(webuiHome\(\) \?\? NEUTRAL_HOME, appState\.mainEl/);
});

test("async guide config refreshes the open page and route exits protect attachments", () => {
  assert.match(shell, /if \(config && appState\.me && appState\.currentView === "guide"\) renderGuideSurface\(false\)/);
  assert.match(
    shell,
    /if \(v !== "chats" && blockUnsentAttachmentNavigation\(\)\) return;\n {2}invalidateGuideActions\(\);/,
  );
  assert.match(shell, /cancelOpeningSession\(\)/);
});

test("chat navigation shares opening cancellation and protects every composer surface", () => {
  assert.match(shell, /allConversations\(\)/);
  assert.match(shell, /export function blockUnsentAttachmentNavigation\(/);
  assert.match(sessions, /export function cancelOpeningSession\(\): void/);
  assert.match(sessions, /\): Promise<void> \{\n {2}if \(blockUnsentAttachmentNavigation\(\)\) return;/);
  assert.match(sessions, /if \(blockUnsentAttachmentNavigation\(\[conv\]\)\) return;/);
  assert.match(split, /export function exitSplitIfActive\(\): boolean/);
  assert.match(split, /if \(blockUnsentAttachmentNavigation\(\)\) return false;/);
  assert.match(chat, /if \(blockUnsentAttachmentNavigation\(\[ctx\]\)\) return chatState\.threadRef \?\? "";/);
  assert.match(chat, /cancelOpeningSession\(\)/);
});

test("the home configuration is fetched once and shared by the shell, chat and composer", () => {
  assert.match(homeConfig, /homeLoading \?\?= loadWebuiHome\(\)/);
  assert.doesNotMatch(homeConfig, /export async function loadWebuiHome/);
  assert.match(shell, /ensureWebuiHome\(\)/);
  assert.match(chat, /webuiHome\(\)\?\.opener\.enabled === false/);
});

test("the composer placeholder defers to the configured teaching text", () => {
  assert.match(composer, /webuiHome\(\)\?\.composerPlaceholder\.trim\(\) \|\| "Ask anything"/);
});

test("the announcement banner mounts into the main column and refreshes on focus", () => {
  assert.match(shell, /id="home-banner"/);
  assert.match(shell, /mountAnnouncementBanner\(\{/);
  assert.match(banner, /\/api\/announcements\//);
  assert.match(banner, /announced_toast_open/);
  assert.match(banner, /window\.addEventListener\("focus", \(\) => void refreshAnnouncements\(\)\)/);
});

test("home-shell.css only derives colors from existing tokens", () => {
  assert.doesNotMatch(css, /#[0-9a-fA-F]{3,8}\b/);
  assert.doesNotMatch(css, /oklch\(|rgba?\(|hbla?\(/);
  assert.match(css, /var\(--announcement-incident\)/);
  assert.match(css, /var\(--muted-foreground\)/);
  assert.match(css, /var\(--border\)/);
});
