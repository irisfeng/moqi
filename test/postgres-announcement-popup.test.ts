import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { orgId } from "../src/config.ts";
import { createPostgresAnnouncementStore } from "../src/announcements/announcement-store.ts";
import { createPostgresMapFactory } from "../src/persistence/durable-map.ts";

const databaseUrl = process.env.DATABASE_URL;
test(
  "legacy announcements stay ordinary and popup acknowledgements survive new store instances",
  { skip: !databaseUrl },
  async () => {
    const schema = `ann_popup_${randomUUID().replaceAll("-", "")}`;
    const admin = new pg.Pool({ connectionString: databaseUrl });
    await admin.query(`CREATE SCHEMA ${schema}`);
    const url = new URL(databaseUrl!);
    url.searchParams.set("options", `-c search_path=${schema}`);
    const connectionString = url.toString();
    const pool = new pg.Pool({ connectionString });
    const maps = createPostgresMapFactory(connectionString);
    const readerMaps = createPostgresMapFactory(connectionString);
    try {
      await pool.query(
        `CREATE TABLE announcements(id TEXT PRIMARY KEY, org_id TEXT NOT NULL, level TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL, starts_at BIGINT NOT NULL, ends_at BIGINT NOT NULL, created_by TEXT NOT NULL, created_at BIGINT NOT NULL)`,
      );
      await pool.query(
        "INSERT INTO announcements VALUES ('legacy', $1, 'notice', 'Legacy', 'Body', 1, 9999999999999, 'alice', 1)",
        [orgId()],
      );
      const store = createPostgresAnnouncementStore(connectionString, maps.map<string[]>("map_ann_dismissals"));
      const draft = {
        level: "notice" as const,
        title: "Local test",
        body: "Body",
        startsAt: Date.now() - 1000,
        endsAt: Date.now() + 60000,
      };
      assert.equal((await store.get("legacy"))?.popup, false);
      const ordinary = await store.create(draft, "alice");
      assert.equal((await store.get(ordinary.id))?.popup, false);
      const important = await store.create({ ...draft, popup: true }, "alice");
      await store.dismiss("alice", important.id);
      const reader = createPostgresAnnouncementStore(connectionString, readerMaps.map<string[]>("map_ann_dismissals"));
      assert.equal((await reader.get(important.id))?.popup, true);
      assert.deepEqual(await reader.dismissals("alice"), [important.id]);
      assert.deepEqual(await reader.dismissals("bob"), []);
      await reader.update(important.id, { title: "Edited" });
      assert.deepEqual(await reader.dismissals("alice"), [important.id]);
      await reader.update(important.id, { endsAt: null });
      assert.equal((await store.get(important.id))?.endsAt, null);
      assert.ok((await store.listActive()).some((a) => a.id === important.id));
      assert.deepEqual(await reader.dismissals("alice"), [important.id]);
      await reader.update(important.id, { endsAt: Date.now() - 1 });
      assert.ok(!(await store.listActive()).some((a) => a.id === important.id));
      await reader.update(important.id, { popup: false });
      assert.equal((await store.get(important.id))?.popup, false);
    } finally {
      await maps.pool.close();
      await readerMaps.pool.close();
      await pool.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    }
  },
);
