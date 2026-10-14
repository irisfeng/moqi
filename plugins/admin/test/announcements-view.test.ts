import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  ANNOUNCEMENT_LEVEL_LABELS,
  announcementDraft,
  announcementStatus,
  defaultAnnouncementWindow,
  takedownEndsAt,
} from "../ui/announcement-rules.ts";

const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const adminModule = readFileSync(new URL("../ui/admin.ts", import.meta.url), "utf8");

test("announcements view is registered in the console", () => {
  assert.match(html, /announcements: "Announcements"/);
  const sections = html.slice(html.indexOf("const SECTIONS = ["));
  const firstGroup = sections.slice(0, sections.indexOf("},"));
  assert.match(firstGroup, /"users",\s*"announcements"/);
  assert.match(html, /announcements: renderAnnouncements/);
  assert.match(adminModule, /export \* as announcements from "\.\/announcements\.ts";/);
});

test("draft requires a non-empty title", () => {
  assert.equal(
    announcementDraft("notice", "  ", "b", "2026-09-02T10:00", "2026-09-09T10:00").error,
    "A title is required.",
  );
});

test("draft rejects unparseable or inverted time windows", () => {
  assert.equal(
    announcementDraft("notice", "t", "b", "", "2026-09-09T10:00").error,
    "Enter a valid start time. Leave the end time empty for no end.",
  );
  assert.equal(
    announcementDraft("notice", "t", "b", "2026-09-09T10:00", "2026-09-02T10:00").error,
    "The end time must be later than the start time.",
  );
});

test("draft assembles the api payload", () => {
  const d = announcementDraft("maintenance", " Planned maintenance ", "Body", "2026-09-02T22:00", "2026-09-03T01:00");
  assert.ok(!("error" in d), "unexpected draft error");
  if ("error" in d) return;
  assert.deepEqual(Object.keys(d).sort(), ["body", "endsAt", "level", "startsAt", "title"]);
  assert.equal(d.title, "Planned maintenance");
  assert.equal(d.level, "maintenance");
  assert.ok(d.endsAt !== null && d.endsAt > d.startsAt);
});

test("status derives from the effective window", () => {
  const a = { startsAt: 100, endsAt: 200 };
  assert.equal(announcementStatus(a, 50), "scheduled");
  assert.equal(announcementStatus(a, 150), "active");
  assert.equal(announcementStatus(a, 250), "ended");
});

test("default window spans seven days from now", () => {
  const w = defaultAnnouncementWindow(new Date(2026, 8, 2, 9, 5));
  assert.equal(w.startsAt, "2026-09-02T09:05");
  assert.equal(w.endsAt, "2026-09-09T09:05");
});

test("takedown of a scheduled announcement ends right after it starts", () => {
  assert.equal(takedownEndsAt({ startsAt: 100 }, 50), 101);
  assert.equal(takedownEndsAt({ startsAt: 100 }, 150), 150);
});

test("level labels cover all three levels", () => {
  assert.deepEqual(Object.keys(ANNOUNCEMENT_LEVEL_LABELS).sort(), ["incident", "maintenance", "notice"]);
});

test("permanent notices accept an empty end and remain active", () => {
  const draft = announcementDraft("notice", "Guidelines", "Body", "2026-09-17T10:00", "");
  assert.equal(draft.endsAt, null);
  assert.equal(announcementStatus({ startsAt: 100, endsAt: null }, 50), "scheduled");
  assert.equal(announcementStatus({ startsAt: 100, endsAt: null }, 9999999999999), "active");
});

test("the form sends the pop-up choice and uploads images through the admin server", () => {
  const view = readFileSync(new URL("../ui/announcements.ts", import.meta.url), "utf8");
  assert.match(view, /const payload = \{ \.\.\.fields, popup \}/);
  assert.match(view, /popup = a\.popup === true/);
  assert.match(view, /s\.apiBase \+ "\/api\/announcement-images"/);
  assert.match(view, /accept="image\/png,image\/jpeg,image\/webp"/);
  assert.match(
    html,
    /governanceUI\.announcements\.announcements\(root, d, \{\s*api,\s*apiBase: API_BASE,\s*fileSha256,/,
  );
});
