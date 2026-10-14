import { fieldSelect } from "./ui";
import { html, nothing, type TemplateResult } from "lit";
import { api, type CoreProject } from "./core-bridge";
import { appState } from "./shell-state";
import { errMessage } from "../../chassis/src/errors";

interface AnnouncementRevision {
  version: number;
  title: string;
  body: string;
  pinned: boolean;
  expiresAt: number | null;
  archived: boolean;
  updatedAt: number;
  updatedBy: string;
}

interface Announcement extends AnnouncementRevision {
  id: string;
  createdBy: string;
  history: AnnouncementRevision[];
}

interface Todo {
  id: string;
  version: number;
  title: string;
  assigneeId: string;
  dueAt: number | null;
  status: "open" | "doing" | "done" | "cancelled";
  pinned: boolean;
  sourceUrl: string;
  resultUrl: string;
  createdBy: string;
}

interface Board {
  projectId: string;
  pinned: boolean;
  canManage: boolean;
  metadataVersion: number;
  tags: string[];
  important: boolean;
  urgent: boolean;
  materials: Array<{ title: string; url: string }>;
  announcements: Announcement[];
  todos: Todo[];
}

export interface ProjectSummary {
  projectId: string;
  pinned: boolean;
  tags: string[];
  important: boolean;
  urgent: boolean;
}

interface Draft {
  projectId: string;
  kind: "announcement" | "todo" | "metadata";
  id?: string;
  baseVersion: number;
  title: string;
  body: string;
  pinned: boolean;
  archived: boolean;
  date: string;
  assigneeId: string;
  status: Todo["status"];
  sourceUrl: string;
  resultUrl: string;
  tags: string;
  important: boolean;
  urgent: boolean;
  materials: string;
}

export const projectSummaries = new Map<string, ProjectSummary>();
const boards = new Map<string, { board: Board; at: number }>();
const loading = new Set<string>();
const requests = new Map<string, number>();
const saving = new Set<string>();
const notices = new Map<string, string>();
const resultDrafts = new Map<string, string>();
const expanded = new Map<string, boolean>();
const timers = new Map<string, ReturnType<typeof setTimeout>>();
let generation = 0;
let summaryGeneration = 0;
let draft: Draft | null = null;

export function resetProjectCollaboration(): void {
  generation++;
  summaryGeneration++;
  projectSummaries.clear();
  boards.clear();
  loading.clear();
  requests.clear();
  saving.clear();
  notices.clear();
  resultDrafts.clear();
  expanded.clear();
  for (const timer of timers.values()) clearTimeout(timer);
  timers.clear();
  draft = null;
}

export async function loadProjectSummaries(): Promise<void> {
  const seq = ++summaryGeneration;
  const identity = generation;
  try {
    const result = await api<{ projects: ProjectSummary[] }>("/api/project-collaboration");
    if (seq !== summaryGeneration || identity !== generation) return;
    projectSummaries.clear();
    for (const project of result.projects ?? []) projectSummaries.set(project.projectId, project);
  } catch (error) {
    if (seq === summaryGeneration && identity === generation) throw error;
  }
}

function retain(board: Board, redraw: () => void): void {
  boards.set(board.projectId, { board, at: Date.now() });
  projectSummaries.set(board.projectId, board);
  const previous = timers.get(board.projectId);
  if (previous) clearTimeout(previous);
  timers.set(
    board.projectId,
    setTimeout(() => {
      const entry = boards.get(board.projectId);
      if (entry) entry.at = 0;
      timers.delete(board.projectId);
      redraw();
    }, 15_000),
  );
}

function loadBoard(id: string, redraw: () => void, force = false): void {
  if (saving.has(id) || loading.has(id) || (!force && Date.now() - (boards.get(id)?.at ?? 0) < 15_000)) return;
  const identity = generation;
  const request = (requests.get(id) ?? 0) + 1;
  requests.set(id, request);
  loading.add(id);
  void api<{ board: Board }>(`/api/project-collaboration/${encodeURIComponent(id)}`)
    .then(({ board }) => {
      if (identity !== generation || requests.get(id) !== request) return;
      notices.delete(id);
      retain(board, redraw);
    })
    .catch((error: unknown) => {
      if (identity !== generation || requests.get(id) !== request) return;
      boards.delete(id);
      projectSummaries.delete(id);
      notices.set(id, errMessage(error, "Could not load project notices and to-dos."));
    })
    .finally(() => {
      if (identity !== generation || requests.get(id) !== request) return;
      loading.delete(id);
      redraw();
    });
}

