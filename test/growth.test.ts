import { after, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createPostgresGrowthStore } from "../src/webui/growth-store.ts";
import {
  createGrowthService,
  growthCalendar,
  parseGrowthConfig,
  type GrowthConfig,
} from "../src/webui/growth-service.ts";
import { createMemoryRunStore } from "../src/runs/memory-run-store.ts";
import { createMemorySessionStore } from "../src/sessions/memory-session-store.ts";
import type { GrowthSnapshot } from "../src/webui/growth.ts";
import type { TurnResult } from "../src/types.ts";
import { readFileSync } from "node:fs";

const URL = process.env.DATABASE_URL;
const store = URL ? createPostgresGrowthStore(URL) : null;
const otherStore = URL ? createPostgresGrowthStore(URL) : null;
const skip = !URL;
const config = parseGrowthConfig(
  JSON.parse(readFileSync("deploy/layers/qm-cn/seed/webui-home.json", "utf8")).growth,
) as GrowthConfig;
after(async () => {
  await store?.close();
  await otherStore?.close();
});

function fixture() {
  assert.ok(store && otherStore);
  const principal = `growth-${randomUUID()}@test`;
  const sessions = createMemorySessionStore();
  const { runs } = createMemoryRunStore();
  let now = Date.parse("2026-09-07T02:00:00Z");
  const service = createGrowthService({ store, sessions, runs, now: () => now });
  const second = createGrowthService({ store: otherStore, sessions, runs, now: () => now });
  const call = (body = {}) => service.execute(principal, config, body);
  async function output(
    view: GrowthSnapshot,
    result: TurnResult = {
      status: "ok",
      reply:
        "这是一份用于验收的会议纪要。结论是先整理已有客户反馈。小林负责初稿，周五前完成，培训时间和其他负责人仍待确认。",
    },
    daily = false,
    actor = principal,
  ) {
    now += 1000;
    const task = daily ? view.daily! : view.onboarding;
    const session = await sessions.getOrCreateByThread(task.participation!.threadRef, "dm", `personal:${principal}`);
    await sessions.addParticipant(session.id, principal);
    const { run } = await runs.enqueue({
      sessionId: session.threadRef,
      request: {
        actor: { id: actor, type: "internal" },
        conversation: { kind: "dm", threadRef: session.threadRef, audience: [] },
        origin: { kind: "human" },
        text: "请按要求整理这份会议纪要并保留待确认项目",
      },
    });
    run.createdAt = now;
    const claimed = await runs.claimById(run.id, "worker", 10000);
    assert.ok(claimed?.leaseToken);
    const { lease } = await sessions.acquireLease(session.id);
    assert.ok(lease);
    const entry = await sessions.append(lease, {
      type: "assistant",
      payload: { text: result.reply },
      scopeLabel: `personal:${principal}`,
    });
    await sessions.releaseLease(lease);
    await runs.complete(run.id, claimed.leaseToken, {
      ...result,
      sessionId: session.id,
      sourceAssistantEntrySeq: entry.seq,
    });
    run.finishedAt = now;
    return run;
  }
  async function start(key = "onboarding-v1") {
    await call({ action: "start", key });
    return call({ action: "prepare", key });
  }
  async function graduate() {
    let view = await start();
    const first = await output(view);
    now += 1;
    view = await call({ action: "accept", key: view.onboarding.key, runId: first.id });
    const revision = await output(view, {
      status: "ok",
      reply:
        "修改后的行动清单：事项是整理反馈，负责人小林，时间周五，状态待完成。培训安排的负责人和时间均待确认。本版补齐了表格字段并明确了缺失信息，没有编造新事实。",
    });
    now += 1;
    return call({ action: "accept", key: view.onboarding.key, runId: revision.id });
  }
  return {
    principal,
    sessions,
    runs,
    service,
    second,
    call,
    output,
    start,
    graduate,
    setTime: (n: number) => {
      now = n;
    },
  };
}

