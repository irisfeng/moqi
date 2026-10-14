import assert from "node:assert/strict";
import { test } from "node:test";
import { Readable } from "node:stream";
import type { AddressInfo } from "node:net";
import { createServer } from "../src/api/server.ts";
import type { App } from "../src/api/app.ts";
import type { NotificationStore } from "../src/notifications/notification-store.ts";
import { mintPortalIdentity } from "../plugins/chassis/src/portal-identity.ts";
import { signedHeaders } from "../plugins/chassis/src/core-client.ts";
import { createMemoryMap } from "../src/persistence/durable-map.ts";
import { createMemoryAnnouncementStore } from "../src/announcements/announcement-store.ts";
import { personKey } from "../src/directory/person.ts";
import { createProjectJoinStore, type ProjectJoinRecord } from "../src/projects/project-join-store.ts";

const sourceSecret = "notification-source-test-secret".repeat(3);
const portalSecret = "notification-portal-test-secret".repeat(3);
const capabilitySecret = "notification-capability-test-secret".repeat(3);

test("notification routes enforce signed viewer identity and validate paging before touching storage", async () => {
  const viewers: string[] = [];
  const reads: string[] = [];
  const names: string[] = [];
  const streams: Readable[] = [];
  const app = {
    async openFileForViewer(id: string, viewer: string) {
      assert.equal(viewer, "alice");
      if (id !== "allowed") return null;
      const stream = Readable.from("fixture");
      streams.push(stream);
      return { name: "permitted.txt", stream };
    },
    async listSessions(viewer: string) {
      viewers.push(viewer);
      return [];
    },
    async directoryMember(viewer: string) {
      return { principalId: viewer, displayName: `Name of ${viewer}` };
    },
  } as unknown as App;
  const notifications: NotificationStore = {
    async prepare() {},
    async close() {},
    async list(viewer, _sessions, _cursor, viewerName) {
      viewers.push(viewer);
      names.push(viewerName ?? "");
      return { items: [], unreadCount: 0, unreadThreads: 0 };
    },
    async readAll(viewer) {
      reads.push(`${viewer}:all`);
      return 3;
    },
    async result(_viewer, _sessions, id) {
      return id === "known"
        ? {
            title: "result",
            threadRef: "web:test",
            at: 1,
            text: "delivered",
            files: [
              { id: "denied", name: "private-name" },
              { id: "allowed", name: "untrusted-name" },
            ],
          }
        : null;
    },
    async read(viewer, _sessions, id) {
      reads.push(`${viewer}:${id}`);
      return id === "known";
    },
  };
  const announcements = createMemoryAnnouncementStore(createMemoryMap<string[]>());
  const projectJoins = createProjectJoinStore(createMemoryMap<ProjectJoinRecord>());
  const server = createServer(app, {
    notifications,
    announcements,
    projectJoins,
    notificationPrefs: createMemoryMap<{ muteCompletions: boolean }>(),
    signingSecret: sourceSecret,
    portalIdentitySecret: portalSecret,
    capabilitySecret,
    requireSignedPortalIdentity: true,
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  let count = 0;
  async function request(path: string, method = "GET", viewer?: string, body?: string, imp?: string) {
    const target = `${path}${path.includes("?") ? "&" : "?"}_sourceAuthNonce=${++count}`;
    const headers = signedHeaders(sourceSecret, method, target, body);
    if (viewer)
      headers["x-portal-identity"] = mintPortalIdentity(
        { p: viewer, ...(imp ? { imp } : {}), exp: Date.now() + 60000 },
        portalSecret,
      );
    return fetch(base + target, { method, headers, ...(body ? { body } : {}) });
  }
  try {
    assert.equal((await fetch(base + "/v1/notifications?principalId=alice")).status, 401);
    assert.equal((await request("/v1/notifications?principalId=alice")).status, 401);
    assert.equal((await request("/v1/notifications?principalId=bob", "GET", "alice")).status, 403);
    assert.equal((await request("/v1/notifications?principalId=alice&cursor=invalid", "GET", "alice")).status, 400);
    assert.deepEqual(viewers, []);
    assert.equal((await request("/v1/notifications?principalId=alice", "GET", "alice")).status, 200);
    assert.deepEqual(viewers, ["alice", "alice"]);
    assert.deepEqual(names, ["Name of alice"], "the viewer's own name is passed so mentions can be labelled");
    assert.equal((await request("/v1/notifications/read-all?principalId=bob", "POST", "alice")).status, 403);
    assert.equal(
      (await request("/v1/notifications/read-all?principalId=alice", "POST", "alice", undefined, "admin")).status,
      403,
      "nothing is marked read for a person while an admin views as them",
    );
    assert.equal(
      (
        await request(
          "/v1/notification-preferences?principalId=alice",
          "PUT",
          "alice",
          '{"muteCompletions":true}',
          "admin",
        )
      ).status,
      403,
    );
    const all = await request("/v1/notifications/read-all?principalId=alice", "POST", "alice");
    assert.equal(all.status, 200);
    assert.deepEqual(await all.json(), { read: 3 });
    assert.deepEqual(reads, ["alice:all"]);
    reads.length = 0;
    assert.equal((await request("/v1/notifications/known/read?principalId=bob", "POST", "alice")).status, 403);
    assert.equal((await request("/v1/notifications/known/read?principalId=alice", "POST", "alice")).status, 200);
    assert.equal((await request("/v1/notifications/missing/read?principalId=alice", "POST", "alice")).status, 404);
    assert.deepEqual(reads, ["alice:known", "alice:missing"]);
    const prefs = "/v1/notification-preferences";
    assert.equal((await request(`${prefs}?principalId=bob`, "GET", "alice")).status, 403);
    assert.deepEqual(await (await request(`${prefs}?principalId=alice`, "GET", "alice")).json(), {
      muteCompletions: false,
    });
    assert.equal(
      (await request(`${prefs}?principalId=alice`, "PUT", "alice", '{"muteCompletions":"yes"}')).status,
      400,
    );
    assert.equal((await request(`${prefs}?principalId=bob`, "PUT", "alice", '{"muteCompletions":true}')).status, 403);
    assert.equal((await request(`${prefs}?principalId=alice`, "PUT", "alice", '{"muteCompletions":true}')).status, 200);
    assert.deepEqual(await (await request(`${prefs}?principalId=alice`, "GET", "alice")).json(), {
      muteCompletions: true,
    });
    assert.deepEqual(
      await (await request(`${prefs}?principalId=carol`, "GET", "carol")).json(),
      { muteCompletions: false },
      "the setting is per person",
    );
    assert.equal((await request("/v1/notifications/known/result?principalId=bob", "GET", "alice")).status, 403);
    assert.equal((await request("/v1/notifications/known/result?principalId=alice")).status, 401);
    assert.equal((await request("/v1/notifications/missing/result?principalId=alice", "GET", "alice")).status, 404);
    const result = await request("/v1/notifications/known/result?principalId=alice", "GET", "alice");
    assert.equal(result.status, 200);
    const body = (await result.json()) as { text: string; files: { id: string; name: string }[] };
    assert.equal(body.text, "delivered");
    assert.deepEqual(body.files, [{ id: "allowed", name: "permitted.txt" }]);
    assert.equal(streams[0]?.destroyed, true);
    assert.deepEqual(reads, ["alice:known", "alice:missing"], "reading result does not acknowledge it");
    const notice = await announcements.create(
      { level: "notice", title: "Office closed Friday", body: "Details", startsAt: Date.now() - 1000, endsAt: null },
      "admin",
    );
    await announcements.create(
      { level: "notice", title: "Not yet", body: "", startsAt: Date.now() + 3_600_000, endsAt: null },
      "admin",
    );
    type Page = {
      items: Array<{ id: string; kind: string; unread: boolean; title: string }>;
      unreadCount: number;
      unreadThreads: number;
    };
    const list = async (viewer: string, cursor = ""): Promise<Page> =>
      (await (
        await request(`/v1/notifications?principalId=${viewer}${cursor ? `&cursor=${cursor}` : ""}`, "GET", viewer)
      ).json()) as Page;
    const noticeId = `announcement:${notice.id}`;
    const first = await list("alice");
    assert.deepEqual(
      first.items.map((item) => [item.id, item.kind, item.unread, item.title]),
      [[noticeId, "announcement", true, "Office closed Friday"]],
      "only the active announcement is listed",
    );
    assert.equal(first.unreadCount, 1);
    assert.equal(first.unreadThreads, 1);
    const later = await list("alice", Buffer.from(JSON.stringify({ at: 1, id: "x" })).toString("base64url"));
    assert.deepEqual(later.items, [], "announcements appear on the first page only");
    assert.equal(later.unreadThreads, 1, "but they count on every page");
    reads.length = 0;
    const readPath = (id: string, viewer: string) =>
      `/v1/notifications/${encodeURIComponent(id)}/read?principalId=${viewer}`;
    assert.equal((await request(readPath("announcement:missing", "alice"), "POST", "alice")).status, 404);
    assert.equal((await request(readPath(noticeId, "alice"), "POST", "alice")).status, 200);
    assert.deepEqual(reads, [], "an announcement is not looked up among conversation events");
    assert.deepEqual(await announcements.dismissals("alice"), [notice.id], "reading it is the banner's dismissal");
    const afterRead = await list("alice");
    assert.equal(afterRead.items[0]!.unread, false);
    assert.equal(afterRead.unreadThreads, 0);
    assert.equal((await list("bob")).unreadThreads, 1, "dismissal is per person");
    const bobAll = await request("/v1/notifications/read-all?principalId=bob", "POST", "bob");
    assert.deepEqual(await bobAll.json(), { read: 4 }, "mark all as read also dismisses active announcements");
    assert.deepEqual(await announcements.dismissals("bob"), [notice.id]);

    const join = { name: "Launch", scopeId: "group:web-project-p1", addedBy: "bob", addedAt: Date.now() };
    await projectJoins.record(personKey("alice"), "p1", join);
    const withJoin = await list("alice");
    const joinRow = withJoin.items.find((item) => item.id === "project-join:p1");
    assert.deepEqual(
      [joinRow?.kind, joinRow?.title, joinRow?.unread],
      ["added", "Launch", true],
      "being added to a project is a row in the bell",
    );
    assert.equal(withJoin.unreadThreads, 1);
    assert.equal((await request(readPath("project-join:unknown", "alice"), "POST", "alice")).status, 404);
    assert.equal((await request(readPath("project-join:p1", "alice"), "POST", "alice")).status, 200);
    assert.equal((await list("alice")).unreadThreads, 0);
    await projectJoins.record(personKey("alice"), "p2", { ...join, name: "Audit" });
    const aliceAll = await request("/v1/notifications/read-all?principalId=alice", "POST", "alice");
    assert.deepEqual(await aliceAll.json(), { read: 4 }, "mark all as read covers project joins");
    assert.equal((await list("alice")).unreadThreads, 0);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
