import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { emptyTokenUsage, parseTokenUsage, readTokenUsage, sumTokenUsage } from "../src/admin/token-usage.ts";

const usage = JSON.stringify({ input: 100, output: 20, cacheRead: 60, cacheWrite: 10, totalTokens: 190 });

test("normalizes cached-inclusive and exclusive inputs without double counting", () => {
  assert.deepEqual(parseTokenUsage(usage), {
    calls: 1,
    measuredCalls: 1,
    input: 100,
    output: 20,
    cacheRead: 60,
    cacheWrite: 10,
    other: 0,
    total: 190,
  });
  const inclusive = JSON.stringify({ input: 170, output: 20, cacheRead: 60, cacheWrite: 10, totalTokens: 190 });
  assert.deepEqual(parseTokenUsage(inclusive), parseTokenUsage(usage));
  assert.equal(sumTokenUsage([parseTokenUsage(usage), parseTokenUsage(inclusive)]).total, 380);
});
test("OpenCode reasoning retained in the reported total remains measured as other tokens", () => {
  assert.deepEqual(
    parseTokenUsage(JSON.stringify({ input: 100, output: 20, cacheRead: 50, cacheWrite: 10, totalTokens: 183 })),
    { calls: 1, measuredCalls: 1, input: 100, output: 20, cacheRead: 50, cacheWrite: 10, other: 3, total: 183 },
  );
});
test("missing, malformed, negative, partial and contradictory counters stay unmeasured", () => {
  for (const raw of [
    null,
    undefined,
    "bad-json",
    "[]",
    "{}",
    '{"input":0}',
    JSON.stringify({ input: -1, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: -1 }),
    JSON.stringify({ input: "100", output: 20, cacheRead: 60, cacheWrite: 10, totalTokens: 190 }),
    JSON.stringify({ input: 100, output: 20, cacheRead: 60, cacheWrite: 10, totalTokens: 150 }),
    JSON.stringify({ input: 1, output: 20, cacheRead: 60, cacheWrite: 10, totalTokens: 21 }),
    JSON.stringify({
      input: Number.MAX_SAFE_INTEGER,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: Number.MAX_SAFE_INTEGER,
    }),
  ]) {
    assert.deepEqual(parseTokenUsage(raw), { ...emptyTokenUsage(), calls: 1 });
  }
  assert.equal(
    parseTokenUsage(JSON.stringify({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 })).measuredCalls,
    1,
  );
});
test(
  "Postgres attribution deduplicates metrics and isolates ambiguous, automated and missing identity records",
  { skip: !process.env.DATABASE_URL },
  async () => {
    const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
    const client = await pool.connect();
    const schema = `token_test_${randomUUID().replaceAll("-", "")}`;
    try {
      await client.query(`CREATE SCHEMA ${schema}`);
      await client.query(`SET search_path TO ${schema}`);
      await client.query("CREATE TABLE turn_metrics(session_id text,turn_seq int,run_id text)");
      await client.query(
        "CREATE TABLE adoption_run_facts(org text,run_id text,principal text,origin text, PRIMARY KEY(org,run_id))",
      );
      await client.query(
        "CREATE TABLE session_llm_requests(id text PRIMARY KEY,session_id text,turn_seq int,usage_json text,created_at bigint)",
      );
      await client.query(
        "INSERT INTO turn_metrics VALUES ('s',1,'run-a'),('s',1,'run-a'),('s',2,'run-b'),('s',2,'run-c'),('s',3,'run-auto'),('s',4,'run-a'),('s',5,'run-missing'),('s',6,'run-alias')",
      );
      await client.query(
        "INSERT INTO adoption_run_facts VALUES ('org','run-a','alpha','human'),('org','run-b','alpha','human'),('org','run-c','beta','human'),('org','run-auto','alpha','automation'),('other','run-missing','foreign','human'),('org','run-alias','U123','human')",
      );
      for (const [id, seq, raw, at] of [
        ["one", 1, usage, 100],
        ["two", 1, null, 101],
        ["ambiguous", 2, usage, 102],
        ["auto", 3, usage, 103],
        ["retry", 4, usage, 104],
        ["missing", 5, usage, 105],
        ["alias", 6, usage, 106],
        ["before", 1, usage, 99],
        ["boundary", 1, usage, 200],
        ["no-turn", null, usage, 107],
      ] as const) {
        await client.query("INSERT INTO session_llm_requests VALUES ($1,'s',$2,$3,$4)", [id, seq, raw, at]);
      }
      const report = await readTokenUsage(client, "org", 100, 200, new Map([["U123", "alpha"]]));
      assert.deepEqual(report.byActor.get("alpha"), {
        calls: 4,
        measuredCalls: 3,
        input: 300,
        output: 60,
        cacheRead: 180,
        cacheWrite: 30,
        other: 0,
        total: 570,
      });
      assert.equal(report.byActor.size, 1);
      assert.equal(report.unattributed.calls, 3);
      assert.equal(report.unattributed.total, 570);
      assert.equal(report.nonHuman.calls, 1);
      assert.equal(report.nonHuman.total, 190);
      const again = await readTokenUsage(client, "org", 100, 200, new Map([["U123", "alpha"]]));
      assert.deepEqual(again, report);
      assert.equal(sumTokenUsage([...report.byActor.values(), report.unattributed, report.nonHuman]).calls, 8);
    } finally {
      await client.query(`DROP SCHEMA ${schema} CASCADE`);
      client.release();
      await pool.end();
    }
  },
);