test("calendar follows local midnight, weekdays and daylight saving", () => {
  assert.deepEqual(growthCalendar(Date.parse("2026-09-06T16:01:00Z"), "Asia/Shanghai"), {
    date: "2026-09-07",
    time: "00:01",
    workday: true,
  });
  assert.equal(growthCalendar(Date.parse("2026-09-06T16:01:00Z"), "America/New_York").workday, false);
  assert.equal(growthCalendar(Date.parse("2026-03-08T07:30:00Z"), "America/New_York").time, "03:30");
  assert.ok(config);
  assert.equal(parseGrowthConfig({ onboarding: {}, daily: [] }), null);
  assert.equal(parseGrowthConfig({ ...config, onboarding: { ...config.onboarding, revisionPrompt: "" } }), null);
});

test(
  "Postgres starts once across instances, persists progress, and opening or preparing earns nothing",
  { skip },
  async () => {
    const f = fixture();
    const [a, b] = await Promise.all([
      f.call({ action: "start", key: "onboarding-v1" }),
      f.second.execute(f.principal, config, { action: "start", key: "onboarding-v1" }),
    ]);
    assert.equal(a.onboarding.participation!.threadRef, b.onboarding.participation!.threadRef);
    const c = await f.call({ action: "prepare", key: "onboarding-v1" });
    assert.equal(c.points, 0);
    assert.equal(c.onboarding.participation!.prepared, true);
    assert.equal((await f.second.execute(f.principal, config)).onboarding.participation!.prepared, true);
    await assert.rejects(f.call({ action: "accept", key: "onboarding-v1", runId: "forged" }), /No new result/);
    assert.equal((await f.call()).points, 0);
  },
);

test("empty, stopped, refused, failed and other-member output never earns points", { skip }, async () => {
  const f = fixture();
  let view = await f.start();
  for (const result of [
    { status: "ok", reply: "" },
    { status: "failed", reply: "失败" },
    { status: "refused", reply: "拒绝" },
    { status: "ok", stopped: true, reply: "长文本".repeat(30) },
  ] as TurnResult[]) {
    const run = await f.output(view, result);
    view = await f.call();
    assert.equal(view.onboarding.evidence, null);
    await assert.rejects(f.call({ action: "accept", key: view.onboarding.key, runId: run.id }));
  }
  await f.output(view, { status: "ok", reply: "他人的回答".repeat(20) }, false, "another@test");
  assert.equal((await f.call()).onboarding.evidence, null);
  assert.equal((await f.call()).points, 0);
});

test(
  "concurrent acceptance pays once, modification must be a new successful result after acceptance",
  { skip },
  async () => {
    const f = fixture();
    let view = await f.start();
    const run = await f.output(view);
    view = await f.call();
    assert.equal(view.onboarding.evidence!.runId, run.id);
    const body = { action: "accept", key: view.onboarding.key, runId: run.id };
    const results = await Promise.all(
      Array.from({ length: 12 }, (_, n) => (n % 2 ? f.service : f.second).execute(f.principal, config, body)),
    );
    assert.ok(results.every((v) => v.points === 30));
    view = await f.call();
    assert.equal(view.onboarding.status, "revise");
    const duplicate = await f.output(view);
    await assert.rejects(f.call({ action: "accept", key: view.onboarding.key, runId: duplicate.id }));
    const revision = await f.output(view, {
      status: "ok",
      reply:
        "新版本明确区分了事项、负责人、截止时间和状态。已知部分是小林周五提交反馈初稿，其余培训安排仍待确认；这次修改把缺失项单列为问题清单，便于逐项核对。",
    });
    view = await f.call({ action: "accept", key: view.onboarding.key, runId: revision.id });
    assert.equal(view.points, 50);
    assert.equal(view.onboarding.status, "complete");
    assert.deepEqual(view.badges, ["First Result", "Always Refining"]);
    assert.equal(view.history.length, 2);
    assert.equal((await f.second.execute(f.principal, config)).points, 50);
    await f.output(view, {
      status: "ok",
      reply: "这是完成任务之后继续讨论的新话题，与已确认的修改成果无关，不应替换已领取积分对应的成果记录。",
    });
    assert.equal((await f.call()).onboarding.evidence?.runId, revision.id);
  },
);

