#!/usr/bin/env node
import { signedRequestHeaders } from "../../../../plugins/chassis/src/source-auth-sign.ts";
import { mintPortalIdentity, PORTAL_IDENTITY_HEADER } from "../../../../plugins/chassis/src/portal-identity.ts";

const coreUrl = process.env.CORE_URL;
const secret = process.env.CORE_SIGNING_SECRET;
const identitySecret = process.env.PORTAL_IDENTITY_SECRET;
const text = process.argv[2] ?? "用一句话介绍你自己，然后执行命令 `uname -a` 并原样报告输出。";
const model = process.env.TURN_MODEL;
const probeId = "mvp-probe@example.cn";
if (!coreUrl || !secret) {
  console.error("CORE_URL and CORE_SIGNING_SECRET are required");
  process.exit(1);
}

const path = "/v1/turns?async=0";
const body = JSON.stringify({
  surface: "web",
  actor: { externalId: probeId, displayName: "MVP Probe" },
  conversation: { kind: "dm", threadRef: `web:${probeId}:${Date.now()}` },
  text,
  ...(model ? { model } : {}),
});
const identity = identitySecret
  ? mintPortalIdentity({ p: probeId, n: "MVP Probe", exp: Date.now() + 3_600_000 }, identitySecret)
  : undefined;

const res = await fetch(`${coreUrl}${path}`, {
  method: "POST",
  body,
  headers: signedRequestHeaders(secret, "POST", path, body, {
    "content-type": "application/json",
    ...(identity ? { [PORTAL_IDENTITY_HEADER]: identity } : {}),
  }),
  signal: AbortSignal.timeout(300_000),
});
const json = await res.json();
console.log(JSON.stringify(json, null, 2).slice(0, 4000));
const reply = typeof json?.reply === "string" ? json.reply : JSON.stringify(json?.entries ?? json);
console.error(`\nHTTP ${res.status} status=${json?.status}`);
console.error(`REPLY: ${String(reply).slice(0, 1500)}`);
process.exit(res.ok ? 0 : 1);
