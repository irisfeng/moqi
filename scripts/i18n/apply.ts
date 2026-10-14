import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { translateSource, type LineCatalog } from "./translate.ts";

interface ApplyResult {
  files: number;
  missing: string[];
}

export function applyCatalog(root: string, catalog: LineCatalog): ApplyResult {
  if (existsSync(join(root, ".git")))
    throw new Error(`${root} is a Git checkout; apply the catalog to an exported copy`);
  const missing: string[] = [];
  let files = 0;
  for (const [file, table] of Object.entries(catalog)) {
    const path = join(root, file);
    if (!existsSync(path)) {
      missing.push(file);
      continue;
    }
    const source = readFileSync(path, "utf8");
    const translated = translateSource(source, table);
    if (translated === source) continue;
    writeFileSync(path, translated);
    files += 1;
  }
  return { files, missing };
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [locale, target] = process.argv.slice(2);
  if (!locale || !target) {
    console.error("usage: node scripts/i18n/apply.ts <locale> <exported tree>");
    process.exit(2);
  }
  const catalog = JSON.parse(readFileSync(`i18n/${locale}.json`, "utf8")) as LineCatalog;
  const result = applyCatalog(resolve(target), catalog);
  for (const file of result.missing) console.log(`${file}: not in the exported tree`);
  console.log(`${locale}: ${result.files} files rewritten`);
}
