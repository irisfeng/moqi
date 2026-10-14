import { FEATURED_SCENES, featuredScenarioTips } from "./featured-scenes.ts";
import { subscribeAnnouncements } from "./banner.ts";
import { openAnnouncementReader } from "./announcement-reader.ts";
import { html, nothing, render, type TemplateResult } from "lit";
import {
  Award,
  Check,
  ChevronRight,
  ClipboardCheck,
  Copy,
  ExternalLink,
  RefreshCw,
  Settings2,
  Sparkles,
  Target,
} from "lucide";
import "./marked-dedupe.ts";
import "@mariozechner/mini-lit/dist/MarkdownBlock.js";
import { type HomeTip, type WebuiHomeConfig } from "./home-config.ts";
import { ANNOUNCEMENT_LEVEL_LABEL, currentArchiveList, shortDate } from "./banner.ts";
import { escapeLoneDollars } from "./markdown-dollars.ts";
import { installMarkdownSanitizer } from "./markdown-sanitize.ts";
import { copyText, fieldSelect, icon } from "./ui.ts";
import {
  currentGrowthSnapshot,
  growthErrorMessage,
  growthStageIndex,
  growthStatusLabel,
  refreshGrowthSnapshot,
  startGrowthPolling,
  submitGrowthAction,
  subscribeGrowth,
  type GrowthAction,
  type GrowthPreferences,
  type GrowthSnapshot,
  type GrowthTaskView,
} from "./growth.ts";

installMarkdownSanitizer();

interface GuidePageOptions {
  isActive?: () => boolean;
  tryTip?: (tip: HomeTip) => void;
  openGrowthChat?: (task: GrowthTaskView, prompt?: string) => Promise<void> | void;
}

let guideHost: HTMLDivElement | null = null;
let guideConfig: WebuiHomeConfig | null = null;
let guideOptions: GuidePageOptions = {};
let growthLoading = false;
let growthError = "";
let growthActionBusy = "";
let guideRefreshSeq = 0;
let guideGeneration = 0;
let announcementsUnsubscribe: (() => void) | null = null;
let growthUnsubscribe: (() => void) | null = null;
let preferenceDraft: GrowthPreferences | null = null;

const ONBOARDING_STEPS = ["Goal", "Materials", "Generate", "Revise", "Accept"] as const;
const DAILY_STEPS = ["Goal", "Materials", "Generate", "Check", "Accept"] as const;

function pageActive(): boolean {
  return Boolean(guideHost && document.contains(guideHost) && (guideOptions.isActive?.() ?? true));
}

function taskActionStillCurrent(generation: number): boolean {
  return generation === guideGeneration && pageActive();
}

export function invalidateGuideActions(): void {
  guideGeneration += 1;
}

function normalizedOptions(value: GuidePageOptions | ((tip: HomeTip) => void)): GuidePageOptions {
  return typeof value === "function" ? { tryTip: value } : value;
}

function redrawGuide(): void {
  if (!pageActive() || !guideConfig) return;
  drawGuide(guideConfig, guideOptions);
}

async function loadGrowth(): Promise<void> {
  if (growthLoading) return;
  const seq = ++guideRefreshSeq;
  growthLoading = true;
  growthError = "";
  redrawGuide();
  try {
    await refreshGrowthSnapshot();
  } catch (error) {
    if (seq === guideRefreshSeq) growthError = growthErrorMessage(error);
  } finally {
    if (seq === guideRefreshSeq) {
      growthLoading = false;
      redrawGuide();
    }
  }
}

async function doGrowthAction(action: GrowthAction): Promise<GrowthSnapshot | null> {
  if (growthActionBusy) return null;
  growthActionBusy = `${action.action}:${action.key ?? "preferences"}`;
  growthError = "";
  redrawGuide();
  try {
    return await submitGrowthAction(action);
  } catch (error) {
    growthError = growthErrorMessage(error);
    return null;
  } finally {
    growthActionBusy = "";
    redrawGuide();
  }
}

