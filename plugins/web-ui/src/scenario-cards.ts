import { FEATURED_SCENES, featuredScenarioTips } from "./featured-scenes.ts";
import { html, type TemplateResult } from "lit";
import { activeTips, pickDaily, type HomeTip, type WebuiHomeConfig } from "./home-config";
import paperArtwork from "./assets/scenarios/paper.webp";
import tableArtwork from "./assets/scenarios/table.webp";
import flowArtwork from "./assets/scenarios/flow.webp";
import slidesArtwork from "./assets/scenarios/slides.webp";
import chatArtwork from "./assets/scenarios/chat.webp";

export type ScenarioVisualKind = "paper" | "table" | "flow" | "chat" | "slides";
export type ScenarioCategory = "document" | "data" | "presentation" | "collaboration" | "design" | "tender" | "more";
export type ScenarioCategoryFilter = ScenarioCategory | "all";

const CATEGORY_LABELS: Record<ScenarioCategory, string> = {
  document: "Documents",
  data: "Spreadsheets",
  presentation: "Presentations",
  collaboration: "Collaboration",
  design: "Product design",
  tender: "Cross-team work",
  more: "More",
};

export function featuredHomeConfig(config: WebuiHomeConfig): WebuiHomeConfig {
  return { ...config, tips: featuredScenarioTips(config) };
}

let controllerSerial = 0;

export function scenarioCategory(tip: HomeTip): ScenarioCategory {
  const featured = FEATURED_SCENES.find((scene) => scene.id === tip.id);
  if (featured) return featured.category;
  const text = `${tip.title} ${tip.oneLiner} ${tip.capability}`.toLocaleLowerCase();
  if (/ppt|演示|汇报|幻灯|presentation/.test(text)) return "presentation";
  if (/excel|表格|台账|公式|数据|统计|图表|文件分析/.test(text)) return "data";
  if (/项目|协作|同事|共享|提及|项目文件|流程|审批/.test(text)) return "collaboration";
  if (/文档|文件|会议|纪要|翻译|报告|导读|资料|总结|写作|邮件|公众号|搜索|配图|封面|office-docs/.test(text))
    return "document";
  return "more";
}

export function scenarioCategoryLabel(category: ScenarioCategory): string {
  return CATEGORY_LABELS[category];
}

export function scenarioVisualKind(tip: HomeTip): ScenarioVisualKind {
  const category = scenarioCategory(tip);
  if (/引用|提及|同事|追问/.test(tip.title)) return "chat";
  if (/文档库|共享文件|部门文档/.test(tip.title)) return "paper";
  if (category === "data") return "table";
  if (category === "presentation") return "slides";
  if (category === "collaboration") return "flow";
  if (category === "document") return "paper";
  return "chat";
}

export function scenarioCardPage(
  config: WebuiHomeConfig,
  userKey: string,
  dateKey: string,
  count = 3,
  offset = 0,
  filter: ScenarioCategoryFilter = "all",
): HomeTip[] {
  const pool = activeTips(config).filter((tip) => filter === "all" || scenarioCategory(tip) === filter);
  return pickDaily(pool, userKey, dateKey, count, offset);
}

export function scenarioCardPageHasMore(
  config: WebuiHomeConfig,
  count = 3,
  filter: ScenarioCategoryFilter = "all",
): boolean {
  return activeTips(config).filter((tip) => filter === "all" || scenarioCategory(tip) === filter).length > count;
}

export function nextScenarioCardOffset(
  offset: number,
  config: WebuiHomeConfig,
  filter: ScenarioCategoryFilter = "all",
): number {
  const poolSize = activeTips(config).filter((tip) => filter === "all" || scenarioCategory(tip) === filter).length;
  return (offset + 3) % Math.max(1, poolSize);
}

export function scenarioCategoryChips(
  tips: readonly HomeTip[],
  selected: ScenarioCategoryFilter,
  onSelect: (filter: ScenarioCategoryFilter) => void,
): TemplateResult {
  const categories = [...new Set(tips.filter((tip) => tip.status === "active").map(scenarioCategory))];
  return html`
    <div class="scenario-category-chips" role="group" aria-label="Filter by scenario">
      <button
        type="button"
        class="scenario-chip"
        aria-pressed=${selected === "all" ? "true" : "false"}
        @click=${() => onSelect("all")}
      >
        All
      </button>
      ${categories.map(
        (category) =>
          html`<button
            type="button"
            class="scenario-chip"
            aria-pressed=${selected === category ? "true" : "false"}
            @click=${() => onSelect(category)}
          >
            ${scenarioCategoryLabel(category)}
          </button>`,
      )}
    </div>
  `;
}

const SCENARIO_ARTWORK: Record<ScenarioVisualKind, string> = {
  paper: paperArtwork,
  table: tableArtwork,
  flow: flowArtwork,
  slides: slidesArtwork,
  chat: chatArtwork,
};

function scenarioCardVisual(tip: HomeTip): TemplateResult {
  return html`
    <span class="scenario-card-visual" aria-hidden="true">
      <img
        src=${FEATURED_SCENES.find((scene) => scene.id === tip.id)?.image ?? SCENARIO_ARTWORK[scenarioVisualKind(tip)]}
        alt=""
        width="1000"
        height="500"
        loading="lazy"
        decoding="async"
      />
    </span>
  `;
}

export interface ScenarioCardOptions {
  existingDraft: () => string;
  onUse: (tip: HomeTip, prompt: string) => void;
}

