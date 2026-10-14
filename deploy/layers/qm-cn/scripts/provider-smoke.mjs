#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { PROVIDER_KEY_ENV } from "../providers/provider-key-env.mjs";

const results = [];
function record(status, name, detail) {
  results.push({ status, name, detail });
  console.log(`${status.padEnd(4)} ${name}${detail ? ` — ${detail}` : ""}`);
}

async function chat(spec, apiKey, model, { stream = false, tools, extra = {}, key = apiKey, prompt } = {}) {
  const body = {
    model,
    messages: [
      { role: "user", content: prompt ?? (tools ? "北京现在天气怎么样？请用工具查。" : "用一句话回答：1+1 等于几？") },
    ],
    ...(tools ? { tools } : {}),
    ...extra,
  };
  const res = await fetch(`${spec.baseUrl}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify({ ...body, ...(stream ? { stream: true, stream_options: { include_usage: true } } : {}) }),
    signal: AbortSignal.timeout(60_000),
  });
  return res;
}

const WEATHER_TOOL = {
  type: "function",
  function: {
    name: "get_weather",
    description: "查询城市当前天气",
    parameters: {
      type: "object",
      properties: { city: { type: "string" } },
      required: ["city"],
    },
  },
};

async function main() {
  const templatePath = process.argv[2];
  if (!templatePath) {
    console.error("usage: node provider-smoke.mjs <template.json> [model-id]");
    process.exit(2);
  }
  const spec = JSON.parse(readFileSync(templatePath, "utf8"));
  const slug = basename(templatePath).replace(/\.json$/, "");
  const apiKey = process.env[PROVIDER_KEY_ENV[slug] ?? ""] ?? process.env.SMOKE_API_KEY;
  const models = spec.models.filter((m) => !String(m.id).startsWith("REPLACE_WITH"));
  const model = process.argv[3] ?? models[0]?.id;
  if (!apiKey) {
    console.error("no API key: set the provider's *_API_KEY env or SMOKE_API_KEY");
    process.exit(2);
  }
  if (!model) {
    console.error("template has no usable model id (placeholder?)");
    process.exit(2);
  }

  if (spec.validate !== false) {
    try {
      const res = await fetch(`${spec.baseUrl}/models`, {
        headers: { authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(15_000),
      });
      record(res.ok ? "PASS" : "FAIL", "models-listing", `GET /models -> HTTP ${res.status}`);
    } catch (error) {
      record("FAIL", "models-listing", String(error));
    }
  } else {
    record("INFO", "models-listing", "skipped (template sets validate:false)");
  }

  try {
    const res = await chat(spec, apiKey, model, { tools: [WEATHER_TOOL], extra: { tool_choice: "auto" } });
    const json = await res.json();
    if (!res.ok) {
      record("FAIL", "tool-call-nonstream", `HTTP ${res.status}: ${JSON.stringify(json).slice(0, 200)}`);
    } else {
      const message = json.choices?.[0]?.message ?? {};
      const called = message.tool_calls?.[0]?.function?.name === "get_weather";
      record(
        called ? "PASS" : "INFO",
        "tool-call-nonstream",
        called ? "tool_calls[0].function.name == get_weather" : "no tool call; inspect manually",
      );
      record(
        json.usage ? "PASS" : "FAIL",
        "usage-nonstream",
        json.usage ? `prompt=${json.usage.prompt_tokens} completion=${json.usage.completion_tokens}` : "usage missing",
      );
      if (json.usage && "prompt_cache_hit_tokens" in json.usage) {
        record(
          "INFO",
          "usage-cache-partition",
          `prompt_cache_hit_tokens=${json.usage.prompt_cache_hit_tokens} prompt_cache_miss_tokens=${json.usage.prompt_cache_miss_tokens}`,
        );
      }
    }
  } catch (error) {
    record("FAIL", "tool-call-nonstream", String(error));
  }

  try {
    const res = await chat(spec, apiKey, model, { stream: true });
    const text = await res.text();
    if (!res.ok) {
      record("FAIL", "stream-usage", `HTTP ${res.status}: ${text.slice(0, 200)}`);
    } else {
      const chunks = text
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim())
        .filter((payload) => payload !== "[DONE]");
      const withUsage = chunks.filter((payload) => {
        try {
          return Boolean(JSON.parse(payload).usage);
        } catch {
          return false;
        }
      });
      const done = text.includes("[DONE]");
      record(
        withUsage.length === 1 ? "PASS" : "INFO",
        "stream-usage",
        `${withUsage.length} usage chunk(s)${done ? "" : ", no [DONE]"}`,
      );
    }
  } catch (error) {
    record("FAIL", "stream-usage", String(error));
  }

  const card = models.find((m) => m.id === model);
  if (card?.reasoning) {
    try {
      const res = await chat(spec, apiKey, model, {});
      const json = await res.json();
      const message = json.choices?.[0]?.message ?? {};
      const sawReasoning = message.reasoning_content != null || message.reasoning != null;
      record(
        "INFO",
        "reasoning-trace",
        sawReasoning
          ? "reasoning_content present in non-stream reply"
          : "no reasoning_content — provider may emit only when prompted",
      );
    } catch (error) {
      record("INFO", "reasoning-trace", String(error));
    }
  }

  try {
    const res = await chat(spec, "", model, { key: "sk-invalid-smoke-key" });
    record(!res.ok ? "PASS" : "FAIL", "invalid-key-rejected", `HTTP ${res.status}`);
  } catch (error) {
    record("INFO", "invalid-key-rejected", String(error));
  }

  const failed = results.filter((r) => r.status === "FAIL").length;
  console.log(
    `\n${slug} / ${model}: ${results.filter((r) => r.status === "PASS").length} pass, ${failed} fail, ${results.filter((r) => r.status === "INFO").length} info`,
  );
  process.exit(failed > 0 ? 1 : 0);
}

await main();
