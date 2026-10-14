import type { OrgBranding, OrgTheme, ScopedConfigStore } from "./config-store.ts";
import type { ScopeId } from "../types.ts";
import { swallowAs } from "../util/errors.ts";

const LABEL_STRIP = /[\u0000-\u001F\u007F-\u009F\u2028\u2029<>{}]/g;
const ACCENT_RE = /^#([0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
const MARK_URL_RE = /^https:\/\/[^\s"'()\\;]+$/;
const MARK_URL_CAP = 500;
const THEME_TOKEN_RE = /^[a-z][a-z0-9-]{0,47}$/;
const THEME_COLOR_RE =
  /^(#([0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})|(oklch|oklab|rgb|hsl)\([0-9a-z.%,/ -]{1,60}\))$/;
const THEME_TOKEN_CAP = 64;

export function cleanBrandingLabel(value: unknown, cap: number): string | undefined {
  const cleaned = (typeof value === "string" ? value : "").replace(LABEL_STRIP, "").trim();
  return [...cleaned].slice(0, cap).join("") || undefined;
}

function cleanBrandingMarkUrl(value: unknown): string | undefined {
  const cleaned = (typeof value === "string" ? value : "").replace(LABEL_STRIP, "").trim();
  return cleaned.length <= MARK_URL_CAP && MARK_URL_RE.test(cleaned) ? cleaned : undefined;
}

function cleanThemeTokens(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const tokens: Record<string, string> = {};
  for (const [name, color] of Object.entries(value).slice(0, THEME_TOKEN_CAP)) {
    const cleaned = typeof color === "string" ? color.trim() : "";
    if (THEME_TOKEN_RE.test(name) && THEME_COLOR_RE.test(cleaned)) tokens[name] = cleaned;
  }
  return Object.keys(tokens).length ? tokens : undefined;
}

export function sanitizeTheme(value: unknown): OrgTheme | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as { light?: unknown; dark?: unknown };
  const light = cleanThemeTokens(raw.light);
  const dark = cleanThemeTokens(raw.dark);
  return light || dark ? { ...(light ? { light } : {}), ...(dark ? { dark } : {}) } : undefined;
}

export function sanitizeBranding(raw: {
  accent?: unknown;
  mark?: unknown;
  markUrl?: unknown;
  selfLabel?: unknown;
  orgName?: unknown;
  theme?: unknown;
}): OrgBranding | undefined {
  const accentRaw = (typeof raw.accent === "string" ? raw.accent : "").replace(LABEL_STRIP, "").trim();
  const accent = accentRaw && ACCENT_RE.test(accentRaw) ? accentRaw : undefined;
  const markRaw = typeof raw.mark === "string" ? raw.mark.replace(/["\\]/g, "") : undefined;
  const mark = cleanBrandingLabel(markRaw, 2);
  const markUrl = cleanBrandingMarkUrl(raw.markUrl);
  const selfLabel = cleanBrandingLabel(raw.selfLabel, 40);
  const orgName = cleanBrandingLabel(raw.orgName, 40);
  const theme = sanitizeTheme(raw.theme);
  const branding: OrgBranding = {
    ...(accent ? { accent } : {}),
    ...(mark ? { mark } : {}),
    ...(markUrl ? { markUrl } : {}),
    ...(selfLabel ? { selfLabel } : {}),
    ...(orgName ? { orgName } : {}),
    ...(theme ? { theme } : {}),
  };
  return Object.keys(branding).length ? branding : undefined;
}

export async function resolveBranding(
  config: Pick<ScopedConfigStore, "getBrandingDurable"> | undefined,
  orgScope: ScopeId,
  dflt?: OrgBranding,
): Promise<OrgBranding> {
  const stored = config
    ? await config.getBrandingDurable(orgScope).catch(swallowAs<OrgBranding | null>("branding: durable read", null))
    : null;
  return (
    sanitizeBranding({
      accent: stored?.accent ?? dflt?.accent,
      mark: stored?.mark ?? dflt?.mark,
      markUrl: stored?.markUrl ?? dflt?.markUrl,
      selfLabel: stored?.selfLabel ?? dflt?.selfLabel,
      orgName: stored?.orgName ?? dflt?.orgName,
      theme: stored?.theme ?? dflt?.theme,
    }) ?? {}
  );
}
