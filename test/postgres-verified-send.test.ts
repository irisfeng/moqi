import "./support/auto-fake-sprites.ts";

import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { mintPortalIdentity, PORTAL_IDENTITY_HEADER } from "../plugins/chassis/src/portal-identity.ts";
import { signedHeaders, withSourceAuthNonce } from "../plugins/chassis/src/core-client.ts";
import { createServer } from "../src/api/server.ts";
import { projectGroupRef } from "../src/projects/project-store.ts";
import { buildApp } from "../src/wiring.ts";
import { testConfig } from "./support/test-config.ts";

const databaseUrl = process.env.DATABASE_URL;

test(
  "PostgreSQL deduplicates concurrent identical v2 POSTs and finds a prior v1 project key",
  { skip: databaseUrl ? false : "set DATABASE_URL (a Postgres) to run the verified send test" },
  async () => {
    const sourceSecret = "verified-send-postgres-source-secret";
    const portalSecret = "verified-send-postgres-portal-secret";
    const capabilitySecret = "verified-send-postgres-capability-secret";
    const first = buildApp(
      testConfig({ databaseUrl, runStore: "postgres", dataDir: mkdtempSync(join(tmpdir(), "verified-send-pg-a-")) }),
    );
    const second = buildApp(
      testConfig({ databaseUrl, runStore: "postgres", dataDir: mkdtempSync(join(tmpdir(), "verified-send-pg-b-")) }),
    );
    const serverOptions = {
      signingSecret: sourceSecret,
      portalIdentitySecret: portalSecret,
      capabilitySecret,
      requireSignedPortalIdentity: true,
    };
    const servers = [
      createServer(first.app, { ...serverOptions, webhookReceiver: first.webhookReceiver }),
      createServer(second.app, { ...serverOptions, webhookReceiver: second.webhookReceiver }),
    ];

    try {
      for (const server of servers) await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

      const user = "alice@example.com";
      const operation = randomUUID();
      const threadRef = `web:${user}:${operation}`;
      const key = `web:${encodeURIComponent(user)}:${operation}`;
      const text = "one concurrent send";
      const fingerprint = createHash("sha256").update(JSON.stringify({ text, threadRef })).digest("hex");
      const portal = mintPortalIdentity({ p: user, exp: Date.now() + 300_000 }, portalSecret);
      const payload = {
        surface: "web",
        actor: { externalId: user },
        conversation: { kind: "dm", threadRef },
        liveActor: true,
        deliveryTarget: threadRef,
        text,
        idempotencyKey: key,
        verifiedRequestFingerprint: fingerprint,
      };
      const send = (index: number, body: typeof payload, protocol: 1 | 2 = 2) => {
        const path = withSourceAuthNonce(`/v${protocol}/turns?async=1`, sourceSecret);
        const raw = JSON.stringify(body);
        return fetch(`http://127.0.0.1:${(servers[index % 2]!.address() as AddressInfo).port}${path}`, {
          method: "POST",
          headers: {
            ...signedHeaders(sourceSecret, "POST", path, raw),
            [PORTAL_IDENTITY_HEADER]: portal,
          },
          body: raw,
        });
      };

      const responses = await Promise.all(Array.from({ length: 12 }, (_, index) => send(index, payload)));
      assert.ok(responses.every((response) => response.status === 202));
      const runIds = await Promise.all(
        responses.map(async (response) => ((await response.json()) as { runId?: string }).runId),
      );
      assert.ok(runIds.every((id) => typeof id === "string" && id.length > 0));
      assert.equal(new Set(runIds).size, 1);
      assert.equal((await first.runs.getByDedupKey(key))?.id, runIds[0]);
      assert.equal((await second.runs.getByDedupKey(key))?.id, runIds[0]);

      const changed = await send(0, {
        ...payload,
        text: "different concurrent send",
        verifiedRequestFingerprint: createHash("sha256")
          .update(JSON.stringify({ text: "different concurrent send", threadRef }))
          .digest("hex"),
      });
      assert.equal(changed.status, 403);
      assert.equal((await first.runs.getByDedupKey(key))?.id, runIds[0]);

      const legacyOperation = randomUUID();
      const legacyThreadRef = `web:${user}:${legacyOperation}`;
      const legacyBaseKey = `web:${encodeURIComponent(user)}:${legacyOperation}`;
      const legacyText = "previous project-key send";
      const project = await first.app.createProject(user, `Legacy project ${legacyOperation}`);
      assert.ok(project);
      const legacyPayload = {
        ...payload,
        conversation: { kind: "group" as const, channelRef: projectGroupRef(project.id), threadRef: legacyThreadRef },
        deliveryTarget: legacyThreadRef,
        text: legacyText,
        idempotencyKey: legacyBaseKey,
        verifiedRequestFingerprint: createHash("sha256")
          .update(JSON.stringify({ text: legacyText, threadRef: legacyThreadRef }))
          .digest("hex"),
      };
      const prior = await send(0, legacyPayload, 1);
      assert.equal(prior.status, 202);
      const priorRunId = ((await prior.json()) as { runId?: string }).runId;
      assert.ok(priorRunId);
      const legacyStoredKey = `${legacyBaseKey}:project-${project.updatedAt}`;
      assert.equal((await first.runs.getByDedupKey(legacyStoredKey))?.id, priorRunId);
      const bridgeRetries = await Promise.all(Array.from({ length: 4 }, (_, index) => send(index, legacyPayload)));
      assert.ok(bridgeRetries.every((response) => response.status === 403));
      const bridgeResults = await Promise.all(
        bridgeRetries.map(async (response) => (await response.json()) as { reason?: string }),
      );
      assert.ok(bridgeResults.every((result) => result.reason?.includes("previous send cannot be safely matched")));
      assert.equal(await first.runs.getByDedupKey(legacyBaseKey), null);
      assert.equal((await first.runs.getByDedupKey(legacyStoredKey))?.id, priorRunId);

      const receiptPath = withSourceAuthNonce(
        `/v2/turns/receipt?key=${encodeURIComponent(legacyBaseKey)}&viewer=${encodeURIComponent(user)}`,
        sourceSecret,
      );
      const receipt = await fetch(`http://127.0.0.1:${(servers[1]!.address() as AddressInfo).port}${receiptPath}`, {
        headers: { ...signedHeaders(sourceSecret, "GET", receiptPath, ""), [PORTAL_IDENTITY_HEADER]: portal },
      });
      assert.equal(receipt.status, 200);
      const legacyReceipt = (await receipt.json()) as { runId?: string; verifiedRequestFingerprint?: string };
      assert.equal(legacyReceipt.runId, priorRunId);
      assert.equal(legacyReceipt.verifiedRequestFingerprint, undefined);
    } finally {
      for (const server of servers)
        if (server.listening)
          await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
      await Promise.all([first.runtime.stop(), second.runtime.stop()]);
    }
  },
);
