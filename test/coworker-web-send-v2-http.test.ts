import "./support/auto-fake-sprites.ts";

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { mintPortalIdentity, PORTAL_IDENTITY_HEADER } from "../plugins/chassis/src/portal-identity.ts";
import { signedHeaders, withSourceAuthNonce } from "../plugins/chassis/src/core-client.ts";
import { createServer } from "../src/api/server.ts";
import { buildApp } from "../src/wiring.ts";
import { testConfig } from "./support/test-config.ts";

test("versioned web send recovers one run when the client ignores an accepted response", async () => {
  const built = buildApp(testConfig({ dataDir: mkdtempSync(join(tmpdir(), "coworker-send-v2-")) }));
  const secret = "coworker-send-v2-source-secret-0001";
  const portalSecret = "coworker-send-v2-portal-secret-0002";
  const capabilitySecret = "coworker-send-v2-capability-secret-0003";
  const core = createServer(built.app, {
    signingSecret: secret,
    portalIdentitySecret: portalSecret,
    capabilitySecret,
    requireSignedPortalIdentity: true,
    blobTransfer: built.blobTransfer,
    webhookReceiver: built.webhookReceiver,
  });
  await new Promise<void>((resolve) => core.listen(0, "127.0.0.1", resolve));
  process.env.CORE_API_URL = `http://127.0.0.1:${(core.address() as AddressInfo).port}`;
  process.env.CORE_SIGNING_SECRET = secret;
  process.env.PORTAL_IDENTITY_SECRET = portalSecret;
  process.env.WEB_UI_PRINCIPALS = "alice@example.com,bob@example.com";
  const { handler } = await import("../plugins/web-ui/server/index.ts");
  const web = createHttpServer((req, res) => void handler(req, res));
  await new Promise<void>((resolve) => web.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(web.address() as AddressInfo).port}`;
  const post = (path: string, user: string, body: Record<string, unknown>) =>
    fetch(`${base}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [PORTAL_IDENTITY_HEADER]: mintPortalIdentity({ p: user, exp: Date.now() + 60_000 }, portalSecret),
      },
      body: JSON.stringify(body),
    });

  try {
    const logical = {
      text: "one draft",
      threadRef: "web:alice@example.com:retry-one",
      expectedUser: "alice@example.com",
    };
    const clientRequestFingerprint = createHash("sha256").update(JSON.stringify(logical)).digest("hex");
    const payload = { ...logical, idempotencyKey: "stable-one", clientRequestFingerprint };
    const coreBody = JSON.stringify({
      surface: "web",
      actor: { externalId: "alice@example.com" },
      conversation: { kind: "dm", threadRef: logical.threadRef },
      liveActor: true,
      deliveryTarget: logical.threadRef,
      text: logical.text,
      idempotencyKey: `web:${encodeURIComponent("alice@example.com")}:stable-one`,
      verifiedRequestFingerprint: clientRequestFingerprint,
    });
    const corePath = withSourceAuthNonce("/v2/turns?async=1", secret);
    const coreBase = process.env.CORE_API_URL;
    assert.ok(coreBase);
    const noIdentity = await fetch(`${coreBase}${corePath}`, {
      method: "POST",
      headers: signedHeaders(secret, "POST", corePath, coreBody),
      body: coreBody,
    });
    assert.equal(noIdentity.status, 401);
    const wrongPath = withSourceAuthNonce("/v2/turns?async=1", secret);
    const wrongIdentity = await fetch(`${coreBase}${wrongPath}`, {
      method: "POST",
      headers: {
        ...signedHeaders(secret, "POST", wrongPath, coreBody),
        [PORTAL_IDENTITY_HEADER]: mintPortalIdentity({ p: "bob@example.com", exp: Date.now() + 60_000 }, portalSecret),
      },
      body: coreBody,
    });
    assert.equal(wrongIdentity.status, 403);
    const receiptPath = withSourceAuthNonce(
      `/v2/turns/receipt?key=${encodeURIComponent(`web:${encodeURIComponent("alice@example.com")}:stable-one`)}&viewer=${encodeURIComponent("alice@example.com")}`,
      secret,
    );
    const unauthenticatedReceipt = await fetch(`${coreBase}${receiptPath}`, {
      headers: signedHeaders(secret, "GET", receiptPath, ""),
    });
    assert.equal(unauthenticatedReceipt.status, 401);
    const malformedBody = JSON.stringify({ ...JSON.parse(coreBody), attachments: {} });
    const malformedPath = withSourceAuthNonce("/v2/turns?async=1", secret);
    const malformed = await fetch(`${coreBase}${malformedPath}`, {
      method: "POST",
      headers: {
        ...signedHeaders(secret, "POST", malformedPath, malformedBody),
        [PORTAL_IDENTITY_HEADER]: mintPortalIdentity(
          { p: "alice@example.com", exp: Date.now() + 60_000 },
          portalSecret,
        ),
      },
      body: malformedBody,
    });
    assert.equal(malformed.status, 400);

    const unsafeTurns = [
      { actor: { externalId: "alice@example.com", isBot: true } },
      { conversation: { kind: "dm", threadRef: logical.threadRef, audience: [{ externalId: "bob@example.com" }] } },
      {
        conversation: { kind: "dm", threadRef: logical.threadRef, publishMembers: [{ externalId: "bob@example.com" }] },
      },
      { conversation: { kind: "dm", threadRef: logical.threadRef, isPrivate: true } },
      { conversation: { kind: "dm", threadRef: logical.threadRef, channelRef: "other-channel" } },
      { conversation: { kind: "dm", threadRef: "web:bob@example.com:private" } },
      { deliveryTarget: "web:bob@example.com:private" },
      { liveActor: false },
    ];
    for (const fields of unsafeTurns) {
      const unsafeBody = JSON.stringify({ ...JSON.parse(coreBody), ...fields });
      const unsafePath = withSourceAuthNonce("/v2/turns?async=1", secret);
      const unsafe = await fetch(`${coreBase}${unsafePath}`, {
        method: "POST",
        headers: {
          ...signedHeaders(secret, "POST", unsafePath, unsafeBody),
          [PORTAL_IDENTITY_HEADER]: mintPortalIdentity(
            { p: "alice@example.com", exp: Date.now() + 60_000 },
            portalSecret,
          ),
        },
        body: unsafeBody,
      });
      assert.equal(unsafe.status, 400);
    }
    assert.equal((await built.runs.list()).length, 0);

    const missing = await post("/api/turn/v2/receipt", "alice@example.com", payload);
    assert.equal(missing.status, 404);
    assert.deepEqual(await missing.json(), { error: "not_found", sendProtocol: 2 });

    const switchedAccount = await post("/api/turn/v2", "bob@example.com", payload);
    assert.equal(switchedAccount.status, 400);
    const switchedReceipt = await post("/api/turn/v2/receipt", "bob@example.com", payload);
    assert.equal(switchedReceipt.status, 400);
    assert.equal((await built.runs.list()).length, 0);

    const accepted = await post("/api/turn/v2", "alice@example.com", payload);
    assert.equal(accepted.status, 202);
    const foreignCorePath = withSourceAuthNonce(
      `/v2/turns/receipt?key=${encodeURIComponent(`web:${encodeURIComponent("alice@example.com")}:stable-one`)}&viewer=${encodeURIComponent("alice@example.com")}`,
      secret,
    );
    const foreignCoreReceipt = await fetch(`${coreBase}${foreignCorePath}`, {
      headers: {
        ...signedHeaders(secret, "GET", foreignCorePath, ""),
        [PORTAL_IDENTITY_HEADER]: mintPortalIdentity({ p: "bob@example.com", exp: Date.now() + 60_000 }, portalSecret),
      },
    });
    assert.equal(foreignCoreReceipt.status, 403);
    assert.equal(((await foreignCoreReceipt.json()) as { runId?: string }).runId, undefined);
    const first = (await built.runs.list())[0];
    assert.ok(first);

    const recovered = await post("/api/turn/v2/receipt", "alice@example.com", payload);
    assert.equal(recovered.status, 200);
    const receipt = (await recovered.json()) as { runId?: string; verifiedRequestFingerprint?: string };
    assert.equal(receipt.runId, first.id);
    assert.equal(receipt.verifiedRequestFingerprint, clientRequestFingerprint);

    const retry = await post("/api/turn/v2", "alice@example.com", payload);
    assert.equal(retry.status, 202);
    assert.equal(((await retry.json()) as { runId?: string }).runId, first.id);
    assert.equal((await built.runs.list()).length, 1);

    const changed = await post("/api/turn/v2", "alice@example.com", {
      ...payload,
      text: "different content",
      clientRequestFingerprint: createHash("sha256")
        .update(JSON.stringify({ ...logical, text: "different content" }))
        .digest("hex"),
    });
    assert.equal(changed.status, 403);
    assert.equal((await built.runs.list()).length, 1);

    const foreign = await post("/api/turn/v2/receipt", "bob@example.com", payload);
    assert.notEqual(foreign.status, 200);
    assert.equal((await built.runs.list()).length, 1);

    const quoteLogical = {
      text: "please review this source",
      threadRef: "web:alice@example.com:quote-one",
      expectedUser: "alice@example.com",
      quoteSeq: 0,
      quoteText: "original project note",
      quoteAuthor: "colleague",
    };
    const quoteFingerprint = createHash("sha256").update(JSON.stringify(quoteLogical)).digest("hex");
    const quotePayload = {
      ...quoteLogical,
      idempotencyKey: "stable-quote-one",
      clientRequestFingerprint: quoteFingerprint,
    };
    const invalidQuotes: Record<string, unknown>[] = [
      { quoteText: "" },
      { quoteText: "a".repeat(301) },
      { quoteAuthor: "b".repeat(51) },
      { quoteSeq: -1 },
      { quoteSeq: 1.5 },
      { quoteSeq: Number.MAX_SAFE_INTEGER + 1 },
    ];
    for (const fields of invalidQuotes) {
      const malformedLogical = { ...quoteLogical, ...fields };
      const malformedQuote = await post("/api/turn/v2", "alice@example.com", {
        ...quotePayload,
        ...fields,
        clientRequestFingerprint: createHash("sha256").update(JSON.stringify(malformedLogical)).digest("hex"),
      });
      assert.equal(malformedQuote.status, 400);
      const invalidCoreBody = JSON.stringify({
        ...JSON.parse(coreBody),
        conversation: { kind: "dm", threadRef: quoteLogical.threadRef },
        deliveryTarget: quoteLogical.threadRef,
        text: quoteLogical.text,
        idempotencyKey: `web:${encodeURIComponent("alice@example.com")}:stable-quote-one`,
        verifiedRequestFingerprint: quoteFingerprint,
        quoteSeq: quoteLogical.quoteSeq,
        quoteText: quoteLogical.quoteText,
        quoteAuthor: quoteLogical.quoteAuthor,
        ...fields,
      });
      const invalidCorePath = withSourceAuthNonce("/v2/turns?async=1", secret);
      const invalidCore = await fetch(`${coreBase}${invalidCorePath}`, {
        method: "POST",
        headers: {
          ...signedHeaders(secret, "POST", invalidCorePath, invalidCoreBody),
          [PORTAL_IDENTITY_HEADER]: mintPortalIdentity(
            { p: "alice@example.com", exp: Date.now() + 60_000 },
            portalSecret,
          ),
        },
        body: invalidCoreBody,
      });
      assert.equal(invalidCore.status, 400);
    }
    assert.equal((await built.runs.list()).length, 1);

    const quoted = await post("/api/turn/v2", "alice@example.com", quotePayload);
    assert.equal(quoted.status, 202);
    const quoteRunId = ((await quoted.json()) as { runId?: string }).runId;
    assert.ok(quoteRunId);
    const quotedRun = (await built.runs.list()).find((run) => run.id === quoteRunId);
    assert.equal(quotedRun?.request.quoteSeq, 0);
    assert.equal(quotedRun?.request.quoteText, "original project note");
    assert.equal(quotedRun?.request.quoteAuthor, "colleague");
    const quoteReceipt = await post("/api/turn/v2/receipt", "alice@example.com", quotePayload);
    assert.equal(quoteReceipt.status, 200);
    assert.equal(((await quoteReceipt.json()) as { runId?: string }).runId, quoteRunId);
    const quotedRetry = await post("/api/turn/v2", "alice@example.com", quotePayload);
    assert.equal(quotedRetry.status, 202);
    assert.equal(((await quotedRetry.json()) as { runId?: string }).runId, quoteRunId);
    const changedQuote = {
      ...quoteLogical,
      quoteText: "different project note",
    };
    const changedQuoteResult = await post("/api/turn/v2", "alice@example.com", {
      ...changedQuote,
      idempotencyKey: quotePayload.idempotencyKey,
      clientRequestFingerprint: createHash("sha256").update(JSON.stringify(changedQuote)).digest("hex"),
    });
    assert.equal(changedQuoteResult.status, 403);
    assert.equal((await built.runs.list()).length, 2);

    const bytes = new TextEncoder().encode("synthetic attachment bytes");
    const sha = createHash("sha256").update(bytes).digest("hex");
    const upload = await fetch(`${base}/api/blobs?sha=${sha}`, {
      method: "POST",
      headers: {
        "content-type": "application/octet-stream",
        [PORTAL_IDENTITY_HEADER]: mintPortalIdentity(
          { p: "alice@example.com", exp: Date.now() + 60_000 },
          portalSecret,
        ),
      },
      body: bytes,
    });
    assert.equal(upload.status, 200);
    const uploaded = (await upload.json()) as { blobId: string; sizeBytes: number };
    assert.match(uploaded.blobId, /^[0-9a-f]{32}$/);
    assert.equal(uploaded.sizeBytes, bytes.length);
    const attachment = { name: "source.txt", mimetype: "text/plain", sizeBytes: bytes.length, blobId: uploaded.blobId };
    const attachedLogical = {
      text: "review attached source",
      threadRef: "web:alice@example.com:attachment-one",
      expectedUser: "alice@example.com",
      attachments: [attachment],
    };
    const attachedPayload = {
      ...attachedLogical,
      idempotencyKey: "stable-attachment-one",
      clientRequestFingerprint: createHash("sha256").update(JSON.stringify(attachedLogical)).digest("hex"),
    };
    const attachedMissing = await post("/api/turn/v2/receipt", "alice@example.com", attachedPayload);
    assert.equal(attachedMissing.status, 404);
    const attachedAccepted = await post("/api/turn/v2", "alice@example.com", attachedPayload);
    assert.equal(attachedAccepted.status, 202);
    const attachedRunId = ((await attachedAccepted.json()) as { runId?: string }).runId;
    assert.ok(attachedRunId);
    const attachedRun = (await built.runs.list()).find((run) => run.id === attachedRunId);
    assert.deepEqual(attachedRun?.request.attachments, [attachment]);
    const attachedReceipt = await post("/api/turn/v2/receipt", "alice@example.com", attachedPayload);
    assert.equal(attachedReceipt.status, 200);
    assert.equal(((await attachedReceipt.json()) as { runId?: string }).runId, attachedRunId);
    const attachedRetry = await post("/api/turn/v2", "alice@example.com", attachedPayload);
    assert.equal(attachedRetry.status, 202);
    assert.equal(((await attachedRetry.json()) as { runId?: string }).runId, attachedRunId);
    assert.equal((await built.runs.list()).length, 3);

    const changedAttachment = { ...attachedLogical, attachments: [{ ...attachment, name: "replacement.txt" }] };
    const attachedConflict = await post("/api/turn/v2", "alice@example.com", {
      ...changedAttachment,
      idempotencyKey: attachedPayload.idempotencyKey,
      clientRequestFingerprint: createHash("sha256").update(JSON.stringify(changedAttachment)).digest("hex"),
    });
    assert.equal(attachedConflict.status, 403);
    assert.equal((await built.runs.list()).length, 3);

    const onlyAttachment = { ...attachedLogical, text: "", threadRef: "web:alice@example.com:attachment-only" };
    const onlyResult = await post("/api/turn/v2", "alice@example.com", {
      ...onlyAttachment,
      idempotencyKey: "stable-attachment-only",
      clientRequestFingerprint: createHash("sha256").update(JSON.stringify(onlyAttachment)).digest("hex"),
    });
    assert.equal(onlyResult.status, 202);
    assert.equal((await built.runs.list()).length, 4);

    const quotedAttachment = {
      text: "review this file against the original note",
      threadRef: "web:alice@example.com:quoted-attachment",
      expectedUser: "alice@example.com",
      quoteSeq: 0,
      quoteText: "original project note",
      quoteAuthor: "colleague",
      attachments: [attachment],
    };
    const quotedAttachmentPayload = {
      ...quotedAttachment,
      idempotencyKey: "stable-quoted-attachment",
      clientRequestFingerprint: createHash("sha256").update(JSON.stringify(quotedAttachment)).digest("hex"),
    };
    const quotedAttachedResult = await post("/api/turn/v2", "alice@example.com", quotedAttachmentPayload);
    assert.equal(quotedAttachedResult.status, 202);
    const quotedAttachedRunId = ((await quotedAttachedResult.json()) as { runId?: string }).runId;
    const quotedAttachedRun = (await built.runs.list()).find((run) => run.id === quotedAttachedRunId);
    assert.deepEqual(quotedAttachedRun?.request.attachments, [attachment]);
    assert.equal(quotedAttachedRun?.request.quoteSeq, 0);
    assert.equal(quotedAttachedRun?.request.quoteText, "original project note");
    const quotedAttachedReceipt = await post("/api/turn/v2/receipt", "alice@example.com", quotedAttachmentPayload);
    assert.equal(quotedAttachedReceipt.status, 200);
    assert.equal((await built.runs.list()).length, 5);

    const malformedAttachments: unknown[] = [
      [{}],
      [{ ...attachment, sourceId: "foreign" }],
      [{ ...attachment, author: "other member" }],
      [{ ...attachment, blobId: "invalid" }],
      [{ ...attachment, sizeBytes: -1 }],
      [{ ...attachment, name: "../source.txt" }],
      Array.from({ length: 21 }, () => attachment),
      { ...attachment },
    ];
    for (const [index, attachments] of malformedAttachments.entries()) {
      const malformedLogical = {
        ...attachedLogical,
        threadRef: `web:alice@example.com:bad-attachment-${index}`,
        attachments,
      };
      const malformedWeb = await post("/api/turn/v2", "alice@example.com", {
        ...malformedLogical,
        idempotencyKey: `bad-attachment-${index}`,
        clientRequestFingerprint: createHash("sha256").update(JSON.stringify(malformedLogical)).digest("hex"),
      });
      assert.equal(malformedWeb.status, 400, `Web malformed attachment ${index}`);
      const badCoreBody = JSON.stringify({
        ...JSON.parse(coreBody),
        text: "review attached source",
        conversation: { kind: "dm", threadRef: malformedLogical.threadRef },
        deliveryTarget: malformedLogical.threadRef,
        attachments,
        idempotencyKey: `web:${encodeURIComponent("alice@example.com")}:bad-core-attachment-${index}`,
      });
      const badCorePath = withSourceAuthNonce("/v2/turns?async=1", secret);
      const badCore = await fetch(`${coreBase}${badCorePath}`, {
        method: "POST",
        headers: {
          ...signedHeaders(secret, "POST", badCorePath, badCoreBody),
          [PORTAL_IDENTITY_HEADER]: mintPortalIdentity(
            { p: "alice@example.com", exp: Date.now() + 60_000 },
            portalSecret,
          ),
        },
        body: badCoreBody,
      });
      assert.equal(badCore.status, 400, `Core malformed attachment ${index}`);
    }
    assert.equal((await built.runs.list()).length, 5);
  } finally {
    await new Promise<void>((resolve) => web.close(() => resolve()));
    await new Promise<void>((resolve) => core.close(() => resolve()));
    await built.runtime.stop();
  }
});
