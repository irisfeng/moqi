import { existsSync, readFileSync } from "node:fs";
import { staleEntries, type LineCatalog } from "./translate.ts";

const locale = process.argv[2] ?? "zh-CN";
const catalog = JSON.parse(readFileSync(`i18n/${locale}.json`, "utf8")) as LineCatalog;
let total = 0;
let stale = 0;
for (const [file, table] of Object.entries(catalog)) {
  const entries = Object.keys(table).length;
  const missing = existsSync(file) ? staleEntries(readFileSync(file, "utf8"), table) : Object.keys(table);
  total += entries;
  stale += missing.length;
  if (missing.length > 0) console.log(`${file}: ${missing.length} of ${entries} entries no longer match a source line`);
}
console.log(`${locale}: ${total - stale} of ${total} entries match`);
if (process.argv.includes("--strict") && stale > 0) process.exitCode = 1;