async function update(
  id: string,
  command: Record<string, unknown>,
  redraw: () => void,
  form?: Draft,
  saved?: () => void,
): Promise<void> {
  if (saving.has(id)) return;
  const identity = generation;
  saving.add(id);
  summaryGeneration++;
  requests.set(id, (requests.get(id) ?? 0) + 1);
  loading.delete(id);
  notices.delete(id);
  redraw();
  try {
    const result = await api<{ board: Board }>(`/api/project-collaboration/${encodeURIComponent(id)}`, {
      method: "PUT",
      body: JSON.stringify({ command }),
    });
    if (identity !== generation) return;
    retain(result.board, redraw);
    if (form && draft === form) draft = null;
    saved?.();
  } catch (error) {
    if (identity !== generation) return;
    notices.set(id, errMessage(error, "Save failed. Try again."));
  } finally {
    if (identity === generation) {
      saving.delete(id);
      redraw();
    }
  }
}

export async function setProjectPinned(id: string, pinned: boolean): Promise<void> {
  if (saving.has(id)) throw new Error("Project is being saved. Try again shortly.");
  const identity = generation;
  saving.add(id);
  summaryGeneration++;
  requests.set(id, (requests.get(id) ?? 0) + 1);
  try {
    const result = await api<{ board: Board }>(`/api/project-collaboration/${encodeURIComponent(id)}`, {
      method: "PUT",
      body: JSON.stringify({ command: { kind: "pin", pinned } }),
    });
    if (identity === generation) projectSummaries.set(id, result.board);
  } finally {
    if (identity === generation) saving.delete(id);
  }
}

export function projectPinButton(id: string, redraw: () => void, saved?: () => void): TemplateResult {
  const pinned = projectSummaries.get(id)?.pinned ?? false;
  return html`<span class="project-pin-control"
    ><button
      class="btn compact project-pin-button"
      type="button"
      title="Applies to the whole project and its sessions; only affects your list"
      aria-pressed=${pinned}
      ?disabled=${saving.has(id)}
      @click=${() => void update(id, { kind: "pin", pinned: !pinned }, redraw, undefined, saved)}
    >
      ${pinned ? "Unpin project" : "Pin project"}
    </button>
    ${notices.get(id) ? html`<span role="status">${notices.get(id)}</span>` : nothing}</span
  >`;
}

function announcementStatus(item: Announcement): string {
  if (item.archived) return "Archived";
  if (item.expiresAt !== null && item.expiresAt <= Date.now()) return "Expired";
  return "Active";
}

function activeAnnouncements(board: Board): Announcement[] {
  return board.announcements.filter((item) => announcementStatus(item) === "Active");
}

function openTodos(board: Board): Todo[] {
  return board.todos.filter((item) => item.status === "open" || item.status === "doing");
}

function dateLabel(value: number | null): string {
  return value === null ? "No date set" : new Date(value).toLocaleDateString();
}