function preferencesFromForm(form: HTMLFormElement, fallback: GrowthPreferences): GrowthPreferences {
  return {
    enabled: form.querySelector<HTMLInputElement>('input[name="enabled"]')?.checked ?? fallback.enabled,
    time: form.querySelector<HTMLInputElement>('input[name="time"]')?.value ?? fallback.time,
    timeZone: form.querySelector<HTMLSelectElement>("#growth-time-zone")?.value ?? fallback.timeZone,
  };
}

function rememberPreferenceDraft(event: Event, fallback: GrowthPreferences): void {
  const form = (event.currentTarget as HTMLElement | null)?.closest<HTMLFormElement>("form");
  if (form) preferenceDraft = preferencesFromForm(form, fallback);
}

async function savePreferences(form: HTMLFormElement, fallback: GrowthPreferences): Promise<void> {
  const preferences = preferencesFromForm(form, fallback);
  preferenceDraft = preferences;
  const saved = await doGrowthAction({ action: "preferences", preferences });
  if (saved && preferenceDraft === preferences) {
    preferenceDraft = null;
    redrawGuide();
  }
}

function taskFromSnapshot(snapshot: GrowthSnapshot, key: string): GrowthTaskView | null {
  if (snapshot.onboarding.key === key) return snapshot.onboarding;
  if (snapshot.daily?.key === key) return snapshot.daily;
  return null;
}

async function startTask(task: GrowthTaskView): Promise<void> {
  const generation = guideGeneration;
  const started = await doGrowthAction({ action: "start", key: task.key });
  if (!started || !taskActionStillCurrent(generation)) return;
  const startedTask = taskFromSnapshot(started, task.key);
  if (!startedTask) return;
  if (!taskActionStillCurrent(generation)) return;
  const prepared = startedTask.participation?.prepared
    ? started
    : await doGrowthAction({ action: "prepare", key: task.key });
  if (!prepared || !taskActionStillCurrent(generation)) return;
  const preparedTask = taskFromSnapshot(prepared, task.key);
  if (preparedTask && taskActionStillCurrent(generation)) await openTaskChat(preparedTask, preparedTask.prompt);
}

async function prepareTask(task: GrowthTaskView): Promise<void> {
  const generation = guideGeneration;
  const snapshot = await doGrowthAction({ action: "prepare", key: task.key });
  const prepared = snapshot ? taskFromSnapshot(snapshot, task.key) : null;
  if (prepared && taskActionStillCurrent(generation)) await openTaskChat(prepared, prepared.prompt);
}

async function openTaskChat(task: GrowthTaskView, prompt?: string): Promise<void> {
  if (!task.participation || !guideOptions.openGrowthChat) return;
  await guideOptions.openGrowthChat(task, prompt);
}

async function acceptTask(task: GrowthTaskView): Promise<void> {
  const runId = task.evidence?.runId;
  if (!runId) return;
  await doGrowthAction({ action: "accept", key: task.key, runId });
}

async function skipTask(task: GrowthTaskView): Promise<void> {
  await doGrowthAction({ action: "skip", key: task.key });
}

function taskStepClass(task: GrowthTaskView, index: number): string {
  const stage = growthStageIndex(task);
  if (index < stage) return "done";
  if (index === stage && task.status !== "complete") return "current";
  return "";
}

function stepRail(task: GrowthTaskView): TemplateResult {
  const steps = task.kind === "daily" ? DAILY_STEPS : ONBOARDING_STEPS;
  return html`
    <ol class="growth-step-rail" aria-label="Task progress">
      ${steps.map(
        (label, index) => html`
          <li class="growth-step ${taskStepClass(task, index)}">
            <span class="growth-step-marker">${index < growthStageIndex(task) ? icon(Check, 13) : index + 1}</span>
            <span>${label}</span>
          </li>
        `,
      )}
    </ol>
  `;
}

function taskStatus(task: GrowthTaskView): TemplateResult {
  return html`<span class="growth-status status-${task.status}">${growthStatusLabel(task.status)}</span>`;
}

