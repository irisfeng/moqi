import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { mintPortalIdentity, PORTAL_IDENTITY_HEADER } from "../../chassis/src/portal-identity.ts";

test(
  "real notification SSE binds delivery IDs and mention run IDs to their existing recipients",
  { timeout: 15_000 },
  async () => {
    const secret = "notification-test-secret";
    const threadRef = "web:alice:project-a";
    let pending = false;
    let provenance: { sourceThreadRef: string; sourceAssistantEntrySeq: number } | undefined;
    const core = createServer((req, res) => {
      req.resume();
      const url = new URL(req.url!, "http://core");
      const path = url.pathname;
      let body: unknown = {};
      if (path === "/v1/deliveries")
        body = {
          deliveries: pending
            ? [
                {
                  id: "delivery-original",
                  idempotencyKey: "post:session-a:nonce",
                  createdAt: Date.now(),
                  destination: { target: threadRef, audienceScopeId: "group:web-project-a" },
                  provenance,
                },
              ]
            : [],
        };
      if (path === "/v1/deliveries/delivery-original/ack") pending = false;
      if (path === "/v1/projects") body = { projects: [{ id: "a", memberIds: ["alice", "bob"] }] };
      if (path === "/v1/directory/resolve")
        body = { matches: [{ principalId: "bob", displayName: "Bob", type: "internal" }] };
      if (path === "/v2/turns") body = { status: "queued", runId: "run-mentioned", sendProtocol: 2 };
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    });
    await new Promise<void>((resolve) => core.listen(0, "127.0.0.1", resolve));
    const reserve = createServer();
    await new Promise<void>((resolve) => reserve.listen(0, "127.0.0.1", resolve));
    const port = (reserve.address() as AddressInfo).port;
    await new Promise<void>((resolve) => reserve.close(() => resolve()));
    const child = spawn(process.execPath, [fileURLToPath(new URL("../server/index.ts", import.meta.url))], {
      env: {
        ...process.env,
        PORT: String(port),
        CORE_API_URL: `http://127.0.0.1:${(core.address() as AddressInfo).port}`,
        CORE_SIGNING_SECRET: secret,
        PORTAL_IDENTITY_SECRET: secret,
        WEB_UI_PRINCIPALS: "alice,bob,eve",
        WEB_UI_DEV: "0",
        WEB_DELIVERY_POLL_MS: "30",
        STATE_FEED_RECONNECT_MS: "10000",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      output += String(chunk);
    });
    const abort = new AbortController();
    const base = `http://127.0.0.1:${port}`;
    const headers = (user: string) => ({
      [PORTAL_IDENTITY_HEADER]: mintPortalIdentity({ p: user, exp: Date.now() + 60_000 }, secret),
      "content-type": "application/json",
    });
    const waitFor = async (predicate: () => boolean) => {
      const deadline = Date.now() + 5000;
      while (!predicate()) {
        if (Date.now() > deadline || child.exitCode !== null)
          throw new Error(`Notification test did not settle: ${output}`);
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    };
    const events = new Map<string, Array<Record<string, unknown>>>();
    const readers: Promise<void>[] = [];
    try {
      await waitFor(() => output.includes("surface on"));
      for (const user of ["alice", "bob", "eve"]) {
        const response = await fetch(`${base}/api/deliveries/events`, { headers: headers(user), signal: abort.signal });
        assert.equal(response.status, 200);
        const collected: Array<Record<string, unknown>> = [];
        events.set(user, collected);
        readers.push(
          (async () => {
            let buffer = "";
            const decoder = new TextDecoder();
            const reader = response.body!.getReader();
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              buffer += decoder.decode(value, { stream: true });
              let end: number;
              while ((end = buffer.indexOf("\n\n")) >= 0) {
                const frame = buffer.slice(0, end);
                buffer = buffer.slice(end + 2);
                if (frame.startsWith("event: delivery\n")) collected.push(JSON.parse(frame.split("data: ")[1]!));
              }
            }
          })().catch(() => {}),
        );
      }
      pending = true;
      await waitFor(() => events.get("alice")!.length === 1 && events.get("bob")!.length === 1 && !pending);
      assert.deepEqual(events.get("alice"), [{ threadRef, deliveryId: "delivery-original" }]);
      assert.deepEqual(events.get("bob"), [{ threadRef, deliveryId: "delivery-original" }]);
      const logical = { text: "@Bob 请查看", threadRef, expectedUser: "alice", scopeId: "group:web-project-a" };
      const response = await fetch(`${base}/api/turn/v2`, {
        method: "POST",
        headers: headers("alice"),
        body: JSON.stringify({
          ...logical,
          idempotencyKey: "mention-send",
          clientRequestFingerprint: createHash("sha256").update(JSON.stringify(logical)).digest("hex"),
        }),
      });
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { status: "queued", runId: "run-mentioned", sendProtocol: 2 });
      await waitFor(() => events.get("bob")!.length === 2);
      assert.deepEqual(events.get("bob")!.at(-1), { threadRef, runId: "run-mentioned" });
      assert.deepEqual(events.get("eve"), []);
      assert.equal(events.get("alice")!.length, 1);
      provenance = { sourceThreadRef: threadRef, sourceAssistantEntrySeq: 0 };
      pending = true;
      await waitFor(() => events.get("alice")!.length === 2 && events.get("bob")!.length === 3 && !pending);
      assert.deepEqual(events.get("alice")!.at(-1), { threadRef, seq: 0 });
      provenance = { sourceThreadRef: "web:other:thread", sourceAssistantEntrySeq: 9 };
      pending = true;
      await waitFor(() => events.get("alice")!.length === 3 && !pending);
      assert.deepEqual(events.get("alice")!.at(-1), { threadRef, deliveryId: "delivery-original" });
      assert.deepEqual(events.get("eve"), []);
    } finally {
      abort.abort();
      child.kill("SIGTERM");
      await Promise.allSettled(readers);
      core.closeAllConnections();
      await new Promise<void>((resolve) => core.close(() => resolve()));
    }
  },
);
