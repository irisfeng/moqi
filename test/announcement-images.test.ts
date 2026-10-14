import "./support/auto-fake-sprites.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { buildApp } from "../src/wiring.ts";
import { createInsecureTestServer, createServer } from "../src/api/server.ts";
import { testConfig } from "./support/test-config.ts";

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jF1sAAAAASUVORK5CYII=",
  "base64",
);

test("announcement images require admin uploads, preserve bytes, reject unsupported content and do not expose other files", async () => {
  const built = buildApp(testConfig({ dataDir: mkdtempSync(join(tmpdir(), "announcement-images-")) }));
  const deps = {
    admin: built.admin,
    auditLog: built.auditLog,
    announcements: built.announcements,
    files: built.files,
    blobTransfer: built.blobTransfer,
  };
  const server = createInsecureTestServer(built.app, deps);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const upload = async (data: Buffer, actor = "admin-alice@default-org") => {
    const blob = await built.blobTransfer.put(data);
    const response = await fetch(base + "/v1/admin/announcement-images", {
      method: "POST",
      headers: { "content-type": "application/json", "x-admin-actor": actor },
      body: JSON.stringify({ blobId: blob.blobId }),
    });
    return { response, blob };
  };
  try {
    const denied = await upload(png, "ordinary@default-org");
    assert.equal(denied.response.status, 403);
    const good = await upload(png);
    assert.equal(good.response.status, 201);
    const result = (await good.response.json()) as { id: string; url: string };
    assert.match(result.url, /^\/api\/announcement-images\/[a-f0-9]{32}$/);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(await built.blobTransfer.open(good.blob.blobId), null);
    const image = await fetch(base + "/v1/announcement-images/" + result.id);
    assert.equal(image.status, 200);
    assert.equal(image.headers.get("content-type"), "image/png");
    assert.equal(image.headers.get("x-content-type-options"), "nosniff");
    assert.deepEqual(Buffer.from(await image.arrayBuffer()), png);
    const oversizedDimensions = Buffer.from(png);
    oversizedDimensions.writeUInt32BE(9000, 16);
    for (const bad of [
      oversizedDimensions,
      Buffer.from('<svg onload="alert(1)"></svg>'),
      Buffer.from("<html>fake.png</html>"),
      Buffer.alloc(5 * 1024 * 1024 + 1),
    ]) {
      const denied = await upload(bad);
      assert.equal(denied.response.status, bad.length > 5 * 1024 * 1024 ? 413 : 400);
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.equal(await built.blobTransfer.open(denied.blob.blobId), null);
    }
    await built.files.put({
      id: "a".repeat(32),
      ownerScopeId: "personal:private",
      createdBy: "private",
      name: "private.png",
      path: "artifacts/private.png",
      mimetype: "image/png",
      data: png,
      direction: "in",
    });
    assert.equal((await fetch(base + "/v1/announcement-images/" + "a".repeat(32))).status, 404);
    const body = {
      level: "notice",
      title: "Image bounds",
      body: Array(7).fill(`![image](${result.url})`).join("\n"),
      startsAt: Date.now(),
      endsAt: Date.now() + 60000,
    };
    const excessive = await fetch(base + "/v1/admin/announcements", {
      method: "POST",
      headers: { "content-type": "application/json", "x-admin-actor": "admin-alice@default-org" },
      body: JSON.stringify(body),
    });
    assert.equal(excessive.status, 400);
    await built.files.setEnabled(result.id, false);
    assert.equal((await fetch(base + "/v1/announcement-images/" + result.id)).status, 404);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  const secured = createServer(built.app, { ...deps, signingSecret: "image-test-signing-secret".repeat(3) });
  await new Promise<void>((resolve) => secured.listen(0, resolve));
  try {
    const url = `http://127.0.0.1:${(secured.address() as AddressInfo).port}`;
    assert.equal((await fetch(url + "/v1/announcement-images/" + "a".repeat(32))).status, 401);
  } finally {
    await new Promise<void>((resolve) => secured.close(() => resolve()));
  }
});