function materialBlock(task: GrowthTaskView): TemplateResult {
  if (task.participation?.prepared) {
    return html`
      <div class="growth-material-done" role="status">
        ${icon(Check, 15)}<span>Materials saved. Open the dedicated session to generate the result.</span>
      </div>
    `;
  }
  return html`
    <div class="growth-materials">
      <div class="growth-stage-label">Materials needed</div>
      <ul>
        ${task.steps.map((step) => html`<li>${step}</li>`)}
      </ul>
      <button
        class="growth-button primary"
        type="button"
        ?disabled=${Boolean(growthActionBusy)}
        @click=${() => void prepareTask(task)}
      >
        ${growthActionBusy.startsWith(`prepare:${task.key}`) ? "Saving…" : "Save materials step and continue"}
        ${icon(ChevronRight, 15)}
      </button>
    </div>
  `;
}

function evidenceBlock(task: GrowthTaskView): TemplateResult | typeof nothing {
  const evidence = task.evidence;
  if (!evidence?.text.trim()) return nothing;
  const firstDraft = task.participation?.firstAcceptedAt === null || !task.participation;
  const reward = firstDraft ? task.firstPoints : task.revisionPoints;
  const acceptLabel = task.status === "complete" ? "Claimed" : `I have checked it and it is ready to use · +${reward}`;
  return html`
    <section class="growth-evidence" aria-labelledby="growth-evidence-title-${task.key}">
      <div class="growth-evidence-head">
        <div>
          <div class="growth-stage-label" id="growth-evidence-title-${task.key}">
            ${firstDraft ? "First draft result" : "Revised result"}
          </div>
          <p>
            ${task.status === "complete" ? "This is the result you confirmed. The points are in your growth record." : "Check the content first, then claim your points once it is ready to use."}
          </p>
        </div>
      </div>
      <div class="growth-evidence-body">
        <markdown-block .content=${escapeLoneDollars(evidence.text)}></markdown-block>
      </div>
      <div class="growth-evidence-actions">
        <button
          class="growth-button quiet"
          type="button"
          @click=${(event: Event) => void copyText(evidence.text, event.currentTarget as HTMLButtonElement)}
        >
          ${icon(Copy, 14)}Copy result
        </button>
        <button class="growth-button quiet" type="button" @click=${() => void openTaskChat(task)}>
          ${icon(ExternalLink, 14)}Open dedicated session
        </button>
        ${
          task.status === "complete"
            ? nothing
            : html`
                <button
                  class="growth-button primary"
                  type="button"
                  ?disabled=${Boolean(growthActionBusy)}
                  @click=${() => void acceptTask(task)}
                >
                  ${icon(ClipboardCheck, 14)}${acceptLabel}
                </button>
              `
        }
      </div>
    </section>
  `;
}

function taskStageContent(task: GrowthTaskView): TemplateResult {
  if (task.status === "available") {
    return html`
      <div class="growth-stage-copy">
        <span class="growth-stage-label">Goal</span>
        <p>Learn the whole path, from setting a goal to accepting the result, with one piece of real work.</p>
        <button
          class="growth-button primary"
          type="button"
          ?disabled=${Boolean(growthActionBusy)}
          @click=${() => void startTask(task)}
        >
          ${icon(Sparkles, 15)}Start task
        </button>
      </div>
    `;
  }
  if (task.status === "skipped") {
    return html`
      <div class="growth-stage-copy">
        <span class="growth-stage-label">Skipped today</span>
        <p>A new weekday challenge will be scheduled tomorrow. You can still finish the first level.</p>
      </div>
    `;
  }
  if (task.status === "revise") {
    return html`
      <div class="growth-stage-copy">
        <span class="growth-stage-label">Revise</span>
        <p>${task.revisionPrompt}</p>
        <p class="growth-hint">Submit a revision request in the dedicated session, then return to accept.</p>
        <button
          class="growth-button primary"
          type="button"
          ?disabled=${Boolean(growthActionBusy)}
          @click=${() => void openTaskChat(task, task.revisionPrompt)}
        >
          ${icon(RefreshCw, 15)}Continue revising
        </button>
      </div>
    `;
  }
  if (task.status === "review" || task.status === "complete") {
    return html`
      ${evidenceBlock(task)}
      ${
        task.status === "complete"
          ? html`<div class="growth-complete-note" role="status">
              ${icon(Award, 16)}This task is complete. The points are in your growth record.
            </div>`
          : nothing
      }
      ${
        !task.evidence
          ? html`
              <div class="growth-sync-row">
                <p class="growth-hint">The result is syncing. Refresh to see the latest.</p>
                <button
                  class="growth-button quiet"
                  type="button"
                  ?disabled=${Boolean(growthActionBusy)}
                  @click=${() => void loadGrowth()}
                >
                  ${icon(RefreshCw, 14)}Refresh acceptance
                </button>
              </div>
            `
          : nothing
      }
    `;
  }
  if (!task.participation?.prepared) return materialBlock(task);
  return html`
    <div class="growth-stage-copy">
      <span class="growth-stage-label">Generate</span>
      <p>The dedicated session is ready. Edit the draft and send it to complete one real run.</p>
      <div class="growth-action-row">
        <button class="growth-button primary" type="button" @click=${() => void openTaskChat(task, task.prompt)}>
          ${icon(ExternalLink, 15)}${task.status === "working" ? "Resume dedicated session" : "Open dedicated session"}
        </button>
        <button
          class="growth-button quiet"
          type="button"
          ?disabled=${Boolean(growthActionBusy)}
          @click=${() => void loadGrowth()}
        >
          ${icon(RefreshCw, 14)}Refresh acceptance
        </button>
      </div>
    </div>
  `;
}

