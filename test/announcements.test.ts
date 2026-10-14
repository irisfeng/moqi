import "./support/auto-fake-sprites.ts";

import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { buildApp, type BuiltApp } from "../src/wiring.ts";
import { createInsecureTestServer, createServer } from "../src/api/server.ts";
import { mintCapabilityToken, CAPABILITY_TTL_MS } from "../src/auth/capability-token.ts";
import { scopeId } from "../src/types.ts";
import { testConfig } from "./support/test-config.ts";

const ADMIN = "admin-alice@default-org";
const NON_ADMIN = "user-uma@default-org";
const SIGNED_SECRET = "announcement-route-test-secret".repeat(3);

const MIN = 60_000;

describe("announcements: admin lifecycle and user visibility", () => {
  let server: Server;
  let base: string;
  let built: BuiltApp;

  const adminGet = (path: string) => fetch(`${base}${path}`, { headers: { "x-admin-actor": ADMIN } });
  const adminSend = (method: string, path: string, body: unknown, actor = ADMIN) =>
    fetch(`${base}${path}`, {
      method,
      headers: { "x-admin-actor": actor, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  const publish = (over: Record<string, unknown> = {}) =>
    adminSend("POST", "/v1/admin/announcements", {
      level: "notice",
      title: "Scheduled maintenance",
      body: "The portal restarts tonight.",
      startsAt: Date.now() - MIN,
      endsAt: Date.now() + 60 * MIN,
      ...over,
    });
  const userFeed = (principalId?: string) =>
    fetch(`${base}/v1/announcements${principalId ? `?principalId=${encodeURIComponent(principalId)}` : ""}`);
  const dismiss = (id: string, principalId: string) =>
    fetch(`${base}/v1/announcements/${id}/dismiss`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ principalId }),
    });
  const publishJson = async (over: Record<string, unknown> = {}): Promise<{ announcement: { id: string } }> =>
    (await (await publish(over)).json()) as { announcement: { id: string } };
  const dismissJson = async (id: string, principalId: string): Promise<{ ok: boolean; dismissed: string[] }> =>
    (await (await dismiss(id, principalId)).json()) as { ok: boolean; dismissed: string[] };

  before(async () => {
    built = buildApp(testConfig({ dataDir: mkdtempSync(join(tmpdir(), "announcements-")) }));
    server = createInsecureTestServer(built.app, {
      admin: built.admin,
      auditLog: built.auditLog,
      announcements: built.announcements,
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    base = `http://localhost:${(server.address() as AddressInfo).port}`;
  });
  after(() => server.close());

  test("only announcements inside their window are visible; future and expired ones are not", async () => {
    assert.equal(
      (await publish({ title: "Future", startsAt: Date.now() + 60 * MIN, endsAt: Date.now() + 120 * MIN })).status,
      201,
    );
    const active = await publishJson({ title: "Active now", level: "incident" });
    assert.equal(
      (await publish({ title: "Expired", startsAt: Date.now() - 120 * MIN, endsAt: Date.now() - 60 * MIN })).status,
      201,
    );

    const res = await userFeed("U-view");
    assert.equal(res.status, 200);
    const feed = (await res.json()) as { announcements: { id: string; title: string }[]; dismissed: string[] };
    assert.deepEqual(
      feed.announcements.map((a) => a.title),
      ["Active now"],
    );
    assert.equal(feed.announcements[0]!.id, active.announcement.id as string);
    assert.deepEqual(feed.dismissed, []);
  });

  test("window boundaries: startsAt=now is live, endsAt=now is already gone", async () => {
    await publish({ title: "Starts this instant", startsAt: Date.now(), endsAt: Date.now() + 60 * MIN });
    await publish({ title: "Ends this instant", startsAt: Date.now() - 60 * MIN, endsAt: Date.now() });
    const feed = (await (await userFeed("U-view")).json()) as { announcements: { title: string }[] };
    const titles = feed.announcements.map((a) => a.title);
    assert.ok(titles.includes("Starts this instant"));
    assert.ok(!titles.includes("Ends this instant"));
  });

  test("permanent notices preserve dismissals across edits and can be retired", async () => {
    const response = await publish({ title: "Permanent", endsAt: null });
    assert.equal(response.status, 201);
    const { announcement } = (await response.json()) as { announcement: { id: string; endsAt: null } };
    assert.equal(announcement.endsAt, null);
    const id = announcement.id;
    await dismiss(id, "permanent-user");
    assert.equal((await adminSend("PUT", `/v1/admin/announcements/${id}`, { title: "Updated permanent" })).status, 200);
    const feed = (await (await userFeed("permanent-user")).json()) as {
      announcements: { id: string; endsAt: number | null }[];
      dismissed: string[];
    };
    assert.equal(feed.announcements.find((a) => a.id === id)?.endsAt, null);
    assert.ok(feed.dismissed.includes(id));
    assert.equal((await adminSend("PUT", `/v1/admin/announcements/${id}`, { endsAt: Date.now() + MIN })).status, 200);
    assert.equal((await adminSend("PUT", `/v1/admin/announcements/${id}`, { endsAt: null })).status, 200);
    assert.equal((await adminSend("PUT", `/v1/admin/announcements/${id}`, { endsAt: "" })).status, 400);
    assert.equal((await adminSend("PUT", `/v1/admin/announcements/${id}`, { endsAt: Date.now() - 1 })).status, 200);
  });

  test("retiring (endsAt pushed into the past) hides an announcement but keeps it in admin history", async () => {
    const { announcement } = await publishJson({ title: "Retire me" });
    const id = announcement.id;
    assert.equal((await adminSend("PUT", `/v1/admin/announcements/${id}`, { endsAt: Date.now() - 1 })).status, 200);

    const feed = (await (await userFeed("U-view")).json()) as { announcements: { id: string }[] };
    assert.ok(!feed.announcements.some((a) => a.id === id));

    const history = (await (await adminGet("/v1/admin/announcements")).json()) as { announcements: { id: string }[] };
    assert.ok(history.announcements.some((a) => a.id === id));
  });

  test("editing content and window through PUT reaches the user feed", async () => {
    const { announcement } = await publishJson({ title: "Before edit" });
    const id = announcement.id;
    const res = await adminSend("PUT", `/v1/admin/announcements/${id}`, {
      title: "After edit",
      level: "maintenance",
      body: "Edited body.",
    });
    assert.equal(res.status, 200);
    const feed = (await (await userFeed("U-view")).json()) as {
      announcements: { id: string; title: string; level: string }[];
    };
    const edited = feed.announcements.find((a) => a.id === id);
    assert.deepEqual(edited ? { title: edited.title, level: edited.level } : null, {
      title: "After edit",
      level: "maintenance",
    });
  });

  test("important popup defaults off, round trips and validates strictly", async () => {
    const ordinary = (await (await publish()).json()) as { announcement: { popup: boolean } };
    assert.equal(ordinary.announcement.popup, false);
    const { announcement } = await publishJson({ popup: true });
    const read = async () =>
      (await (await userFeed("U-view")).json()) as { announcements: { id: string; popup: boolean }[] };
    assert.equal((await read()).announcements.find((a) => a.id === announcement.id)?.popup, true);
    for (const value of ["true", 1, null]) {
      assert.equal((await publish({ popup: value })).status, 400);
      assert.equal(
        (await adminSend("PUT", `/v1/admin/announcements/${announcement.id}`, { popup: value })).status,
        400,
      );
    }
    assert.equal((await adminSend("PUT", `/v1/admin/announcements/${announcement.id}`, { popup: false })).status, 200);
    assert.equal((await read()).announcements.find((a) => a.id === announcement.id)?.popup, false);
  });

  test("a dismissal is per-user, idempotent, and reads back across requests", async () => {
    const { announcement } = await publishJson({ title: "Dismissible" });
    const id = announcement.id;

    assert.equal((await dismiss("does-not-exist", "U-view")).status, 404);
    assert.equal(
      (
        await fetch(`${base}/v1/announcements/${id}/dismiss`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
        })
      ).status,
      400,
      "a dismissal without any principal is a 400, never a hung response",
    );

    const first = await dismissJson(id, "U-view");
    assert.deepEqual(first.dismissed, [id]);
    const again = await dismissJson(id, "U-view");
    assert.deepEqual(again.dismissed, [id], "dismissing twice keeps a single record");

    const mine = (await (await userFeed("U-view")).json()) as { dismissed: string[] };
    assert.deepEqual(mine.dismissed, [id]);
    const other = (await (await userFeed("U-other")).json()) as { dismissed: string[] };
    assert.deepEqual(other.dismissed, [], "another user's dismissal set is untouched");
    assert.deepEqual(await built.announcements.dismissals("U-view"), [id]);
  });

  test("admin writes are gated: non-admins and anonymous callers are refused", async () => {
    assert.equal(
      (
        await adminSend(
          "POST",
          "/v1/admin/announcements",
          { level: "notice", title: "x", startsAt: 1, endsAt: 2 },
          NON_ADMIN,
        )
      ).status,
      403,
    );
    assert.equal(
      (
        await fetch(`${base}/v1/admin/announcements`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ level: "notice", title: "x", startsAt: 1, endsAt: 2 }),
        })
      ).status,
      403,
    );
    const { announcement } = await publishJson({ title: "Gate check" });
    assert.equal(
      (await adminSend("PUT", `/v1/admin/announcements/${announcement.id}`, { title: "y" }, NON_ADMIN)).status,
      403,
    );
    assert.equal(
      (await fetch(`${base}/v1/admin/announcements`, { headers: { "x-admin-actor": NON_ADMIN } })).status,
      403,
    );
  });

  test("every admin write leaves an audit row naming the acting admin", async () => {
    const { announcement } = await publishJson({ title: "Audited" });
    await adminSend("PUT", `/v1/admin/announcements/${announcement.id}`, { title: "Audited twice" });
    const events = await built.auditLog.events();
    assert.ok(
      events.some(
        (e) => e.action === "announcement.create" && e.resource === announcement.id && e.principalId === "admin-alice",
      ),
    );
    assert.ok(events.some((e) => e.action === "announcement.update" && e.resource.startsWith(`${announcement.id}/`)));
  });

  test("create rejects unknown levels, empty titles, and inverted windows", async () => {
    assert.equal((await publish({ level: "urgent" })).status, 400);
    assert.equal((await publish({ title: "" })).status, 400);
    assert.equal((await publish({ startsAt: Date.now() + MIN, endsAt: Date.now() })).status, 400);
  });

  test("a feed without a principalId still lists active announcements with an empty dismissal set", async () => {
    await publish({ title: "Anonymous read" });
    const res = await userFeed();
    assert.equal(res.status, 200);
    const feed = (await res.json()) as { announcements: { title: string }[]; dismissed: string[] };
    assert.equal(feed.dismissed.length, 0);
    assert.ok(feed.announcements.some((a) => a.title === "Anonymous read"));
  });
});

