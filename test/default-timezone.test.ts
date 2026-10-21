import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

const probe = `
const { DEFAULT_CRON_TIMEZONE, normalizeSchedule } = await import("./src/cron/schedule.ts");
const { schedule, nextFireAt } = normalizeSchedule({ cron: "0 9 * * *" }, Date.UTC(2026, 9, 20, 0, 0));
console.log(JSON.stringify({ DEFAULT_CRON_TIMEZONE, timezone: schedule.timezone, nextFireAt }));
`;

function load(value: string | undefined) {
  const env = { ...process.env };
  delete env.QM_DEFAULT_TIMEZONE;
  if (value !== undefined) env.QM_DEFAULT_TIMEZONE = value;
  return spawnSync(process.execPath, ["--input-type=module", "-e", probe], { env, encoding: "utf8" });
}

test("QM_DEFAULT_TIMEZONE sets the fallback zone for calendar crons", () => {
  const r = load("Asia/Shanghai");
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout) as { DEFAULT_CRON_TIMEZONE: string; timezone: string; nextFireAt: number };
  assert.equal(out.DEFAULT_CRON_TIMEZONE, "Asia/Shanghai");
  assert.equal(out.timezone, "Asia/Shanghai");
  assert.equal(out.nextFireAt, Date.UTC(2026, 9, 20, 1, 0));
});

test("without QM_DEFAULT_TIMEZONE the fallback stays America/Los_Angeles", () => {
  const r = load("  ");
  assert.equal(r.status, 0, r.stderr);
  assert.equal((JSON.parse(r.stdout) as { timezone: string }).timezone, "America/Los_Angeles");
});

test("an invalid QM_DEFAULT_TIMEZONE stops startup with the setting named", () => {
  const r = load("Beijing");
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /QM_DEFAULT_TIMEZONE="Beijing" is not an IANA timezone/);
});