export interface ScenarioCardController {
  card: (tip: HomeTip) => TemplateResult;
  dialog: () => TemplateResult;
}

export function createScenarioCardController(options: ScenarioCardOptions): ScenarioCardController {
  const instanceId = ++controllerSerial;
  const dialogId = `scenario-dialog-${instanceId}`;
  let activeTip: HomeTip | null = null;
  function close(dialog: HTMLDialogElement | null): void {
    if (!dialog) return;
    dialog.close();
    activeTip = null;
  }

  function open(tip: HomeTip, card: HTMLElement): void {
    const dialog = card.closest<HTMLElement>("article")?.querySelector<HTMLDialogElement>(`#${dialogId}`);
    if (!dialog) return;
    activeTip = tip;
    const title = dialog.querySelector<HTMLElement>(".scenario-dialog-title");
    const description = dialog.querySelector<HTMLElement>(".scenario-dialog-description");
    const category = dialog.querySelector<HTMLElement>(".scenario-dialog-category");
    const note = dialog.querySelector<HTMLElement>(".scenario-dialog-note");
    const textarea = dialog.querySelector<HTMLTextAreaElement>(".scenario-dialog-prompt");
    const scene = FEATURED_SCENES.find((item) => item.id === tip.id);
    const inputs = dialog.querySelector<HTMLElement>(".scenario-dialog-inputs");
    const output = dialog.querySelector<HTMLElement>(".scenario-dialog-output");
    const brief = dialog.querySelector<HTMLElement>(".scenario-dialog-brief");
    if (inputs) inputs.textContent = scene?.inputs ?? "";
    if (output) output.textContent = scene?.output ?? "";
    if (brief) brief.hidden = !scene;
    if (title) title.textContent = tip.title;
    if (description) description.textContent = tip.oneLiner;
    if (category) category.textContent = scenarioCategoryLabel(scenarioCategory(tip));
    if (note) {
      note.textContent = options.existingDraft().trim()
        ? "Your current draft stays. This text is added to the end."
        : "Adjust the prompt first, then use this scenario.";
    }
    if (textarea) textarea.value = tip.prompt;
    dialog.showModal();
    queueMicrotask(() => textarea?.focus());
  }

  return {
    card: (tip) => html`
      <div class="scenario-card-shell">
        <button
          type="button"
          class="home-card scenario-card"
          aria-label=${`${tip.title}: ${tip.oneLiner}`}
          aria-haspopup="dialog"
          @click=${(event: Event) => open(tip, event.currentTarget as HTMLElement)}
        >
          ${scenarioCardVisual(tip)}
          <span class="scenario-card-body">
            <span class="scenario-card-meta">
              <span class="scenario-card-chip">${scenarioCategoryLabel(scenarioCategory(tip))}</span>
              <span class="scenario-card-open">View</span>
            </span>
            <span class="home-card-title">${tip.title}</span>
            <span class="home-card-sub">${tip.oneLiner}</span>
          </span>
        </button>
      </div>
    `,
    dialog: () => {
      return html`
        <dialog
          id=${dialogId}
          class="scenario-card-dialog"
          aria-labelledby=${`${dialogId}-title`}
          @cancel=${() => {
            activeTip = null;
          }}
        >
          <form
            method="dialog"
            class="scenario-dialog-form"
            @submit=${(event: Event) => {
              event.preventDefault();
              const form = event.currentTarget as HTMLFormElement;
              const dialog = form.closest<HTMLDialogElement>("dialog");
              const textarea = form.querySelector<HTMLTextAreaElement>(".scenario-dialog-prompt");
              const prompt = textarea?.value.trim() ?? "";
              if (!activeTip || !prompt) {
                textarea?.focus();
                return;
              }
              const existing = options.existingDraft();
              const combined = existing.trim() ? `${existing}\n\n${prompt}` : prompt;
              const tip = activeTip;
              close(dialog);
              options.onUse(tip, combined);
            }}
          >
            <div class="scenario-dialog-head">
              <span class="scenario-card-chip scenario-dialog-category"> Scenario </span>
              <button
                type="button"
                class="scenario-dialog-close"
                aria-label="Close scenario details"
                @click=${(event: Event) => close((event.currentTarget as HTMLElement).closest("dialog"))}
              >
                ×
              </button>
            </div>
            <h2 id=${`${dialogId}-title`} class="scenario-dialog-title">Scenario details</h2>
            <p class="scenario-dialog-description">Pick a scenario to start.</p>
            <p class="scenario-dialog-note" aria-live="polite">Adjust the prompt first, then use this scenario.</p>
            <dl class="scenario-dialog-brief" hidden>
              <dt>What to prepare</dt>
              <dd class="scenario-dialog-inputs"></dd>
              <dt>What you get</dt>
              <dd class="scenario-dialog-output"></dd>
            </dl>
            <label class="scenario-dialog-field">
              <span>Prompt</span>
              <textarea class="scenario-dialog-prompt" rows="7" spellcheck="false"></textarea>
            </label>
            <div class="scenario-dialog-actions">
              <button
                type="button"
                class="scenario-dialog-cancel"
                @click=${(event: Event) => close((event.currentTarget as HTMLElement).closest("dialog"))}
              >
                Cancel
              </button>
              <button type="submit" class="scenario-dialog-use">Use this scenario</button>
            </div>
          </form>
        </dialog>
      `;
    },
  };
}