describe("announcements: authentication on a signed core", () => {
  let server: Server;
  let base: string;
  let built: BuiltApp;

  before(async () => {
    built = buildApp(
      testConfig({ dataDir: mkdtempSync(join(tmpdir(), "announcements-signed-")), signingSecret: SIGNED_SECRET }),
    );
    server = createServer(built.app, { signingSecret: SIGNED_SECRET, announcements: built.announcements });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    base = `http://localhost:${(server.address() as AddressInfo).port}`;
  });
  after(() => server.close());

  test("the user feed requires authentication (401 without any)", async () => {
    assert.equal((await fetch(`${base}/v1/announcements?principalId=U-view`)).status, 401);
    assert.equal(
      (
        await fetch(`${base}/v1/announcements/some-id/dismiss`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ principalId: "U-view" }),
        })
      ).status,
      401,
    );
  });

  test("a legacy capability token cannot read the Web-only feed", async () => {
    const cap = await mintCapabilityToken(
      { actorId: "U-cap", scopeId: scopeId("personal", "U-cap"), exp: Date.now() + CAPABILITY_TTL_MS },
      SIGNED_SECRET,
    );
    const res = await fetch(`${base}/v1/announcements`, { headers: { "x-agent-capability": cap } });
    assert.equal(res.status, 403);
    assert.deepEqual(await res.json(), { error: "forbidden", message: "capability token not valid for this route" });
  });
});
