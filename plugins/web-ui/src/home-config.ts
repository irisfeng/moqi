import { UI_BASE } from "./deep-link.ts";

type TipLayer = "icebreak" | "task" | "collab" | "advanced";

export interface HomeTip {
  id: string;
  layer: TipLayer;
  title: string;
  oneLiner: string;
  prompt: string;
  capability: string;
  depts: string[];
  status: "active" | "deferred";
}

interface WelcomeRole {
  id: string;
  label: string;
  tips: string[];
}

export interface WebuiHomeConfig {
  welcome: { headline: string; subline: string; roles: WelcomeRole[] };
  composerPlaceholder: string;
  tips: HomeTip[];
  nav: { advancedGroup: string[] };
  opener: { enabled: boolean };
}

export const NEUTRAL_HOME: WebuiHomeConfig = {
  welcome: { headline: "What are we working on today?", subline: "", roles: [] },
  composerPlaceholder: "",
  tips: [],
  nav: { advancedGroup: [] },
  opener: { enabled: true },
};

async function loadWebuiHome(): Promise<WebuiHomeConfig | null> {
  try {
    const res = await fetch(`${UI_BASE}/api/home-config`);
    if (!res.ok) return null;
    const body = (await res.json()) as Partial<WebuiHomeConfig>;
    if (!body || typeof body !== "object" || !body.welcome) return null;
    return { ...NEUTRAL_HOME, ...body } as WebuiHomeConfig;
  } catch {
    return null;
  }
}

let homeConfig: WebuiHomeConfig | null = null;
let homeLoading: Promise<WebuiHomeConfig | null> | null = null;

export function ensureWebuiHome(): Promise<WebuiHomeConfig | null> {
  homeLoading ??= loadWebuiHome().then((config) => {
    homeConfig = config;
    return config;
  });
  return homeLoading;
}

export function webuiHome(): WebuiHomeConfig | null {
  return homeConfig;
}

export function reportHomeEvent(type: string, ref: string): void {
  try {
    void fetch(`${UI_BASE}/api/home-event`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type, ref }),
    }).catch(() => undefined);
  } catch {
    return;
  }
}

export function activeTips(config: WebuiHomeConfig): HomeTip[] {
  return config.tips.filter((t) => t.status === "active");
}

function hashSeed(userKey: string, dateKey: string): number {
  let h = 2166136261;
  const s = `${dateKey}:${userKey}`;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h);
}

export function pickDaily<T>(pool: T[], userKey: string, dateKey: string, count: number, offset = 0): T[] {
  if (pool.length === 0) return [];
  const seed = hashSeed(userKey, dateKey) + offset * 7919;
  const out: T[] = [];
  const used = new Set<number>();
  for (let i = 0; i < Math.min(count, pool.length); i++) {
    let idx = (seed + i * 48271) % pool.length;
    while (used.has(idx)) idx = (idx + 1) % pool.length;
    used.add(idx);
    out.push(pool[idx]!);
  }
  return out;
}

export function scenarioCards(config: WebuiHomeConfig, userKey: string, dateKey: string, count = 3): HomeTip[] {
  return pickDaily(activeTips(config), userKey, dateKey, count);
}

export function dateKeyOf(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
