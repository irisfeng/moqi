import { test } from "node:test";
import assert from "node:assert/strict";
import { announcementIdOf, mentions, withAnnouncements } from "../src/notifications/notification-store.ts";

const conversation = {
  id: "entry:s1:0000000004",
  sessionId: "s1",
  threadRef: "web:s1",
  title: "Budget",
  at: 500,
  kind: "message" as const,
  unread: true,
  unreadCount: 2,
};
const page = { items: [conversation], unreadCount: 2, unreadThreads: 1, nextCursor: "next" };
const active = [
  { id: "a-new", title: "Office closed Friday", startsAt: 900 },
  { id: "a-old", title: "New skill pack", startsAt: 100 },
];

test("active announcements join the first page by time, unread until dismissed", () => {
  const merged = withAnnouncements(page, active, ["a-old"], true);
  assert.deepEqual(
    merged.items.map((item) => [item.id, item.kind, item.unread, item.unreadCount]),
    [
      ["announcement:a-new", "announcement", true, 1],
      [conversation.id, "message", true, 2],
      ["announcement:a-old", "announcement", false, 0],
    ],
  );
  assert.equal(merged.unreadCount, 3);
  assert.equal(merged.unreadThreads, 2);
  assert.equal(merged.nextCursor, "next");
});

test("later pages carry the announcement counts but not the rows", () => {
  const merged = withAnnouncements(page, active, [], false);
  assert.deepEqual(merged.items, [conversation]);
  assert.equal(merged.unreadThreads, 3);
});

test("an announcement row is told apart from a conversation event by its id", () => {
  assert.equal(announcementIdOf("announcement:a-new"), "a-new");
  assert.equal(announcementIdOf("entry:s1:0000000004"), null);
  assert.equal(announcementIdOf("delivery:announcement:x"), null);
});

test("a mention is the person's whole name, not the start of a longer Latin name", () => {
  assert.equal(mentions("@Ann please look", "Ann"), true);
  assert.equal(mentions("thanks @Ann.", "Ann"), true);
  assert.equal(mentions("@Anna please look", "Ann"), false);
  assert.equal(mentions("@Anna and @Ann", "Ann"), true);
  assert.equal(mentions("@王伟请看", "王伟"), true, "Chinese names have no word boundary");
  assert.equal(mentions("no tag here", "Ann"), false);
});
