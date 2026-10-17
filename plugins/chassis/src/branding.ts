export interface OrgTheme {
  light?: Record<string, string>;
  dark?: Record<string, string>;
}

export interface OrgBranding {
  theme?: OrgTheme;
  orgName?: string;
  accent?: string;
  mark?: string;
  markUrl?: string;
  selfLabel?: string;
}

export { BRAND_MARK_SVG } from "./brand-mark.ts";

const REFRESH_MS = 30_000;
const RETRY_MS = 5_000;
const FIRST_RENDER_WAIT_MS = 1_500;

export interface BrandingCache {
  current(): OrgBranding;
  forRender(): Promise<OrgBranding>;
  refreshNow(): Promise<void>;
}

export function createBrandingCache(fetchBranding: () => Promise<OrgBranding>): BrandingCache {
  let value: OrgBranding = {};
  let warmed = false;
  let nextAt = 0;
  let inflight: Promise<void> | null = null;

  const kick = (): void => {
    if (inflight || Date.now() < nextAt) return;
    inflight = (async () => {
      try {
        value = await fetchBranding();
        if (process.env.BRANDING_DEBUG) console.error("[branding] fetched:", JSON.stringify(value));
        warmed = true;
        nextAt = Date.now() + REFRESH_MS;
      } catch (err) {
        if (process.env.BRANDING_DEBUG) console.error("[branding] fetch failed:", String(err));
        nextAt = Date.now() + RETRY_MS;
      } finally {
        inflight = null;
      }
    })();
  };
  setTimeout(kick, 0);

  return {
    current: () => value,
    async forRender(): Promise<OrgBranding> {
      kick();
      if (!warmed && inflight) {
        await Promise.race([inflight, new Promise((r) => setTimeout(r, FIRST_RENDER_WAIT_MS))]);
      }
      return value;
    },
    async refreshNow(): Promise<void> {
      if (inflight) await inflight;
      nextAt = 0;
      kick();
      if (inflight) await inflight;
    },
  };
}

const escapeAttr = (v: string): string =>
  v.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const CSS_HOSTILE = /[<>{}"'();\\]/;
const cssSafe = (v: string | undefined): v is string => !!v && !CSS_HOSTILE.test(v);
const cssUrlSafe = (v: string | undefined): v is string => cssSafe(v) && /^https:\/\/\S+$/.test(v);

const THEME_TOKEN = /^[a-z][a-z0-9-]{0,47}$/;
const THEME_COLOR =
  /^(#([0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})|(oklch|oklab|rgb|hsl)\([0-9a-z.%,/ -]{1,60}\))$/;

function themeDecls(tokens: Record<string, string> | undefined): string {
  if (!tokens || typeof tokens !== "object") return "";
  return Object.entries(tokens)
    .filter(([name, color]) => THEME_TOKEN.test(name) && typeof color === "string" && THEME_COLOR.test(color))
    .map(([name, color]) => `--${name}:${color}`)
    .join(";");
}

export function themeCss(theme: OrgTheme | undefined): string {
  const light = themeDecls(theme?.light);
  const dark = themeDecls(theme?.dark);
  return `${light ? `html:not(.dark){${light}}` : ""}${dark ? `html.dark{${dark}}` : ""}`;
}

export function injectBranding(
  html: string,
  branding: OrgBranding,
  opts?: { titleSuffix?: string; keepIcon?: boolean },
): string {
  const { accent, mark, markUrl, selfLabel } = branding;
  let out = html;
  if (selfLabel) {
    out = out.replace(
      /(<meta name="brand-self-label" content=")[^"]*(")/,
      (_m, pre: string, post: string) => `${pre}${escapeAttr(selfLabel)}${post}`,
    );
    out = out.replace(
      /(<meta name="apple-mobile-web-app-title" content=")[^"]*(")/,
      (_m, pre: string, post: string) => `${pre}${escapeAttr(selfLabel)}${post}`,
    );
    if (opts?.titleSuffix) {
      const title = escapeAttr(`${selfLabel} ${opts.titleSuffix}`);
      out = out.replace(/<title>[^<]*<\/title>/, () => `<title>${title}</title>`);
    }
  }
  const decls = [
    ...(cssSafe(accent) ? [`--brand-accent:${accent}`] : []),
    ...(cssSafe(mark) ? [`--brand-mark:"${mark}"`] : []),
    ...(cssUrlSafe(markUrl) ? [`--brand-mark-image:url("${markUrl}")`] : []),
  ].join(";");
  const css = `${decls ? `:root{${decls}}` : ""}${themeCss(branding.theme)}`;
  if (css) out = out.replace("</head>", () => `<style>${css}</style></head>`);
  if (cssUrlSafe(markUrl) && !opts?.keepIcon) {
    const icon = `<link rel="icon" href="${escapeAttr(markUrl)}" />`;
    out = out.replace(/<link rel="icon"[^>]*>\s*/g, "").replace("</head>", () => `${icon}</head>`);
  }
  return out;
}

export function markSlackOff(html: string, off: boolean): string {
  if (!off) return html;
  return html.replace(/<html(?=[\s>])/, '<html data-slack="off"');
}
