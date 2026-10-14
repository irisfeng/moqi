import { mintPortalIdentity, PORTAL_IDENTITY_HEADER } from "../../chassis/src/portal-identity.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { createHash } from "node:crypto";

interface RecordedBlob {
  sha: string;
  bytes: number;
}
const blobUploads: RecordedBlob[] = [];
type TurnBody = {
  attachments?: Array<{ name?: string; blobId?: string; sizeBytes?: number; mimetype?: string }>;
  text?: string;
  harness?: string;
  model?: string;
};
let lastTurnBody: TurnBody | null = null;
let turnsReceived = 0;
const setTurnBody = (b: TurnBody | null): void => {
  lastTurnBody = b;
};

const core = createServer((req: IncomingMessage, res) => {
  const u = req.url ?? "";
  if (req.method === "POST" && u.startsWith("/v1/blobs")) {
    const sha = String(req.headers["x-content-sha256"] ?? "");
    let size = 0;
    req.on("data", (c: Buffer) => (size += c.length));
    return void req.on("end", () => {
      blobUploads.push({ sha, bytes: size });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ blobId: `blob-${sha.slice(0, 8)}`, sizeBytes: size }));
    });
  }
  if (req.method === "POST" && u.startsWith("/v2/turns")) {
    let body = "";
    req.on("data", (c) => (body += c));
    return void req.on("end", () => {
      turnsReceived += 1;
      try {
        setTurnBody(JSON.parse(body) as TurnBody);
      } catch {
        setTurnBody(null);
      }
      res.writeHead(202, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: "queued", runId: "run-1", sendProtocol: 2 }));
    });
  }
  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: "not_found" }));
});
await new Promise<void>((r) => core.listen(0, r));
const coreUrl = `http://localhost:${(core.address() as AddressInfo).port}`;

const SECRET = "blob-route-test-secret";
process.env.CORE_API_URL = coreUrl;
process.env.CORE_SIGNING_SECRET = SECRET;
process.env.WEB_UI_PRINCIPALS = "alice";

const { handler } = await import("../server/index.ts");

const surface = createServer((req, res) => void handler(req, res));
await new Promise<void>((r) => surface.listen(0, r));
const base = `http://localhost:${(surface.address() as AddressInfo).port}`;

test.after(() => {
  surface.close();
  core.close();
});

const IDENTITY = {
  cookie: "webuiuser=alice",
  [PORTAL_IDENTITY_HEADER]: mintPortalIdentity({ p: "alice", exp: Date.now() + 60_000 }, SECRET),
};

test("POST /api/blobs streams the body to core with the declared sha and relays { blobId, sizeBytes }", async () => {
  const bytes = Buffer.alloc(5 * 1024 * 1024, 7);
  const sha = createHash("sha256").update(bytes).digest("hex");
  const before = blobUploads.length;
  const r = await fetch(`${base}/api/blobs?sha=${sha}`, {
    method: "POST",
    headers: { ...IDENTITY, "content-type": "application/octet-stream" },
    body: bytes,
  });
  assert.equal(r.status, 200, "a >1 MB upload streams through without 413");
  const json = (await r.json()) as { blobId: string; sizeBytes: number };
  assert.equal(json.blobId, `blob-${sha.slice(0, 8)}`, "core's blobId is relayed verbatim");
  assert.equal(json.sizeBytes, bytes.length);
  const recorded = blobUploads.slice(before);
  assert.equal(recorded.length, 1, "exactly one blob reached core");
  assert.equal(recorded[0]!.sha, sha, "the declared sha is forwarded to core (source-auth signs over it)");
  assert.equal(recorded[0]!.bytes, bytes.length, "all bytes streamed through, not capped");
});

test("POST /api/blobs rejects a missing/invalid sha with 400 (never reaches core)", async () => {
  const before = blobUploads.length;
  const r = await fetch(`${base}/api/blobs`, {
    method: "POST",
    headers: { ...IDENTITY, "content-type": "application/octet-stream" },
    body: Buffer.from("hi"),
  });
  assert.equal(r.status, 400);
  assert.equal(blobUploads.length, before, "no blob reached core when the sha is absent");
});

