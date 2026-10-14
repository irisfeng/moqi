export type LineTable = Record<string, string>;
export type LineCatalog = Record<string, LineTable>;

export function translateSource(source: string, table: LineTable | undefined): string {
  if (!table) return source;
  return source
    .split("\n")
    .map((line) => {
      const translated = table[line.trim()];
      if (translated === undefined) return line;
      return line.slice(0, line.length - line.trimStart().length) + translated;
    })
    .join("\n");
}

export function staleEntries(source: string, table: LineTable): string[] {
  const present = new Set(source.split("\n").map((line) => line.trim()));
  return Object.keys(table).filter((line) => !present.has(line));
}