function dateInput(value: number | null): string {
  if (value === null) return "";
  const date = new Date(value);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function dateValue(value: string): number | null {
  return value ? new Date(`${value}T23:59:59`).getTime() : null;
}

const statusLabels = { open: "To do", doing: "In progress", done: "Done", cancelled: "Cancelled" };

function rememberExpansion(key: string, event: Event): void {
  const element = event.currentTarget as HTMLDetailsElement;
  if (element.isConnected) expanded.set(key, element.open);
}

function pinnedContent(board: Board): TemplateResult {
  const announcements = activeAnnouncements(board).filter((item) => item.pinned);
  const todos = openTodos(board).filter((item) => item.pinned);
  return html`
    ${announcements.map(
      (item) =>
        html`<div class="project-pinned-item">
          <strong>Notice · ${item.title}</strong>
          <p>${item.body}</p>
          ${item.expiresAt !== null ? html`<small>Valid until ${dateLabel(item.expiresAt)}</small>` : nothing}
        </div>`,
    )}
    ${todos.map((item) => html`<div class="project-pinned-item"><strong>To-do · ${item.title}</strong><small>${statusLabels[item.status]} · ${item.assigneeId}${item.dueAt !== null ? ` · Due ${dateLabel(item.dueAt)}` : ""}</small></div>`)}
    ${!announcements.length && !todos.length ? html`<p>Nothing pinned yet.</p>` : nothing}
  `;
}

export function projectChatSummary(scopeId: string | null, redraw: () => void): TemplateResult | typeof nothing {
  const prefix = "group:web-project-";
  if (!scopeId?.startsWith(prefix)) return nothing;
  const id = scopeId.slice(prefix.length);
  if (!notices.has(id)) loadBoard(id, redraw);
  const board = boards.get(id)?.board;
  if (!board) return nothing;
  const count =
    activeAnnouncements(board).filter((item) => item.pinned).length +
    openTodos(board).filter((item) => item.pinned).length;
  return html`<details
    class="project-chat-summary"
    .open=${expanded.get(`${id}:chat`) ?? false}
    @toggle=${(event: Event) => rememberExpansion(`${id}:chat`, event)}
  >
    <summary>Project notices and to-dos · ${count} pinned · ${openTodos(board).length} open</summary>
    <div class="project-pinned-content">${pinnedContent(board)}</div>
  </details>`;
}

function begin(board: Board, kind: Draft["kind"], redraw: () => void, item?: Announcement | Todo): void {
  draft = {
    projectId: board.projectId,
    kind,
    baseVersion: kind === "metadata" ? board.metadataVersion : (item?.version ?? 0),
    ...(item ? { id: item.id } : {}),
    title: item?.title ?? "",
    body: "",
    pinned: true,
    archived: false,
    date: "",
    assigneeId: appState.me?.user ?? "",
    status: "open",
    sourceUrl: "",
    resultUrl: "",
    tags: board.tags.join(", "),
    important: board.important,
    urgent: board.urgent,
    materials: board.materials.map((link) => `${link.title} | ${link.url}`).join("\n"),
  };
  if (item && "history" in item)
    Object.assign(draft, {
      body: item.body,
      pinned: item.pinned,
      archived: item.archived,
      date: dateInput(item.expiresAt),
    });
  else if (item)
    Object.assign(draft, {
      assigneeId: item.assigneeId,
      status: item.status,
      pinned: item.pinned,
      date: dateInput(item.dueAt),
      sourceUrl: item.sourceUrl,
      resultUrl: item.resultUrl,
    });
  notices.delete(board.projectId);
  redraw();
}

function form(board: Board, project: CoreProject, redraw: () => void): TemplateResult | typeof nothing {
  const current = draft;
  if (!current || current.projectId !== board.projectId) return nothing;
  const field = (label: string, name: "title" | "sourceUrl" | "resultUrl", max: number, required = false) =>
    html`<label
      ><span>${label}</span
      ><input
        name=${name}
        maxlength=${max}
        ?required=${required}
        .value=${current[name]}
        @input=${(event: Event) => {
          current[name] = (event.target as HTMLInputElement).value;
        }}
    /></label>`;
  const submit = (event: SubmitEvent) => {
    event.preventDefault();
    let command: Record<string, unknown>;
    if (current.kind === "metadata") {
      command = {
        kind: current.kind,
        baseVersion: current.baseVersion,
        tags: current.tags
          .split(/[,，]/u)
          .map((tag) => tag.trim())
          .filter(Boolean),
        important: current.important,
        urgent: current.urgent,
        materials: current.materials
          .split("\n")
          .filter((line) => line.trim())
          .map((line) => {
            const separator = line.indexOf("|");
            return {
              title: separator < 0 ? line.trim() : line.slice(0, separator).trim(),
              url: separator < 0 ? "" : line.slice(separator + 1).trim(),
            };
          }),
      };
    } else if (current.kind === "announcement")
      command = {
        kind: current.kind,
        id: current.id,
        baseVersion: current.baseVersion,
        title: current.title,
        body: current.body,
        pinned: current.pinned,
        archived: current.archived,
        expiresAt: dateValue(current.date),
      };
    else
      command = {
        kind: current.kind,
        id: current.id,
        baseVersion: current.baseVersion,
        title: current.title,
        assigneeId: current.assigneeId,
        status: current.status,
        pinned: current.pinned,
        dueAt: dateValue(current.date),
        sourceUrl: current.sourceUrl,
        resultUrl: current.resultUrl,
      };
    void update(board.projectId, command, redraw, current);
  };
  return html`<form class="project-board-form" @submit=${submit}>
    <h3>${{ metadata: "Project tags and links", announcement: "Edit notice", todo: "Edit to-do" }[current.kind]}</h3>
    ${
      current.kind === "metadata"
        ? html`
            <label
              ><span>Category tags (comma-separated)</span
              ><input
                .value=${current.tags}
                @input=${(event: Event) => {
                  current.tags = (event.target as HTMLInputElement).value;
                }}
            /></label>
            <label class="project-check"
              ><input
                type="checkbox"
                .checked=${current.important}
                @change=${(event: Event) => {
                  current.important = (event.target as HTMLInputElement).checked;
                }}
              />Important</label
            >
            <label class="project-check"
              ><input
                type="checkbox"
                .checked=${current.urgent}
                @change=${(event: Event) => {
                  current.urgent = (event.target as HTMLInputElement).checked;
                }}
              />Urgent</label
            >
            <label
              ><span>Linked materials (one per line: name | /pm/p/project-path)</span
              ><textarea
                rows="3"
                .value=${current.materials}
                @input=${(event: Event) => {
                  current.materials = (event.target as HTMLTextAreaElement).value;
                }}
              ></textarea>
            </label>
            <p>Submission, approval and completion status are managed on the original project page.</p>
          `
        : html`
            ${field("Title", "title", current.kind === "todo" ? 300 : 200, true)}
            ${
              current.kind === "announcement"
                ? html`<label
                    ><span>Notice content</span
                    ><textarea
                      required
                      maxlength="8000"
                      rows="4"
                      .value=${current.body}
                      @input=${(event: Event) => {
                        current.body = (event.target as HTMLTextAreaElement).value;
                      }}
                    ></textarea>
                  </label>`
                : html`
                    <label
                      ><span>Assignee</span>${fieldSelect({
                        ariaLabel: "Assignee",
                        value: current.assigneeId,
                        onChange: (value) => {
                          current.assigneeId = value;
                        },
                        options: [
                          ...(!project.members.some((member) => member.principalId === current.assigneeId)
                            ? [
                                html`<option value=${current.assigneeId} selected>
                                  ${current.assigneeId} (left the project)
                                </option>`,
                              ]
                            : []),
                          ...project.members.map(
                            (member) =>
                              html`<option
                                value=${member.principalId}
                                ?selected=${current.assigneeId === member.principalId}
                              >
                                ${member.displayName}
                              </option>`,
                          ),
                        ],
                      })}</label
                    >
                    ${field("Source link (optional)", "sourceUrl", 2048)}${field("Result link (optional)", "resultUrl", 2048)}
                  `
            }
            <label
              ><span>${current.kind === "announcement" ? "Valid until (optional)" : "Due date (optional)"}</span
              ><input
                type="date"
                .value=${current.date}
                @input=${(event: Event) => {
                  current.date = (event.target as HTMLInputElement).value;
                }}
            /></label>
            <label class="project-check"
              ><input
                type="checkbox"
                .checked=${current.pinned}
                @change=${(event: Event) => {
                  current.pinned = (event.target as HTMLInputElement).checked;
                }}
              />Pin at top of project</label
            >
          `
    }
    <div class="project-board-actions">
      <button class="btn primary" ?disabled=${saving.has(board.projectId)} type="submit">
        ${current.kind === "announcement" ? "Publish" : "Save"}</button
      ><button
        class="btn"
        type="button"
        ?disabled=${saving.has(board.projectId)}
        @click=${() => {
          draft = null;
          redraw();
        }}
      >
        Cancel
      </button>
    </div>
  </form>`;
}

export function projectBoardSection(project: CoreProject, redraw: () => void): TemplateResult {
  const id = project.id;
  if (!notices.has(id)) loadBoard(id, redraw);
  const board = boards.get(id)?.board;
  const notice = notices.get(id);
  const heading = html`<div class="context-panel-heading">
    <h2 class="context-panel-title">Project notices and to-dos</h2>
    <button
      class="btn compact"
      type="button"
      @click=${() => {
        notices.delete(id);
        loadBoard(id, redraw, true);
        redraw();
      }}
    >
      Refresh
    </button>
  </div>`;
  if (!board)
    return html`<section class="context-panel project-board">
      ${heading}
      <p role="status">${notice || "Loading…"}</p>
    </section>`;
  const memberName = (actor: string) =>
    project.members.find((member) => member.principalId === actor)?.displayName ?? `${actor} (left the project)`;
  const mine = appState.me?.user;
  const todoCommand = (item: Todo, patch: Partial<Todo>) => ({
    kind: "todo",
    ...item,
    baseVersion: item.version,
    ...patch,
  });
  const orderedTodos = [...board.todos].sort(
    (a, b) => Number(b.pinned) - Number(a.pinned) || (a.dueAt ?? Infinity) - (b.dueAt ?? Infinity),
  );
  return html`<section class="context-panel project-board">
    ${heading}
    <div class="project-board-actions">
      ${projectPinButton(id, redraw)}${board.important ? html`<span class="badge">Important</span>` : nothing}${board.urgent ? html`<span class="badge">Urgent</span>` : nothing}${board.tags.map((tag) => html`<span class="badge">${tag}</span>`)}
    </div>
    ${notice ? html`<p role="alert">${notice}</p>` : nothing}
    <details
      class="project-board-pinned"
      .open=${expanded.get(`${id}:pins`) ?? true}
      @toggle=${(event: Event) => rememberExpansion(`${id}:pins`, event)}
    >
      <summary>Pinned items · ${openTodos(board).length} open to-dos</summary>
      <div class="project-pinned-content">${pinnedContent(board)}</div>
    </details>
    <div class="project-board-actions">
      ${board.canManage ? html`<button class="btn" type="button" @click=${() => begin(board, "announcement", redraw)}>Post notice</button><button class="btn" type="button" @click=${() => begin(board, "metadata", redraw)}>Categories and materials</button>` : nothing}
      <button class="btn" type="button" @click=${() => begin(board, "todo", redraw)}>New to-do</button>
    </div>
    ${form(board, project, redraw)}
    ${
      board.materials.length
        ? html`<div class="project-material-links">
            <h3>Existing project materials</h3>
            ${board.materials.map((item) => html`<a href=${item.url} target="_blank" rel="noopener noreferrer">${item.title}</a>`)}
          </div>`
        : nothing
    }
    <details
      class="project-board-list"
      .open=${expanded.get(`${id}:announcements`) ?? false}
      @toggle=${(event: Event) => rememberExpansion(`${id}:announcements`, event)}
    >
      <summary>All notices and history (${board.announcements.length})</summary>
      ${[...board.announcements].reverse().map(
        (item) =>
          html`<article class="project-board-item">
            <h3>${item.title}</h3>
            <p>${item.body}</p>
            <small>${announcementStatus(item)} · ${memberName(item.updatedBy)} · ${dateLabel(item.updatedAt)}</small>
            ${board.canManage ? html`<div class="project-board-actions"><button class="btn compact" type="button" @click=${() => begin(board, "announcement", redraw, item)}>Edit notice</button><button class="btn compact" type="button" ?disabled=${saving.has(id)} @click=${() => void update(id, { kind: "announcement", ...item, baseVersion: item.version, archived: !item.archived }, redraw)}>${item.archived ? "Restore notice" : "Archive notice"}</button></div>` : nothing}
            ${
              item.history.length
                ? html`<details
                    .open=${expanded.get(`${id}:history:${item.id}`) ?? false}
                    @toggle=${(event: Event) => rememberExpansion(`${id}:history:${item.id}`, event)}
                  >
                    <summary>Revision history (${item.history.length})</summary>
                    ${[...item.history].reverse().map(
                      (version) =>
                        html`<div class="project-board-history">
                          <strong>Version ${version.version} · ${version.title}</strong>
                          <p>${version.body}</p>
                          <small
                            >${memberName(version.updatedBy)} · ${dateLabel(version.updatedAt)} ·
                            ${version.archived ? "Archived" : "Not archived"}</small
                          >
                        </div>`,
                    )}
                  </details>`
                : nothing
            }
          </article>`,
      )}
    </details>
    <details
      class="project-board-list"
      .open=${expanded.get(`${id}:todos`) ?? true}
      @toggle=${(event: Event) => rememberExpansion(`${id}:todos`, event)}
    >
      <summary>To-dos (${board.todos.length})</summary>
      ${orderedTodos.map((item) => {
        const canEdit = board.canManage || item.createdBy === mine;
        const canUpdate = canEdit || item.assigneeId === mine;
        return html`<article class="project-board-item">
          <h3>${item.pinned ? "Pinned · " : ""}${item.title}</h3>
          <small
            >${memberName(item.assigneeId)} ·
            ${item.dueAt !== null ? `Due ${dateLabel(item.dueAt)}` : "No due date"}${item.dueAt !== null && item.dueAt < Date.now() && (item.status === "open" || item.status === "doing") ? " · Overdue" : ""}</small
          >
          <div class="project-board-actions">
            <label
              ><span class="sr-only">Status of ${item.title}</span
              >${fieldSelect({ ariaLabel: `Status of ${item.title}`, value: item.status, disabled: !canUpdate || saving.has(id), onChange: (value) => void update(id, todoCommand(item, { status: value as Todo["status"] }), redraw), options: Object.entries(statusLabels).map(([value, label]) => html`<option value=${value} ?selected=${item.status === value}>${label}</option>`) })}</label
            >
            ${item.sourceUrl ? html`<a href=${item.sourceUrl} target="_blank" rel="noopener noreferrer">View source</a>` : nothing}${item.resultUrl ? html`<a href=${item.resultUrl} target="_blank" rel="noopener noreferrer">View result</a>` : nothing}
            ${canEdit ? html`<button class="btn compact" type="button" @click=${() => begin(board, "todo", redraw, item)}>Edit to-do</button><button class="btn compact" type="button" ?disabled=${saving.has(id)} @click=${() => void update(id, todoCommand(item, { pinned: !item.pinned }), redraw)}>${item.pinned ? "Unpin" : "Pin to-do"}</button>` : nothing}
          </div>
          ${
            canUpdate
              ? html`<form
                  class="project-todo-result"
                  @submit=${(event: SubmitEvent) => {
                    event.preventDefault();
                    const value = String(new FormData(event.currentTarget as HTMLFormElement).get("resultUrl") ?? "");
                    const key = `${id}:${item.id}`;
                    void update(id, todoCommand(item, { resultUrl: value }), redraw, undefined, () => {
                      if (resultDrafts.get(key) === value) resultDrafts.delete(key);
                    });
                  }}
                >
                  <label
                    ><span class="sr-only">Result link of ${item.title}</span
                    ><input
                      name="resultUrl"
                      aria-label=${`Result link of ${item.title}`}
                      maxlength="2048"
                      placeholder="Enter result link"
                      .value=${resultDrafts.get(`${id}:${item.id}`) ?? item.resultUrl}
                      @input=${(event: Event) => resultDrafts.set(`${id}:${item.id}`, (event.target as HTMLInputElement).value)} /></label
                  ><button class="btn compact" type="submit" ?disabled=${saving.has(id)}>Save result link</button>
                </form>`
              : nothing
          }
        </article>`;
      })}
    </details>
  </section>`;
}
