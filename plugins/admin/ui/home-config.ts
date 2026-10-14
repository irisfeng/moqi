import { html, nothing } from "lit";
import { card, renderer } from "./shared.ts";

const FEATURED_SCENE_IDS = ["W01", "W11", "W25", "W05", "W09", "W13"];

export function homeTemplate(): Record<string, unknown> {
  return {
    welcome: { headline: "What are we working on today?", subline: "", roles: [] },
    composerPlaceholder: "",
    tips: FEATURED_SCENE_IDS.map((id) => ({
      id,
      layer: "task",
      title: id,
      oneLiner: "",
      prompt: "",
      capability: "",
      depts: [],
      status: "active",
    })),
    nav: { advancedGroup: [] },
    opener: { enabled: true },
  };
}

export function parseHomeDraft(text: string): { home?: Record<string, any>; error?: string } {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { error: "The configuration is not valid JSON." };
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    return { error: "The configuration must be a JSON object." };
  const home = value as Record<string, any>;
  if (!home.welcome || typeof home.welcome !== "object") return { error: "The configuration needs a welcome section." };
  if (home.tips !== undefined && !Array.isArray(home.tips)) return { error: "Tips must be a list." };
  if (text.length > 200000) return { error: "The configuration cannot exceed 200000 characters." };
  return { home };
}

export function homeSummary(home: Record<string, any>): { scenes: number; tips: number; roles: number } {
  const tips: any[] = Array.isArray(home.tips) ? home.tips : [];
  const active = tips.filter((tip) => tip?.status === "active");
  return {
    scenes: active.filter((tip) => FEATURED_SCENE_IDS.includes(tip?.id)).length,
    tips: active.length,
    roles: Array.isArray(home.welcome?.roles) ? home.welcome.roles.length : 0,
  };
}

