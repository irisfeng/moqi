#!/usr/bin/env node
import { readFileSync } from "node:fs";

const adminUrl = process.argv[2] ?? "http://localhost:8083";
const cmd = process.argv[3];
const id = process.argv[4];
const url = process.argv[5];
const cookie = process.env.ADMIN_COOKIE;

if (!cookie || !cmd || (cmd === "put" && (!id || !url))) {
  console.error(
    "usage: ADMIN_COOKIE='<admin cookie>' node mcp-register.mjs [admin-url] put <id> <url> [--read-only]\n" +
      "       ADMIN_COOKIE='<admin cookie>' node mcp-register.mjs [admin-url] delete <id>\n" +
      "       ADMIN_COOKIE='<admin cookie>' node mcp-register.mjs [admin-url] list\n" +
      "admin cookie：浏览器登录管理后台后 F12 → 网络/存储 里的 admin cookie 值。",
  );
  process.exit(1);
}

async function call(method, path, body) {
  const res = await fetch(`${adminUrl}${path}`, {
    method,
    headers: { cookie: `admin=${cookie}`, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  console.log(res.status, text.slice(0, 400));
  process.exit(res.ok ? 0 : 1);
}

if (cmd === "list") {
  void call("GET", "/api/mcp-servers");
} else if (cmd === "delete") {
  void call("DELETE", `/api/mcp-servers/${encodeURIComponent(id)}`);
} else if (cmd === "put") {
  const readOnly = process.argv.includes("--read-only");
  void call("PUT", `/api/mcp-servers/${encodeURIComponent(id)}`, {
    name: id,
    url,
    auth: "none",
    readOnly,
    enabled: true,
  });
}
