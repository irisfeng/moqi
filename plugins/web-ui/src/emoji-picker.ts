import { EMOJI_ROWS, type EmojiRow } from "./emoji-data.ts";

export type { EmojiRow };

function normalizeName(name: string): string {
  return name.toLowerCase().replaceAll("-", "_");
}

const names = new Map<string, EmojiRow>();
for (const row of EMOJI_ROWS) {
  for (const name of [row.n, ...(row.a ?? [])]) {
    const normalized = normalizeName(name);
    if (!names.has(normalized)) names.set(normalized, row);
  }
}

export function rowForName(name: string): EmojiRow | null {
  return names.get(normalizeName(name)) ?? null;
}

export function matchesQuery(row: EmojiRow, needle: string): boolean {
  if (!needle) return true;
  if (normalizeName(row.n).includes(normalizeName(needle))) return true;
  return (row.a ?? []).some((alias) => normalizeName(alias).includes(normalizeName(needle)));
}

export function filterEmoji(rows: readonly EmojiRow[], query: string): EmojiRow[] {
  const needle = query.trim().toLowerCase().replace(/^:+/, "").replace(/:+$/, "");
  if (!needle) return [...rows];
  return rows.filter((row) => matchesQuery(row, needle));
}

export function groupEmoji(
  rows: readonly EmojiRow[],
  order: readonly string[],
): Array<{ group: string; rows: EmojiRow[] }> {
  const byGroup = new Map<string, EmojiRow[]>();
  for (const row of rows) {
    const bucket = byGroup.get(row.g);
    if (bucket) bucket.push(row);
    else byGroup.set(row.g, [row]);
  }
  return order.filter((g) => byGroup.has(g)).map((group) => ({ group, rows: byGroup.get(group)! }));
}

export function charForName(name: string): string | null {
  return rowForName(name)?.c ?? null;
}

const NAME_CHARS = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_+-";
const COLONS = ":：";
const BEFORE_TOKEN = " \n\t\u3000，。！？；、（【《“‘";
const POPULAR = ["+1", "smile", "joy", "heart", "tada", "pray", "ok_hand", "fire"];
const SUGGESTION_LIMIT = 8;

export interface EmojiToken {
  start: number;
  end: number;
  query: string;
  complete: boolean;
  text: string;
}

export function emojiToken(value: string, caret: number): EmojiToken | null {
  const complete = COLONS.includes(value[caret - 1] ?? "\0") && NAME_CHARS.includes(value[caret - 2] ?? "\0");
  const end = complete ? caret - 1 : caret;
  let start = end;
  while (start > 0 && NAME_CHARS.includes(value[start - 1] ?? "\0")) start--;
  if (!COLONS.includes(value[start - 1] ?? "\0")) return null;
  start--;
  if (start > 0 && !BEFORE_TOKEN.includes(value[start - 1] ?? "\0")) return null;
  return { start, end: caret, query: value.slice(start + 1, end), complete, text: value.slice(start, caret) };
}

export function emojiSuggestions(query: string): EmojiRow[] {
  if (!query) return POPULAR.flatMap((name) => rowForName(name) ?? []);
  const matches = filterEmoji(EMOJI_ROWS, query).slice(0, SUGGESTION_LIMIT);
  const exact = rowForName(query);
  return exact ? [exact, ...matches.filter((row) => row !== exact)].slice(0, SUGGESTION_LIMIT) : matches;
}
