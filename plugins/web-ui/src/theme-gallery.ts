export type GalleryTheme = {
  id: string;
  name: string;
  light: Record<string, string>;
  dark: Record<string, string>;
};

export const PALETTE_KEY = "theme:palette";
const ID_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;
const TOKEN_PATTERN = /^[a-z][a-z0-9-]{0,47}$/;
const COLOR_PATTERN = /^#([0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
const ORG_MARKER = "html:not(.dark){";

function half(value: unknown): Record<string, string> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const entries = Object.entries(value);
  if (!entries.length) return null;
  const tokens: Record<string, string> = {};
  for (const [name, color] of entries) {
    if (!TOKEN_PATTERN.test(name) || typeof color !== "string" || !COLOR_PATTERN.test(color)) return null;
    tokens[name] = color;
  }
  return tokens;
}

function theme(value: unknown): GalleryTheme | null {
  const entry = value as { id?: unknown; name?: unknown; light?: unknown; dark?: unknown } | null;
  if (typeof entry?.id !== "string" || !ID_PATTERN.test(entry.id)) return null;
  if (typeof entry.name !== "string" || !entry.name || Array.from(entry.name).length > 12) return null;
  const light = half(entry.light);
  const dark = half(entry.dark);
  return light && dark ? { id: entry.id, name: entry.name, light, dark } : null;
}

export function galleryThemes(doc: Document): GalleryTheme[] {
  const raw = doc.getElementById("coworker-themes")?.textContent;
  if (!raw) return [];
  try {
    const list = (JSON.parse(raw) as { themes?: unknown }).themes;
    if (!Array.isArray(list)) return [];
    const seen = new Set<string>();
    const themes: GalleryTheme[] = [];
    for (const entry of list) {
      const parsed = theme(entry);
      if (!parsed || seen.has(parsed.id)) continue;
      seen.add(parsed.id);
      themes.push(parsed);
    }
    return themes;
  } catch {
    return [];
  }
}

function declarations(tokens: Record<string, string>): string {
  return Object.entries(tokens)
    .map(([name, color]) => `--${name}:${color}`)
    .join(";");
}

export function galleryCss(palette: GalleryTheme): string {
  return `html:root:not(.dark){${declarations(palette.light)}}html:root.dark{${declarations(palette.dark)}}`;
}

function orgLight(doc: Document): Record<string, string> | null {
  for (const style of Array.from(doc.head.querySelectorAll("style"))) {
    const text = style.textContent ?? "";
    const start = text.indexOf(ORG_MARKER);
    if (start < 0) continue;
    const body = text.slice(start + ORG_MARKER.length, text.indexOf("}", start));
    const tokens: Record<string, string> = {};
    for (const declaration of body.split(";")) {
      const colon = declaration.indexOf(":");
      if (colon < 0) continue;
      tokens[declaration.slice(0, colon).trim().toLowerCase()] = declaration
        .slice(colon + 1)
        .trim()
        .toLowerCase();
    }
    return tokens;
  }
  return null;
}

export function orgThemeId(doc: Document, themes: GalleryTheme[]): string | null {
  const org = orgLight(doc);
  if (!org) return null;
  const keys = ["background", "foreground", "cta"];
  const match = themes.find((candidate) =>
    keys.every((key) => org[`--${key}`] !== undefined && org[`--${key}`] === candidate.light[key]?.toLowerCase()),
  );
  return match?.id ?? null;
}

export function storedPalette(): string | null {
  try {
    return localStorage.getItem(PALETTE_KEY);
  } catch {
    return null;
  }
}

export function storePalette(id: string | null): void {
  try {
    if (id) localStorage.setItem(PALETTE_KEY, id);
    else localStorage.removeItem(PALETTE_KEY);
  } catch {
    void 0;
  }
}
