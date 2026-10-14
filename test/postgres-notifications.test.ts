import assert from "node:assert/strict";
import { test } from "node:test";
import pg from "pg";
import { createPostgresNotificationStore } from "../src/notifications/notification-store.ts";
import { createPostgresSessionStore } from "../src/sessions/postgres-session-store.ts";
import { createPostgresDeliveryStore } from "../src/delivery/postgres-delivery-store.ts";
import { createPostgresRunStore } from "../src/runs/postgres-run-store.ts";

const url = process.env.DATABASE_URL;
test(
  "notification receipts survive restart, isolate viewers, preserve late commits and enforce membership",
  { skip: !url },
  async () => {
    const pool = new pg.Pool({ connectionString: url });
    const sessions = createPostgresSessionStore(url!);
    const deliveries = createPostgresDeliveryStore(url!);
    const runtime = createPostgresRunStore(url!);
    const deps = { sessions, deliveries, runs: runtime.runs };
    const store = createPostgresNotificationStore(url!, deps);
    let reader = store;
    const key = `notify-${Date.now()}`;
    const threadRef = `web:${key}`;
    try {
      const peer = createPostgresNotificationStore(url!, deps);
      await Promise.all([store.prepare(), peer.prepare()]);
      await peer.close();
      const now = Date.now() + 100;
      await pool.query(
        "INSERT INTO sessions(id,type,scope_id,thread_ref,surface,created_at) VALUES($1,'group','project:notification-test',$3,'web',$2)",
        [key, now, threadRef],
      );
      for (const principal of ["internal:alice", "internal:bob"]) {
        await pool.query(
          "INSERT INTO participants(session_id,principal_id,valid_from,valid_from_seq) VALUES($1,$2,$3,0)",
          [key, principal, now - 100],
        );
      }
      const allowed = [(await sessions.get(key))!];
      async function entry(
        seq: number,
        at: number,
        actor = "internal:other",
        origin = "direct",
        conn: pg.Pool | pg.PoolClient = pool,
      ) {
        const run = `${key}-${seq}`;
        await conn.query("INSERT INTO runs(id,session_id,status,request,created_at) VALUES($1,$2,'done',$3,$4)", [
          run,
          threadRef,
          JSON.stringify({ actor: { id: actor }, origin: { kind: origin } }),
          at,
        ]);
        await conn.query(
          "INSERT INTO session_entries(session_id,seq,type,payload,scope_label,created_at) VALUES($1,$2,'user',$3,'project:notification-test',$4)",
          [key, seq, JSON.stringify({ runId: run, text: "test" }), at],
        );
      }
      await entry(1, now);
      await entry(2, now + 1, "internal:alice");
      await entry(3, now + 2, "internal:other", "automation");
      assert.equal((await store.list("internal:alice", allowed)).unreadCount, 1);
      assert.equal((await store.list("internal:bob", allowed)).unreadCount, 2);
      assert.equal((await store.list("internal:outsider", allowed)).unreadCount, 0);
      assert.equal((await store.list("internal:alice", [])).unreadCount, 0);
      const late = await pool.connect();
      try {
        await late.query("BEGIN");
        await entry(4, now, "internal:other", "human", late);
        const first = (await store.list("internal:alice", allowed)).items[0]!;
        assert.equal(await store.read("internal:alice", allowed, first.id), true);
        assert.equal((await store.list("internal:alice", allowed)).unreadCount, 0);
        await late.query("COMMIT");
      } finally {
        late.release();
      }
      await store.close();
      reader = createPostgresNotificationStore(url!, deps);
      const after = await reader.list("internal:alice", allowed);
      assert.equal(after.unreadCount, 1);
      assert.equal(after.items[0]!.runId, `${key}-4`);
      assert.equal((await reader.list("internal:bob", allowed)).unreadCount, 3);
      assert.equal(await reader.read("internal:alice", [], after.items[0]!.id), false);
      const delivered = await deliveries.enqueue({
        destination: { type: "web", target: threadRef },
        text: "reply",
        idempotencyKey: `${key}-reply`,
      });
      await pool.query("UPDATE deliveries SET created_at=$2 WHERE id=$1", [delivered.id, now + 3]);
      await deliveries.ack(delivered.id, now + 4);
      const reply = await reader.list("internal:alice", allowed);
      assert.equal(reply.unreadCount, 2);
      assert.equal(reply.items[0]!.deliveryId, delivered.id);
      const result = await reader.result("internal:alice", allowed, reply.items[0]!.id);
      assert.equal(result?.text, "reply");
      assert.equal(result?.threadRef, threadRef);
      assert.equal((await reader.list("internal:alice", allowed)).unreadCount, 2);
      assert.equal(await reader.result("internal:outsider", allowed, reply.items[0]!.id), null);
      assert.equal(await reader.result("internal:alice", [], reply.items[0]!.id), null);
      assert.equal(
        await reader.result("internal:alice", [{ ...allowed[0]!, archived: true }], reply.items[0]!.id),
        null,
      );
      await reader.read("internal:alice", allowed, reply.items[0]!.id);
      assert.equal((await reader.result("internal:alice", allowed, reply.items[0]!.id))?.text, "reply");
      assert.equal(
        (await reader.list("internal:alice", allowed)).unreadCount,
        1,
        "result view only acknowledges its own delivery",
      );
      await reader.read("internal:alice", allowed, after.items[0]!.id);
      const ties = await Promise.all(
        ["a", "b"].map((suffix) =>
          deliveries.enqueue({
            destination: { type: "web", target: threadRef },
            text: "simultaneous reply " + suffix,
            idempotencyKey: `${key}-tie-${suffix}`,
          }),
        ),
      );
      await pool.query("UPDATE deliveries SET created_at=$2 WHERE id=ANY($1::text[])", [
        ties.map((item) => item.id),
        now + 4,
      ]);
      await entry(5, now + 4);
      let tied = await reader.list("internal:alice", allowed);
      assert.equal(tied.unreadCount, 3);
      assert.equal(await reader.read("internal:alice", allowed, tied.items[0]!.id), true);
      tied = await reader.list("internal:alice", allowed);
      assert.equal(tied.unreadCount, 2, "same-millisecond events must not be acknowledged by another event");
      assert.equal(await reader.read("internal:alice", allowed, tied.items[0]!.id), true);
      tied = await reader.list("internal:alice", allowed);
      assert.equal(tied.unreadCount, 1);
      assert.equal(await reader.read("internal:alice", allowed, tied.items[0]!.id), true);
      assert.equal((await reader.list("internal:alice", allowed)).unreadCount, 0);
      const recovered = [];
      for (const [index, suffix] of ["older", "newer"].entries()) {
        const runId = `${key}-recovery-${suffix}`;
        await pool.query("INSERT INTO runs(id,session_id,status,request,created_at) VALUES($1,$2,'done',$3,$4)", [
          runId,
          threadRef,
          JSON.stringify({ actor: { id: "internal:other" } }),
          now + 1 + index,
        ]);
        const delivery = await deliveries.enqueue({
          destination: { type: "web", target: threadRef },
          text: `recovered ${suffix}`,
          idempotencyKey: `run:${runId}`,
        });
        await pool.query("UPDATE deliveries SET created_at=$2 WHERE id=$1", [delivery.id, now + 2 + index]);
        recovered.push(delivery);
      }
      const recoveryPage = await reader.list("internal:alice", allowed);
      assert.equal(recoveryPage.items[0]!.deliveryId, recovered[1]!.id);
      assert.equal(recoveryPage.items[0]!.runId, undefined);
      assert.equal(
        (await reader.result("internal:alice", allowed, recoveryPage.items[0]!.id))?.text,
        "recovered newer",
      );
      await entry(6, now + 4);
      await reader.read("internal:alice", allowed, (await reader.list("internal:alice", allowed)).items[0]!.id);
      assert.equal(
        (await reader.list("internal:alice", allowed)).unreadCount,
        2,
        "transcript read preserves recovery results",
      );
      await reader.read("internal:alice", allowed, `delivery:${recovered[1]!.id}`);
      assert.equal(
        (await reader.list("internal:alice", allowed)).unreadCount,
        1,
        "recovery read preserves older unseen recovery",
      );
      await reader.read("internal:alice", allowed, `delivery:${recovered[0]!.id}`);
      assert.equal((await reader.list("internal:alice", allowed)).unreadCount, 0);
      await pool.query(
        "UPDATE participants SET valid_to=$2,valid_to_seq=5 WHERE session_id=$1 AND principal_id='internal:alice'",
        [key, now + 4],
      );
      await entry(11, now + 5);
      assert.equal((await reader.list("internal:alice", allowed)).unreadCount, 0);
    } finally {
      await reader.close();
      await runtime.close();
      await pool.end();
    }
  },
);