export function homeConfig(root: HTMLElement, d: any, s: Record<string, any>) {
  const paint = renderer(root);
  const stored = d?.home && typeof d.home === "object" ? (d.home as Record<string, any>) : null;
  s.defaultShell({ stats: [[stored ? "Custom" : "Built-in", "Home page"]] });
  let text = stored ? JSON.stringify(stored, null, 2) : "";
  let pending = false;
  let message = "";
  let tone = "";
  const say = (next: string, kind = "") => {
    message = next;
    tone = kind;
    draw();
  };
  const edit = (change: (home: Record<string, any>) => void) => {
    const parsed = parseHomeDraft(text);
    if (!parsed.home) return;
    change(parsed.home);
    text = JSON.stringify(parsed.home, null, 2);
    draw();
  };
  const failure = (r: any, fallback: string) =>
    r.status === 403
      ? "Only organization admins can change the home page."
      : r.data?.message || r.data?.error || fallback;
  const save = async () => {
    const parsed = parseHomeDraft(text);
    if (!parsed.home) return say(parsed.error!, "err");
    pending = true;
    say("Saving…", "saving");
    const r = await s.api("PUT", "/api/scopes/" + encodeURIComponent(s.orgScope()) + "/webui-home", {
      home: parsed.home,
    });
    pending = false;
    if (!r.ok) return say(failure(r, "Save failed."), "err");
    s.reload();
  };
  const restore = async () => {
    if (!s.confirm("Remove the custom home page? Everyone will see the built-in welcome until a new one is saved."))
      return;
    pending = true;
    say("Removing…", "saving");
    const r = await s.api("PUT", "/api/scopes/" + encodeURIComponent(s.orgScope()) + "/webui-home", { clear: true });
    pending = false;
    if (!r.ok) return say(failure(r, "Remove failed."), "err");
    s.reload();
  };
  function draw() {
    const parsed = text.trim() ? parseHomeDraft(text) : {};
    const home = parsed.home;
    const summary = home ? homeSummary(home) : null;
    paint(
      html`<div class="list-root">
        ${card(
          "Home page",
          "What people see on the home page before they start a conversation: the welcome line, the featured scenes and the tips. Changes apply the next time a person loads the page, with no deploy needed.",
          html`${
              summary
                ? html`<p class="hint" id="home-summary">
                    ${summary.scenes} of ${FEATURED_SCENE_IDS.length} featured scenes shown, ${summary.tips} active
                    tips, ${summary.roles} roles.
                  </p>`
                : nothing
            }
            ${
              !text.trim()
                ? html`<p class="hint">
                      No custom home page is saved. People see the built-in welcome and no featured scenes.
                    </p>
                    <button
                      type="button"
                      id="home-template"
                      @click=${() => {
                        text = JSON.stringify(homeTemplate(), null, 2);
                        say("Template loaded. Review it, then save.", "ok");
                      }}
                    >
                      Start from the template
                    </button>`
                : nothing
            }
            ${
              home
                ? html`<div class="grant-form">
                    <div class="f grow">
                      <label for="home-headline">Welcome line</label>
                      <input
                        id="home-headline"
                        type="text"
                        maxlength="200"
                        .value=${String(home.welcome.headline ?? "")}
                        @change=${(e: Event) =>
                          edit((next) => {
                            next.welcome.headline = (e.target as HTMLInputElement).value;
                          })}
                      />
                    </div>
                    <div class="f grow">
                      <label for="home-subline">Second line</label>
                      <input
                        id="home-subline"
                        type="text"
                        maxlength="400"
                        .value=${String(home.welcome.subline ?? "")}
                        @change=${(e: Event) =>
                          edit((next) => {
                            next.welcome.subline = (e.target as HTMLInputElement).value;
                          })}
                      />
                    </div>
                    <div class="f grow" style="flex-basis:100%">
                      <label for="home-placeholder">Message box hint</label>
                      <input
                        id="home-placeholder"
                        type="text"
                        maxlength="200"
                        .value=${String(home.composerPlaceholder ?? "")}
                        @change=${(e: Event) =>
                          edit((next) => {
                            next.composerPlaceholder = (e.target as HTMLInputElement).value;
                          })}
                      />
                    </div>
                    <div class="f grow" style="flex-basis:100%">
                      <label
                        style="display:flex;align-items:center;gap:6px;cursor:pointer;margin:0;font-size:13px;font-weight:400;color:var(--text)"
                        ><input
                          id="home-opener"
                          type="checkbox"
                          style="width:auto"
                          .checked=${home.opener?.enabled !== false}
                          @change=${(e: Event) =>
                            edit((next) => {
                              next.opener = { ...next.opener, enabled: (e.target as HTMLInputElement).checked };
                            })}
                        />Let the assistant open the conversation on the home page</label
                      >
                    </div>
                  </div>`
                : nothing
            }
            ${
              text.trim()
                ? html`<div class="f grow" style="margin-top:12px">
                      <label for="home-json">Full configuration (JSON)</label>
                      <textarea
                        id="home-json"
                        spellcheck="false"
                        style="min-height:320px;font-family:var(--mono, monospace);font-size:12px"
                        .value=${text}
                        @change=${(e: Event) => {
                          text = (e.target as HTMLTextAreaElement).value;
                          message = "";
                          tone = "";
                          draw();
                        }}
                      ></textarea>
                    </div>
                    ${parsed.error ? html`<p class="status err" id="home-invalid">${parsed.error}</p>` : nothing}
                    <div style="display:flex;gap:8px;margin-top:10px;flex-wrap:wrap">
                      <button type="button" class="primary" id="home-save" ?disabled=${pending || !home} @click=${save}>
                        Save home page
                      </button>
                      ${
                        stored
                          ? html`<button type="button" id="home-clear" ?disabled=${pending} @click=${restore}>
                              Remove custom home page
                            </button>`
                          : nothing
                      }
                    </div>`
                : nothing
            }
            <p class=${"status" + (tone ? " " + tone : "")} style="margin:10px 0 0">${message}</p>`,
        )}
      </div>`,
    );
  }
  draw();
}
