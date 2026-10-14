#!/usr/bin/env node
import { createHmac } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const deployDir = process.argv[2] ?? process.env.QM_DEPLOY_DIR ?? ".";
const coreUrl = process.env.CORE_URL || "http://127.0.0.1:8080";
const orgId = process.env.QM_ORG_ID || "qm-cn";
const adminPrincipal = process.env.QM_ADMIN || "admin@example.cn";
const adminActor = process.env.QM_ADMIN_ACTOR || `${adminPrincipal}@${orgId}`;
const seedPath = process.argv[3] ?? join(scriptDir, "..", "seed", "webui-home.json");

const env = new Map(
  readFileSync(join(deployDir, ".env"), "utf8")
    .split("\n")
    .map((l) => l.trim().replace(/^export /, ""))
    .filter((l) => l && !l.startsWith("#"))
    .map((l) => {
      const eq = l.indexOf("=");
      return eq === -1 ? [l, ""] : [l.slice(0, eq), l.slice(eq + 1).replace(/^["']|["']$/g, "")];
    }),
);
const secret = env.get("CORE_SIGNING_SECRET");
if (!secret) {
  console.error(`CORE_SIGNING_SECRET missing in ${join(deployDir, ".env")}`);
  process.exit(1);
}
const identitySecret = env.get("PORTAL_IDENTITY_SECRET") || secret;
function mintPortalIdentity(principal) {
  const payload = Buffer.from(JSON.stringify({ p: principal, exp: Date.now() + 10 * 60_000 }), "utf8").toString(
    "base64url",
  );
  const sig = createHmac("sha256", identitySecret).update(payload).digest("base64url");
  return `${payload}.${sig}`;
}
const identity = mintPortalIdentity(adminPrincipal);
if (!existsSync(seedPath)) {
  console.error(`seed file not found: ${seedPath}`);
  process.exit(1);
}
const seed = JSON.parse(readFileSync(seedPath, "utf8"));
if (!seed || typeof seed !== "object" || !seed.welcome) {
  console.error("seed file must be an object with a welcome field");
  process.exit(1);
}

function headers(method, path, body) {
  const ts = String(Math.floor(Date.now() / 1000));
  const sig = `v0=${createHmac("sha256", secret).update(`v0:${ts}:${method}\n${path}\n${body}`).digest("hex")}`;
  return {
    "x-timestamp": ts,
    "x-signature": sig,
    "x-portal-identity": identity,
    "x-admin-actor": adminActor,
    ...(body ? { "content-type": "application/json" } : {}),
  };
}

const canonical = (value) =>
  JSON.stringify(value, (k, v) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.keys(v)
          .sort()
          .reduce((acc, key) => ({ ...acc, [key]: v[key] }), {})
      : v,
  );
const contentHash = (value) =>
  createHmac("sha256", "webui-home-seed").update(canonical(value)).digest("hex").slice(0, 16);

async function call(method, path, bodyObj) {
  const body = bodyObj === undefined ? "" : JSON.stringify(bodyObj);
  const res = await fetch(coreUrl + path, {
    method,
    headers: headers(method, path, body),
    ...(body ? { body } : {}),
  });
  const text = await res.text();
  return { status: res.status, text };
}

const current = await call("GET", "/v1/webui-home");
if (current.status === 200) {
  const live = JSON.parse(current.text);
  if (contentHash(live) === contentHash(seed)) {
    console.log(`webui-home already current (${contentHash(seed)}), skipping`);
    process.exit(0);
  }
}

const put = await call("PUT", `/v1/admin/scopes/org:${orgId}/webui-home`, { home: seed });
if (put.status !== 200) {
  console.error(`PUT webui-home failed: HTTP ${put.status}: ${put.text.slice(0, 200)}`);
  process.exit(1);
}
const verify = await call("GET", "/v1/webui-home");
if (verify.status !== 200) {
  console.error(`verify GET /v1/webui-home failed: HTTP ${verify.status}`);
  process.exit(1);
}
const applied = JSON.parse(verify.text);
console.log(
  `webui-home applied (${contentHash(seed)}): roles=${applied.welcome?.roles?.length ?? 0} tips=${applied.tips?.length ?? 0} opener=${applied.opener?.enabled}`,
);