test(
  "daily challenge unlocks after first lesson; reminder is durable, opt-in, skippable and stops after acceptance",
  { skip },
  async () => {
    const f = fixture();
    assert.equal((await f.call()).daily, null);
    let view = await f.graduate();
    assert.ok(view.daily);
    assert.equal(view.reminder, null);
    const prefs = { enabled: true, time: "09:30", timeZone: "Asia/Shanghai" };
    view = await f.call({ action: "preferences", preferences: prefs });
    assert.equal(view.reminder!.key, view.daily!.key);
    await Promise.all([f.call(), f.second.execute(f.principal, config)]);
    const dates = await store!.transact(f.principal, async (state) => state.reminderDates);
    assert.equal(dates.length, 1);
    view = await f.start(view.daily!.key);
    const result = await f.output(
      view,
      {
        status: "ok",
        reply:
          "本次练习结果：先整理客户反馈，下周试用新版表格，随后评估反馈。尚需确认试用范围、负责人和验收时间，不能把这些信息当成已经确定。",
      },
      true,
    );
    const body = { action: "accept", key: view.daily!.key, runId: result.id };
    const [a, b] = await Promise.all([f.call(body), f.second.execute(f.principal, config, body)]);
    assert.equal(a.points, 60);
    assert.equal(b.points, 60);
    assert.equal(a.reminder, null);
    await f.output(
      a,
      {
        status: "ok",
        reply: "每日任务完成后继续讨论的另一份材料，这一轮并未领取任何积分，不能显示成已经验收通过的每日成果。",
      },
      true,
    );
    assert.equal((await f.call()).daily?.evidence?.runId, result.id);
    await assert.rejects(
      f.call({ action: "preferences", preferences: { ...prefs, timeZone: "Pacific/Kiritimati" } }),
      /24 hours/,
    );
    f.setTime(Date.parse("2026-09-08T02:00:00Z"));
    view = await f.call();
    assert.ok(view.reminder);
    view = await f.call({ action: "skip", key: view.daily!.key });
    assert.equal(view.reminder, null);
    await assert.rejects(f.call({ action: "start", key: view.daily!.key }));
    f.setTime(Date.parse("2026-09-09T02:00:00Z"));
    view = await f.call({ action: "preferences", preferences: { ...prefs, enabled: false } });
    assert.equal(view.reminder, null);
    f.setTime(Date.parse("2026-09-12T02:00:00Z"));
    assert.equal((await f.call()).daily, null);
  },
);

test("deleted sessions hide evidence; transaction failure does not leave a reward", { skip }, async () => {
  const f = fixture();
  const v = await f.start();
  const run = await f.output(v);
  await f.sessions.deleteSession((await f.sessions.getByThread(run.sessionId))!.id);
  assert.equal((await f.call()).onboarding.evidence, null);
  await assert.rejects(
    store!.transact(f.principal, async (state, _rewards, award) => {
      state.preferences.enabled = true;
      award({ key: "synthetic", runId: "synthetic", points: 10, at: Date.now(), reason: "rollback probe" });
      throw new Error("rollback");
    }),
  );
  const a = await f.call();
  assert.equal(a.preferences.enabled, false);
  assert.equal(a.points, 0);
});

test("growth survives closing and reopening its PostgreSQL connection", { skip }, async () => {
  const f = fixture();
  await f.graduate();
  const reopened = createPostgresGrowthStore(URL!);
  try {
    const service = createGrowthService({ store: reopened, sessions: f.sessions, runs: f.runs });
    const view = await service.execute(f.principal, config);
    assert.equal(view.points, 50);
    assert.equal(view.onboarding.status, "complete");
  } finally {
    await reopened.close();
  }
});
