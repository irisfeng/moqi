import type { Principal } from "../../types.ts";

const LATIN_WORD = /[A-Za-z0-9_]/;

function proseOf(text: string): string {
  return text
    .replace(/```[\s\S]*?(```|$)/g, " ")
    .replace(/`[^`\n]*`/g, " ")
    .split("\n")
    .filter((line) => !line.trimStart().startsWith(">"))
    .join("\n");
}

function startsWithName(rest: string, name: string): boolean {
  if (!rest.startsWith(name)) return false;
  const next = rest[name.length];
  return next === undefined || !LATIN_WORD.test(name.at(-1)!) || !LATIN_WORD.test(next);
}

export function mentionsOtherMember(
  text: string,
  audience: readonly Principal[],
  selfId: string,
  botName: string,
): boolean {
  if (!text.includes("@")) return false;
  const bot = botName.trim().toLowerCase();
  if (bot && text.toLowerCase().includes(bot)) return false;
  const names = audience
    .filter((p) => p.id !== selfId && p.displayName?.trim())
    .flatMap((p) => {
      const full = p.displayName!.trim().toLowerCase();
      const first = full.split(/\s+/)[0]!;
      return first.length >= 2 && first !== full ? [full, first] : [full];
    });
  if (!names.length) return false;
  const prose = proseOf(text).toLowerCase();
  let i = prose.indexOf("@");
  while (i !== -1) {
    const prev = i > 0 ? prose[i - 1]! : "";
    if (!LATIN_WORD.test(prev) && prev !== "/" && prev !== ".") {
      const rest = prose.slice(i + 1);
      if (names.some((name) => startsWithName(rest, name))) return true;
    }
    i = prose.indexOf("@", i + 1);
  }
  return false;
}
