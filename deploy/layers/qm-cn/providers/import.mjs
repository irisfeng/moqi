#!/usr/bin/env node
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { signedRequestHeaders } from "../../../../plugins/chassis/src/source-auth-sign.ts";
import { mintPortalIdentity, PORTAL_IDENTITY_HEADER } from "../../../../plugins/chassis/src/portal-identity.ts";
import { PROVIDER_KEY_ENV } from "./provider-key-env.mjs";

const coreUrl = process.env.CORE_URL;
const secret = process.env.CORE_SIGNING_SECRET;
const identitySecret = process.env.PORTAL_IDENTITY_SECRET;
if (!coreUrl || !secret) {
  console.error("CORE_URL and CORE_SIGNING_SECRET are required");
  process.exit(1);
}

const wanted = process.argv.slice(2);
const files = readdirSync(import.meta.dirname)
  .filter((f) => f.endsWith(".json"))
  .sort();

let failed = 0;
for (const file of files) {
  const slug = file.replace(/\.json$/, "");
  if (wanted.length > 0 && !wanted.includes(slug)) continue;
  const spec = JSON.parse(readFileSync(join(import.meta.dirname, file), "utf8"));
  if (spec.models.some((m) => m.id.startsWith("REPLACE_WITH"))) {
    console.error(`SKIP ${slug}: template still has placeholder model ids — edit ${file} first`);
    failed += 1;
    continue;
  }
  const apiKey = process.env[PROVIDER_KEY_ENV[slug] ?? ""];
  const body = JSON.stringify({ ...spec, ...(apiKey ? { apiKey } : {}) });
  const path = `/v1/admin/custom-providers/${slug}`;
  const identity = identitySecret
    ? mintPortalIdentity(
        { p: process.env.QM_ADMIN ?? "qm-cn-import@example.cn", n: "qm-cn import", exp: Date.now() + 600_000 },
        identitySecret,
      )
    : undefined;
  try {
    const res = await fetch(`${coreUrl}${path}`, {
      method: "PUT",
      body,
      headers: signedRequestHeaders(secret, "PUT", path, body, {
        "content-type": "application/json",
        ...(identity ? { [PORTAL_IDENTITY_HEADER]: identity } : {}),
      }),
    });
    const text = await res.text();
    if (res.ok) {
      console.log(`OK   ${slug} — ${text.slice(0, 200)}`);
    } else {
      console.error(`FAIL ${slug} — HTTP ${res.status}: ${text.slice(0, 300)}`);
      failed += 1;
    }
  } catch (error) {
    console.error(`FAIL ${slug} — ${error instanceof Error ? error.message : String(error)}`);
    failed += 1;
  }
}
process.exit(failed > 0 ? 1 : 0);