function taskCard(task: GrowthTaskView, eyebrow: string): TemplateResult {
  return html`
    <article class="growth-task-card task-${task.status} ${task.status === "complete" ? "is-complete" : ""}">
      <header class="growth-task-head">
        <div>
          <div class="growth-eyebrow">${eyebrow}</div>
          <h3>${task.title}</h3>
          <p>${task.description}</p>
        </div>
        ${taskStatus(task)}
      </header>
      ${stepRail(task)}
      <div class="growth-task-stage">${taskStageContent(task)}</div>
      ${
        task.kind === "daily" && task.status !== "complete" && task.status !== "skipped"
          ? html`<button
              class="growth-skip"
              type="button"
              ?disabled=${Boolean(growthActionBusy)}
              @click=${() => void skipTask(task)}
            >
              Skip today
            </button>`
          : nothing
      }
    </article>
  `;
}

const GROWTH_LEVEL_THRESHOLDS = [0, 50, 150, 300] as const;

function growthProgressStart(snapshot: Pick<GrowthSnapshot, "points" | "nextLevelAt">): number {
  const next = snapshot.nextLevelAt;
  if (next === null || next <= 0) return 0;
  return GROWTH_LEVEL_THRESHOLDS.filter((threshold) => threshold < next && threshold <= snapshot.points).at(-1) ?? 0;
}

export function growthProgressPercent(snapshot: Pick<GrowthSnapshot, "points" | "nextLevelAt">): number {
  const next = snapshot.nextLevelAt;
  if (next === null || next <= 0) return 100;
  const current = growthProgressStart(snapshot);
  return Math.max(0, Math.min(100, ((snapshot.points - current) / (next - current)) * 100));
}

const GROWTH_BADGES = [
  { name: "First result", position: "0%", condition: "Generate and confirm your first work result" },
  { name: "Polish it", position: "50%", condition: "Request a revision and accept it to finish the first level" },
  { name: "Five-day practice", position: "100%", condition: "Accept 5 daily challenges, not necessarily in a row" },
] as const;

const badgeDoodles = new URL("./assets/growth/badges-doodle.webp", import.meta.url).href;