test("POST /api/blobs requires a signed-in user (401 before any core call)", async () => {
  const before = blobUploads.length;
  const sha = createHash("sha256").update("x").digest("hex");
  const r = await fetch(`${base}/api/blobs?sha=${sha}`, {
    method: "POST",
    headers: { "content-type": "application/octet-stream" },
    body: Buffer.from("x"),
  });
  assert.equal(r.status, 401, "unauthenticated upload is denied");
  assert.equal(blobUploads.length, before, "no upload forwarded for an unauthenticated request");
});

test("the sha rides as a query param (portal-safe): a custom header is NOT how the surface reads it", async () => {
  const before = blobUploads.length;
  const sha = createHash("sha256").update("y").digest("hex");
  const r = await fetch(`${base}/api/blobs`, {
    method: "POST",
    headers: { ...IDENTITY, "content-type": "application/octet-stream", "x-content-sha256": sha },
    body: Buffer.from("y"),
  });
  assert.equal(r.status, 400, "a header-only sha is ignored — the route reads the query param");
  assert.equal(blobUploads.length, before, "no blob reached core for a header-only sha");
});

function verifiedSend(fields: {
  text: string;
  threadRef: string;
  harness?: string;
  model?: string;
  attachments?: Array<Record<string, unknown>>;
}): Promise<Response> {
  const logical = {
    text: fields.text,
    threadRef: fields.threadRef,
    expectedUser: "alice",
    ...(fields.harness ? { harness: fields.harness } : {}),
    ...(fields.model ? { model: fields.model } : {}),
    ...(fields.attachments ? { attachments: fields.attachments } : {}),
  };
  return fetch(`${base}/api/turn/v2`, {
    method: "POST",
    headers: { ...IDENTITY, "content-type": "application/json" },
    body: JSON.stringify({
      ...logical,
      idempotencyKey: crypto.randomUUID(),
      clientRequestFingerprint: createHash("sha256").update(JSON.stringify(logical)).digest("hex"),
    }),
  });
}

test("a verified send forwards blobId attachments to core as references (no inline bytes)", async () => {
  setTurnBody(null);
  const r = await verifiedSend({
    text: "here is a file",
    threadRef: "web:alice:t1",
    harness: "codex",
    model: "gpt-5.6-sol",
    attachments: [
      { name: "big.bin", mimetype: "application/octet-stream", sizeBytes: 5242880, blobId: "a".repeat(32) },
    ],
  });
  assert.equal(r.status, 202);
  assert.ok(lastTurnBody, "core received the turn");
  const atts = lastTurnBody!.attachments ?? [];
  assert.equal(atts.length, 1, "the attachment is forwarded");
  assert.equal(atts[0]!.blobId, "a".repeat(32), "the turn carries the blobId reference");
  assert.equal(atts[0]!.name, "big.bin");
  assert.equal(atts[0]!.sizeBytes, 5242880);
  assert.equal((atts[0] as Record<string, unknown>).contentBase64, undefined, "no inline bytes ride the turn body");
  assert.equal(lastTurnBody!.harness, "codex", "the selected harness reaches core");
  assert.equal(lastTurnBody!.model, "gpt-5.6-sol", "the selected model reaches core");
});

test("a verified send refuses an attachment with no blobId instead of forwarding junk", async () => {
  const before = turnsReceived;
  const r = await verifiedSend({
    text: "msg",
    threadRef: "web:alice:t2",
    attachments: [{ name: "no-blob.txt", mimetype: "text/plain", sizeBytes: 3 }],
  });
  assert.equal(r.status, 400);
  assert.equal(turnsReceived, before, "nothing reaches core");
});

test("a verified send accepts retired model ids from existing conversations", async () => {
  for (const [harness, model] of [
    ["codex", "gpt-5.5"],
    ["claude", "claude-sonnet-4-6"],
  ]) {
    const r = await verifiedSend({ text: "continue", threadRef: `web:alice:${model}`, harness, model });
    assert.equal(r.status, 202, `${model} remains accepted during blue-green rollout`);
  }
});
