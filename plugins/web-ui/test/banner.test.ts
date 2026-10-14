import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ANNOUNCEMENT_LEVEL_LABEL,
  announcementActive,
  archiveRows,
  parseAnnouncementsDoc,
  postDismissAnnouncement,
  shortDate,
  unseenRows,
  visibleBannerRows,
  type Announcement,
  type BannerState,
  type FetchLike,
  type ResponseLike,
} from "../src/banner.ts";

const NOW = new Date("2026-09-02T12:00:00");

function ann(id: string, level: Announcement["level"], startsAt: string, endsAt: string | null = null): Announcement {
  return { id, level, title: `标题-${id}`, body: `正文-${id}`, startsAt, endsAt };
}

function res(ok: boolean, status: number): ResponseLike {
  return { ok, status, json: async () => ({}) };
}

test("level labels cover the three announcement levels in Chinese", () => {
  assert.equal(ANNOUNCEMENT_LEVEL_LABEL.notice, "Notice");
  assert.equal(ANNOUNCEMENT_LEVEL_LABEL.maintenance, "Maintenance");
  assert.equal(ANNOUNCEMENT_LEVEL_LABEL.incident, "Incident");
});

test("parseAnnouncementsDoc accepts the wire contract and drops malformed rows", () => {
  const doc = parseAnnouncementsDoc({
    announcements: [
      { id: "a1", level: "incident", title: "故障", body: "x", startsAt: "2026-09-01T00:00:00", endsAt: null },
      { id: "a2", level: "weird", title: "未知级别", startsAt: "2026-09-01T00:00:00" },
      { title: "缺 id" },
      null,
    ],
    dismissed: ["d1", 42],
  });
  assert.ok(doc);
  assert.equal(doc.announcements.length, 2);
  assert.equal(doc.announcements[1]!.level, "notice");
  assert.deepEqual(doc.dismissed, ["d1"]);
  assert.equal(parseAnnouncementsDoc(null), null);
  assert.equal(parseAnnouncementsDoc({}), null);
  assert.equal(parseAnnouncementsDoc({ announcements: "nope" }), null);
});

test("activity window: future starts hidden, past ends hidden, open or missing bounds active", () => {
  assert.equal(announcementActive(ann("a", "notice", "2026-09-02T13:00:00"), NOW), false);
  assert.equal(announcementActive(ann("a", "notice", "2026-09-02T11:00:00", "2026-09-02T11:30:00"), NOW), false);
  assert.equal(announcementActive(ann("a", "notice", "2026-09-02T11:00:00", "2026-09-02T13:00:00"), NOW), true);
  assert.equal(announcementActive(ann("a", "notice", ""), NOW), true);
  assert.equal(announcementActive(ann("a", "notice", "not-a-date", "also-bad"), NOW), true);
});

test("banner rows hide dismissed, locally hidden, and out-of-window announcements", () => {
  const state: BannerState = {
    doc: {
      announcements: [
        ann("live", "notice", "2026-09-01T00:00:00"),
        ann("gone", "notice", "2026-08-01T00:00:00", "2026-08-02T00:00:00"),
        ann("closed", "notice", "2026-09-01T00:00:00"),
        ann("local", "notice", "2026-09-01T00:00:00"),
      ],
      dismissed: ["closed"],
    },
    localHidden: ["local"],
    expanded: [],
  };
  assert.deepEqual(
    visibleBannerRows(state, NOW).map((a) => a.id),
    ["live"],
  );
});

test("archive holds everything not in the banner, newest first", () => {
  const state: BannerState = {
    doc: {
      announcements: [
        ann("old", "notice", "2026-08-01T00:00:00", "2026-08-01T01:00:00"),
        ann("live", "notice", "2026-09-02T00:00:00"),
        ann("dismissed", "notice", "2026-08-31T00:00:00"),
      ],
      dismissed: ["dismissed"],
    },
    localHidden: [],
    expanded: [],
  };
  assert.deepEqual(
    archiveRows(state, NOW).map((a) => a.id),
    ["dismissed", "old"],
  );
});

test("unseen rows are the banner rows whose ids the user has not seen", () => {
  const rows = [ann("s1", "notice", ""), ann("s2", "notice", "")];
  assert.deepEqual(
    unseenRows(rows, ["s1"]).map((a) => a.id),
    ["s2"],
  );
  assert.deepEqual(unseenRows(rows, ["s1", "s2"]), []);
});

test("shortDate renders month-day and blanks on unparseable input", () => {
  assert.equal(shortDate("2026-09-02T12:00:00"), "09-02");
  assert.equal(shortDate("nonsense"), "");
});

test("dismiss posts to the per-id endpoint and only records success", async () => {
  const calls: Array<{ url: string; method?: string }> = [];
  const okFetch: FetchLike = async (url, init) => {
    calls.push({ url, method: init?.method });
    return res(true, 204);
  };
  assert.equal(await postDismissAnnouncement("a b/1", okFetch), true);
  assert.deepEqual(calls, [{ url: "/api/announcements/a%20b%2F1/dismiss", method: "POST" }]);
  assert.equal(await postDismissAnnouncement("x", async () => res(false, 500)), false);
  assert.equal(
    await postDismissAnnouncement("x", async () => {
      throw new Error("offline");
    }),
    false,
  );
});
