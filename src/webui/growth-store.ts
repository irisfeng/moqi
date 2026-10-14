import { createPgPool, withPgTransaction } from "../persistence/pg-pool.ts";
import { createKeyedQueue } from "../util/async.ts";
import type { GrowthReward, GrowthState } from "./growth.ts";

export interface GrowthStore {
  transact<T>(
    principal: string,
    fn: (state: GrowthState, rewards: GrowthReward[], award: (reward: GrowthReward) => void) => Promise<T>,
  ): Promise<T>;
  close(): Promise<void>;
}

function initialGrowthState(): GrowthState {
  return {
    preferences: { enabled: false, time: "09:30", timeZone: "Asia/Shanghai" },
    tasks: {},
    skippedDates: [],
    reminderDates: [],
  };
}

export function createPostgresGrowthStore(connectionString: string): GrowthStore {
  const database = createPgPool(connectionString, "zz-qm-cn/growth/0001", [
    `CREATE TABLE IF NOT EXISTS webui_growth_profiles (principal TEXT PRIMARY KEY, state JSONB NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS webui_growth_rewards (
      principal TEXT NOT NULL, reward_key TEXT NOT NULL, run_id TEXT NOT NULL,
      points INTEGER NOT NULL CHECK(points > 0), reason TEXT NOT NULL, at BIGINT NOT NULL,
      PRIMARY KEY(principal, reward_key), UNIQUE(principal, run_id)
    )`,
  ]);
  const oneAtATime = createKeyedQueue();
  return {
    close: database.close,
    async transact(principal, fn) {
      return oneAtATime("growth", async () =>
        withPgTransaction(await database.pool(), async (client) => {
          await client.query(
            "INSERT INTO webui_growth_profiles(principal,state) VALUES($1,$2) ON CONFLICT DO NOTHING",
            [principal, JSON.stringify(initialGrowthState())],
          );
          const profile = await client.query("SELECT state FROM webui_growth_profiles WHERE principal=$1 FOR UPDATE", [
            principal,
          ]);
          const state = profile.rows[0].state as GrowthState;
          const rows = await client.query(
            "SELECT reward_key,run_id,points,reason,at FROM webui_growth_rewards WHERE principal=$1 ORDER BY at DESC",
            [principal],
          );
          const rewards: GrowthReward[] = rows.rows.map((r) => ({
            key: r.reward_key,
            runId: r.run_id,
            points: r.points,
            reason: r.reason,
            at: Number(r.at),
          }));
          const pending: GrowthReward[] = [];
          const value = await fn(state, rewards, (reward) => {
            if (rewards.some((r) => r.key === reward.key || r.runId === reward.runId)) return;
            rewards.unshift(reward);
            pending.push(reward);
          });
          for (const reward of pending) {
            await client.query(
              "INSERT INTO webui_growth_rewards(principal,reward_key,run_id,points,reason,at) VALUES($1,$2,$3,$4,$5,$6)",
              [principal, reward.key, reward.runId, reward.points, reward.reason, reward.at],
            );
          }
          await client.query("UPDATE webui_growth_profiles SET state=$2 WHERE principal=$1", [
            principal,
            JSON.stringify(state),
          ]);
          return value;
        }),
      );
    },
  };
}