test(
  "history keeps read rows, counts a finished task for the person who asked, labels mentions and marks all read",
  { skip: !url },
  async () => {
    const pool = new pg.Pool({ connectionString: url });
    const sessions = createPostgresSessionStore(url!);
    const deliveries = createPostgresDeliveryStore(url!);
    const runtime = createPostgresRunStore(url!);
    const store = createPostgresNotificationStore(url!, { sessions, deliveries, runs: runtime.runs });
    const key = `notify-history-${Date.now()}`;
    const threadRef = `web:${key}`;
    try {
      await store.prepare();
      const now = Date.now() + 100;
      await pool.query(
        "INSERT INTO sessions(id,type,scope_id,thread_ref,surface,created_at) VALUES($1,'group','project:notification-test',$3,'web',$2)",
        [key, now, threadRef],
      );
      for (const principal of ["internal:alice", "internal:bob"]) {
        await pool.query(
          "INSERT INTO participants(session_id,principal_id,valid_from,valid_from_seq) VALUES($1,$2,$3,0)",
          [key, principal, now - 100],
        );
      }
      const allowed = [(await sessions.get(key))!];
      async function said(seq: number, at: number, text: string) {
        const run = `${key}-said-${seq}`;
        await pool.query("INSERT INTO runs(id,session_id,status,request,created_at) VALUES($1,$2,'done',$3,$4)", [
          run,
          threadRef,
          JSON.stringify({ actor: { id: "internal:bob" }, origin: { kind: "direct" } }),
          at,
        ]);
        await pool.query(
          "INSERT INTO session_entries(session_id,seq,type,payload,scope_label,created_at) VALUES($1,$2,'user',$3,'project:notification-test',$4)",
          [key, seq, JSON.stringify({ runId: run, text }), at],
        );
      }
      async function finished(actor: string, at: number, seq: number) {
        await pool.query(
          "INSERT INTO runs(id,session_id,status,request,result,created_at,finished_at) VALUES($1,$2,'done',$3,$4,$5,$6)",
          [
            `${key}-task-${seq}`,
            threadRef,
            JSON.stringify({ actor: { id: actor }, surfaceTools: true }),
            JSON.stringify({ status: "ok", reply: "finished", sourceAssistantEntrySeq: seq }),
            at - 1,
            at,
          ],
        );
      }
      await said(1, now, "@Alice please look");
      await finished("internal:alice", now + 2, 2);
      await finished("internal:bob", now + 2, 3);

      const first = await store.list("internal:alice", allowed, undefined, "Alice");
      assert.equal(first.unreadCount, 2);
      assert.equal(first.unreadThreads, 1);
      assert.equal(first.items.length, 1);
      assert.equal(first.items[0]!.kind, "done");
      assert.equal(first.items[0]!.seq, 2);
      assert.equal(first.items[0]!.unread, true);
      assert.equal(first.items[0]!.unreadCount, 2);
      assert.equal((await store.list("internal:bob", allowed)).unreadCount, 1, "a task counts only for who asked");

      assert.equal(await store.read("internal:alice", allowed, first.items[0]!.id), true);
      const history = await store.list("internal:alice", allowed, undefined, "Alice");
      assert.equal(history.unreadCount, 0);
      assert.equal(history.unreadThreads, 0);
      assert.equal(history.items.length, 1, "a read conversation stays in the list");
      assert.equal(history.items[0]!.unread, false);
      assert.equal(history.items[0]!.unreadCount, 0);

      await said(4, now + 3, "@Alice once more");
      assert.equal((await store.list("internal:alice", allowed, undefined, "Alice")).items[0]!.kind, "mention");
      assert.equal((await store.list("internal:alice", allowed)).items[0]!.kind, "message");
      assert.equal((await store.list("internal:alice", allowed, undefined, "Carol")).items[0]!.kind, "message");

      assert.equal(await store.readAll("internal:alice", allowed), 1);
      assert.equal(await store.readAll("internal:alice", allowed), 0);
      assert.equal(await store.readAll("internal:alice", []), 0);
      assert.equal((await store.list("internal:alice", allowed)).unreadCount, 0);
      assert.equal((await store.list("internal:bob", allowed)).unreadCount, 1, "marking all read is per person");
    } finally {
      await store.close();
      await runtime.close();
      await pool.end();
    }
  },
);