function growthSummary(snapshot: GrowthSnapshot): TemplateResult {
  const additionalBadges = snapshot.badges.filter((name) => !GROWTH_BADGES.some((badge) => badge.name === name));
  const next = snapshot.nextLevelAt;
  const progressStart = growthProgressStart(snapshot);
  const progressEnd = next ?? Math.max(progressStart, snapshot.points);
  const progressValue = Math.max(progressStart, Math.min(progressEnd, snapshot.points));
  return html`
    <section class="growth-summary" aria-label="Growth progress">
      <div class="growth-summary-main">
        <div class="growth-eyebrow">Your growth</div>
        <div class="growth-score-row"><strong>${snapshot.points}</strong><span>Total points</span></div>
        <div class="growth-achievement">
          ${icon(Award, 20)}<span>Reached: <strong>${snapshot.level}</strong></span>
        </div>
        <div
          class="growth-progress"
          role="progressbar"
          aria-label="Growth points progress"
          aria-valuenow=${progressValue}
          aria-valuemin=${progressStart}
          aria-valuemax=${progressEnd}
        >
          <span style=${`width:${growthProgressPercent(snapshot)}%`}></span>
        </div>
        <div class="growth-progress-caption">
          ${next === null ? "Current level reached" : `${Math.max(0, next - snapshot.points)} pts to next level`}
        </div>
      </div>
      <div class="growth-badges">
        <div class="growth-badges-heading">
          <span class="growth-eyebrow">Achievement badges</span
          ><span
            >Earned
            ${GROWTH_BADGES.filter((badge) => snapshot.badges.includes(badge.name)).length + additionalBadges.length} /
            ${GROWTH_BADGES.length + additionalBadges.length}</span
          >
        </div>
        <ul class="growth-badge-list" role="list" aria-label="Achievement badges">
          ${GROWTH_BADGES.map((badge) => {
            const earned = snapshot.badges.includes(badge.name);
            return html`<li class="growth-badge ${earned ? "is-earned" : "is-locked"}">
              <span
                class="growth-badge-mark growth-badge-doodle"
                aria-hidden="true"
                style=${`background-image:url("${badgeDoodles}");background-position:${badge.position} center`}
              ></span>
              <strong class="growth-badge-name">${badge.name}</strong>
              <span class="growth-badge-state">${earned ? html`${icon(Check, 12)}Earned` : "Locked"}</span>
              <p class="growth-badge-condition">${badge.condition}</p>
            </li>`;
          })}
          ${additionalBadges.map((name) => html`<li class="growth-badge is-earned"><span class="growth-badge-mark" aria-hidden="true">${icon(Award, 48)}</span><strong class="growth-badge-name">${name}</strong><span class="growth-badge-state">${icon(Check, 12)}Earned</span></li>`)}
        </ul>
      </div>
    </section>
  `;
}

function historyBlock(snapshot: GrowthSnapshot): TemplateResult {
  return html`
    <details class="growth-history">
      <summary>
        <span>${icon(Award, 15)}Points history</span
        ><span>${snapshot.history.length ? `Latest ${snapshot.history.length}` : "No records yet"}</span>
      </summary>
      ${
        snapshot.history.length
          ? html`<div class="growth-history-list" role="list">
              ${snapshot.history.map(
                (item) => html`
                  <div class="growth-history-row" role="listitem">
                    <span>${item.reason}</span><strong>+${item.points}</strong
                    ><time datetime=${new Date(item.at).toISOString()}>${new Date(item.at).toLocaleDateString()}</time>
                  </div>
                `,
              )}
            </div>`
          : html`<p class="growth-empty">Points appear here after you complete real work and confirm it yourself.</p>`
      }
    </details>
  `;
}

function timeZoneOptions(value: string): string[] {
  const browserZone = (() => {
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone;
    } catch {
      return "Asia/Shanghai";
    }
  })();
  return [...new Set([value, browserZone, "Asia/Shanghai", "Asia/Hong_Kong", "UTC"].filter(Boolean))];
}

function preferencesBlock(snapshot: GrowthSnapshot): TemplateResult {
  const preferences = preferenceDraft ?? snapshot.preferences;
  const zones = timeZoneOptions(preferences.timeZone);
  let summary = preferences.enabled ? `Weekdays ${preferences.time}` : "Off";
  if (preferenceDraft) summary += " · Unsaved";
  return html`
    <details class="growth-preferences">
      <summary><span>${icon(Settings2, 15)}Reminder settings</span><span>${summary}</span></summary>
      <form
        @submit=${(event: SubmitEvent) => {
          event.preventDefault();
          const form = event.currentTarget as HTMLFormElement;
          void savePreferences(form, preferences);
        }}
      >
        <label class="growth-check"
          ><input
            name="enabled"
            type="checkbox"
            .checked=${preferences.enabled}
            @change=${(event: Event) => rememberPreferenceDraft(event, preferences)}
          />Allow weekday in-app reminders</label
        >
        <div class="growth-preference-fields">
          <label
            >Reminder time<input
              name="time"
              type="time"
              .value=${preferences.time}
              @input=${(event: Event) => rememberPreferenceDraft(event, preferences)}
          /></label>
          <label
            >Timezone${fieldSelect({
              id: "growth-time-zone",
              ariaLabel: "Reminder time zone",
              value: preferences.timeZone,
              options: zones.map(
                (zone) => html`<option value=${zone} ?selected=${zone === preferences.timeZone}>${zone}</option>`,
              ),
              onChange: (_value, event) => rememberPreferenceDraft(event, preferences),
            })}</label
          >
        </div>
        <p>Off by default. Reminders show only on open or while online. No model runs and no external messages.</p>
        <button class="growth-button quiet" type="submit" ?disabled=${Boolean(growthActionBusy)}>
          ${growthActionBusy.startsWith("preferences:") ? "Saving…" : "Save settings"}
        </button>
      </form>
    </details>
  `;
}

function dailyBlock(snapshot: GrowthSnapshot): TemplateResult {
  if (snapshot.daily) return taskCard(snapshot.daily, "Daily challenge · 10 pts");
  const onboardingComplete = snapshot.onboarding.status === "complete";
  return html`
    <section class="growth-daily-empty">
      <div class="growth-daily-mark">${icon(Target, 18)}</div>
      <div>
        <h3>${onboardingComplete ? "No new challenge today" : "Finish the first level to unlock daily challenges"}</h3>
        <p>
          ${onboardingComplete ? "One a weekday, scored by your local date. Weekends are rest days." : "Complete one real piece of work first. After that, a 10-point challenge appears every weekday."}
        </p>
      </div>
    </section>
  `;
}

function growthPanel(): TemplateResult {
  const snapshot = currentGrowthSnapshot();
  if (growthLoading && !snapshot) {
    return html`<section class="growth-loading" role="status" aria-live="polite">
      <div class="growth-loading-bar"></div>
      <p>Connecting to the growth service…</p>
    </section>`;
  }
  if (!snapshot) {
    return html`<section class="growth-unavailable" role="alert">
      <strong>Growth service is temporarily unavailable</strong>
      <p>${growthError || "Try again later. Points and challenge status are determined by the server."}</p>
      <button class="growth-button quiet" type="button" @click=${() => void loadGrowth()}>
        ${icon(RefreshCw, 14)}Reconnect
      </button>
    </section>`;
  }
  const complete = snapshot.onboarding.status === "complete";
  let dailyNote = "No new challenge today.";
  if (snapshot.daily?.status === "complete") dailyNote = "Today's challenge is done.";
  if (snapshot.daily?.status === "skipped") dailyNote = "Today's challenge was skipped.";
  return html`
    ${growthError ? html`<div class="growth-error" role="alert">${growthError}</div>` : nothing}
    <section class="growth-current">
      <div class="growth-section-head">
        <h2>${complete ? "Keep putting AI to work" : "Start with meeting minutes"}</h2>
        <button
          class="growth-refresh"
          type="button"
          aria-label="Refresh growth status"
          title="Refresh growth status"
          @click=${() => void loadGrowth()}
        >
          ${icon(RefreshCw, 16)}
        </button>
      </div>
      ${
        complete
          ? html`<details class="growth-completed-task">
                <summary>
                  <span>${icon(Check, 18)}Level 1 done</span><span>Review ${icon(ChevronRight, 14)}</span>
                </summary>
                ${taskCard(snapshot.onboarding, "First level · 30 + 20 pts")}
              </details>
              ${
                snapshot.daily && snapshot.daily.status !== "complete" && snapshot.daily.status !== "skipped"
                  ? dailyBlock(snapshot)
                  : html`<p class="growth-next-note">${dailyNote}Pick a piece of work and try a scenario below.</p>`
              }`
          : taskCard(snapshot.onboarding, "Getting started · 5–10 min")
      }
    </section>
  `;
}

function growthRecords(): TemplateResult | typeof nothing {
  const snapshot = currentGrowthSnapshot();
  if (!snapshot) return nothing;
  return html`<details class="growth-records">
    <summary>
      <span>My growth</span><span>${snapshot.level} · ${snapshot.points} pts ${icon(ChevronRight, 14)}</span>
    </summary>
    ${growthSummary(snapshot)} ${snapshot.onboarding.status !== "complete" ? dailyBlock(snapshot) : nothing}
    ${snapshot.daily && (snapshot.daily.status === "complete" || snapshot.daily.status === "skipped") ? dailyBlock(snapshot) : nothing}
    ${historyBlock(snapshot)}${preferencesBlock(snapshot)}
  </details>`;
}

function sceneLibrary(config: WebuiHomeConfig, options: GuidePageOptions): TemplateResult {
  const tips = featuredScenarioTips(config);
  const archive = currentArchiveList();
  return html`
    <section class="growth-section growth-scenes" aria-labelledby="growth-scenes-title">
      <div class="growth-section-head">
        <div>
          <h2 id="growth-scenes-title">Finish a piece of work end to end</h2>
          <p>Bring your materials and pick a scenario you will really use.</p>
        </div>
      </div>
      ${
        tips.length
          ? html`<div class="growth-discovery-grid">
                ${tips.map(
                  (tip) =>
                    html`<button
                      type="button"
                      class="growth-discovery-card"
                      @click=${() => options.tryTip?.(tip)}
                      aria-label=${`Use scenario: ${tip.title}`}
                    >
                      <img
                        src=${FEATURED_SCENES.find((scene) => scene.id === tip.id)!.image}
                        alt=""
                        width="1000"
                        height="500"
                        loading="lazy"
                        decoding="async"
                      />
                      <span class="growth-discovery-copy"
                        ><strong>${tip.title}</strong
                        ><span class="growth-discovery-description">${tip.oneLiner}</span></span
                      >
                      <span class="growth-discovery-action">Start this work ${icon(ChevronRight, 14)}</span>
                    </button>`,
                )}
              </div>
              <p class="growth-library-note">Selecting one drafts the task brief. Review it before sending.</p>`
          : html`<p class="growth-empty">Featured work scenarios are on the way.</p>`
      }
      ${
        archive.length
          ? html`
              <details class="growth-announcements">
                <summary>Product updates <span>${archive.length} items</span></summary>
                <div class="growth-announcement-list">
                  ${archive.map(
                    (announcement) => html`
                      <div class="growth-announcement-row">
                        <span class="growth-announcement-label ${announcement.level === "incident" ? "incident" : ""}"
                          >${ANNOUNCEMENT_LEVEL_LABEL[announcement.level]}</span
                        >
                        <button type="button" @click=${() => openAnnouncementReader(announcement)}>
                          ${announcement.title}
                        </button>
                        <time>${shortDate(announcement.startsAt)}</time>
                      </div>
                    `,
                  )}
                </div>
              </details>
            `
          : nothing
      }
    </section>
  `;
}

export function renderGuidePage(
  config: WebuiHomeConfig,
  mount: HTMLElement | null,
  optionsOrTryTip: GuidePageOptions | ((tip: HomeTip) => void),
): void {
  if (!mount) return;
  guideConfig = config;
  guideOptions = normalizedOptions(optionsOrTryTip);
  startGrowthPolling();
  if (!guideHost || guideHost.parentElement !== mount) {
    guideHost = document.createElement("div");
    guideHost.className = "pane growth-guide";
    guideGeneration += 1;
    mount.replaceChildren(guideHost);
    growthUnsubscribe?.();
    growthUnsubscribe = subscribeGrowth(() => redrawGuide());
    announcementsUnsubscribe?.();
    announcementsUnsubscribe = subscribeAnnouncements(() => redrawGuide());
    void loadGrowth();
  }
  redrawGuide();
}

function drawGuide(config: WebuiHomeConfig, options: GuidePageOptions): void {
  const host = guideHost;
  if (!host) return;
  render(
    html`
      <div class="growth-page-head">
        <div>
          <h1 class="pane-title">Growth guide</h1>
          <p>Start with real work and get comfortable step by step.</p>
        </div>
      </div>
      ${growthPanel()} ${sceneLibrary(config, options)} ${growthRecords()}
    `,
    host,
  );
}
