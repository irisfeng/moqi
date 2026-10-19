import { previewFile } from "./file-open.ts";
import { html, nothing, render } from "lit";
import {
  ArrowLeft,
  Download,
  File,
  FileArchive,
  FileAudio,
  FileCode,
  FileImage,
  FileJson,
  FileSpreadsheet,
  FileText,
  FileVideo,
  Presentation,
  RotateCcw,
  Search,
  Trash2,
  Upload,
  type IconNode,
} from "lucide";
import { api, fileContentUrl, webFetch, withBase } from "./core-bridge";
import { userErrorMessage as errMessage } from "./user-error.ts";
import { browserRenderableImage, fieldSelect, formatBytes, relTime } from "./ui";
import { icon } from "./icons";
import { contextsState, ensureContexts, personalScopeId, scopeTitle } from "./contexts";
import { appState } from "./shell";
import { fileListNeedsAllPages } from "./file-list";
import { scopedSession, scopedViewTopbar } from "./session-scope";
import { listRowsTpl } from "./list-page";
import { createListPagination } from "./list-pagination";
import { isTouch } from "./viewport";
import { tip } from "./tooltip";

interface FileItem {
  id: string;
  name: string;
  mimetype: string;
  sizeBytes: number;
  direction: "in" | "out";
  createdAt: number;
  createdInScope?: string;
  ownerScopeId?: string;
  openable: boolean;
  canTrash?: boolean;
}
interface FileRow extends FileItem {
  kind: "Created" | "Uploaded" | "Shared";
}

const PAGE_SIZE = 60;
let fileRows: FileRow[] = [];
let filesNotice = "";
let filesScope: string | null = null;
let filesQuery = "";
let filesType: "all" | "image" | "document" | "other" = "all";
let filesOwnership: "all" | "owned" | "shared" = "all";
let filesDragActive = false;
let filesUploading = false;
let filesLoadingMore = false;
let filesNextCursor: string | null = null;
let filesHost: HTMLElement | null = null;
let filesRequestSeq = 0;
let filesLoadAllQueued = false;
let filesTrashView = false;
let trashRows: FileRow[] = [];
let trashNextCursor: string | null = null;
const filesBusy = new Set<string>();

function fileScope(f: FileItem): string | null {
  return f.createdInScope ?? (f.ownerScopeId?.startsWith("personal:") ? f.ownerScopeId : null) ?? personalScopeId();
}

function typeOf(f: FileItem): "image" | "document" | "other" {
  if (browserRenderableImage(f.mimetype)) return "image";
  if (f.mimetype.startsWith("text/") || /(?:pdf|document|sheet|presentation|json|xml|csv)/i.test(f.mimetype))
    return "document";
  return "other";
}

type FileVisualKind =
  "image" | "pdf" | "spreadsheet" | "presentation" | "code" | "archive" | "audio" | "video" | "document" | "generic";

function fileVisual(f: FileItem): { glyph: IconNode; kind: FileVisualKind } {
  const name = f.name.toLowerCase();
  const mime = f.mimetype.toLowerCase();
  if (browserRenderableImage(mime)) return { glyph: FileImage, kind: "image" };
  if (mime.includes("pdf") || name.endsWith(".pdf")) return { glyph: FileText, kind: "pdf" };
  if (/(?:spreadsheet|excel|csv|tab-separated)/.test(mime) || /\.(?:csv|tsv|xls|xlsx|ods)$/.test(name))
    return { glyph: FileSpreadsheet, kind: "spreadsheet" };
  if (/(?:presentation|powerpoint)/.test(mime) || /\.(?:ppt|pptx|key|odp)$/.test(name))
    return { glyph: Presentation, kind: "presentation" };
  if (mime.includes("json") || name.endsWith(".json")) return { glyph: FileJson, kind: "code" };
  if (/(?:zip|archive|compressed|tar|gzip)/.test(mime) || /\.(?:zip|tar|gz|tgz|rar|7z)$/.test(name))
    return { glyph: FileArchive, kind: "archive" };
  if (mime.startsWith("audio/")) return { glyph: FileAudio, kind: "audio" };
  if (mime.startsWith("video/")) return { glyph: FileVideo, kind: "video" };
  if (
    /(?:javascript|typescript|xml|html|css|shell|python)/.test(mime) ||
    /\.(?:js|ts|tsx|jsx|html|css|py|sh|sql|xml|yaml|yml)$/.test(name)
  )
    return { glyph: FileCode, kind: "code" };
  if (mime.startsWith("text/") || typeOf(f) === "document") return { glyph: FileText, kind: "document" };
  return { glyph: File, kind: "generic" };
}

function groupFilesByScope(files: FileRow[]): Array<{ scope: string | null; files: FileRow[] }> {
  const groups = new Map<string, { scope: string | null; files: FileRow[] }>();
  for (const file of files) {
    const scope = fileScope(file);
    const key = scope ?? "";
    const group = groups.get(key) ?? { scope, files: [] };
    group.files.push(file);
    groups.set(key, group);
  }
  return [...groups.values()];
}

function selectControl(
  label: string,
  value: string,
  options: Array<[string, string]>,
  onChange: (value: string) => void,
) {
  return html`<label class="list-select"
    ><span>${label}</span>${fieldSelect({
      compact: true,
      value,
      onChange,
      options: options.map(([v, text]) => html`<option value=${v}>${text}</option>`),
    })}</label
  >`;
}

function visibleFiles(): FileRow[] {
  const q = filesQuery.trim().toLowerCase();
  return fileRows
    .filter((f) => !filesScope || fileScope(f) === filesScope)
    .filter((f) => filesOwnership === "all" || (filesOwnership === "shared") === (f.kind === "Shared"))
    .filter((f) => filesType === "all" || typeOf(f) === filesType)
    .filter((f) => !q || `${f.name} ${f.mimetype}`.toLowerCase().includes(q))
    .sort((a, b) => b.createdAt - a.createdAt);
}

const paginateFiles = createListPagination();

function drawFiles(loading = false): void {
  if (appState.currentView !== "files" || !appState.mainEl) return;
  if (!filesHost || filesHost.parentElement !== appState.mainEl) {
    filesHost = document.createElement("div");
    filesHost.className = "pane files-page";
    appState.mainEl.replaceChildren(filesHost);
  }
  const visible = visibleFiles();
  const pagination = paginateFiles(
    visible,
    JSON.stringify([filesScope, filesQuery, filesType, filesOwnership]),
    drawFiles,
    {
      more: Boolean(filesNextCursor),
      loading: loading || filesLoadingMore,
      next: async () => {
        await loadMoreFiles();
        return !filesNotice;
      },
    },
  );
  const groups = groupFilesByScope(pagination.rows);
  const filtered = Boolean(filesScope || filesQuery.trim() || filesType !== "all" || filesOwnership !== "all");
  let dropLabel = isTouch() ? "Choose files to upload" : "Drop files here or choose files";
  if (filesDragActive) dropLabel = "Drop files";
  else if (filesUploading) dropLabel = "Uploading…";
  const emptyLoading = loading && !(filesTrashView ? trashRows : fileRows).length;
  let loadingLabel = "";
  if (emptyLoading) loadingLabel = filesTrashView ? "Loading the recycle bin…" : "Loading files…";
  const status = filesNotice || loadingLabel;
  const scoped = Boolean(scopedSession.active);
  filesHost.classList.toggle("scoped-view", scoped);
  render(
    html`
      ${scopedViewTopbar("files", drawFiles)}
      <div class="list-page-head">
        <h1 class="pane-title">${filesTrashView ? "Recycle bin" : "Files"}</h1>
        ${
          filesTrashView
            ? nothing
            : html`<label class="list-search"
                >${icon(Search, 16)}<span class="sr-only">Search files</span
                ><input
                  type="search"
                  aria-label="Search files"
                  placeholder="Search file names and types…"
                  .value=${filesQuery}
                  @input=${(e: Event) => {
                    filesQuery = (e.currentTarget as HTMLInputElement).value;
                    drawFiles();
                    void loadAllFiles();
                  }}
              /></label>`
        }
      </div>
      <div class="list-toolbar">
        ${
          filesTrashView
            ? nothing
            : html`${selectControl(
                "Ownership",
                filesOwnership,
                [
                  ["all", "All files"],
                  ["owned", "Yours"],
                  ["shared", "Shared"],
                ],
                (v) => {
                  filesOwnership = v as typeof filesOwnership;
                  drawFiles();
                  void loadAllFiles();
                },
              )}
              ${selectControl(
                "Type",
                filesType,
                [
                  ["all", "All types"],
                  ["image", "Images"],
                  ["document", "Documents"],
                  ["other", "Other"],
                ],
                (v) => {
                  filesType = v as typeof filesType;
                  drawFiles();
                  void loadAllFiles();
                },
              )}`
        }
        <button class="btn" type="button" @click=${() => void setTrashView(!filesTrashView)}>
          ${icon(filesTrashView ? ArrowLeft : Trash2, 14)}<span
            >${filesTrashView ? "Back to files" : "Recycle bin"}</span
          >
        </button>
      </div>
      ${status ? html`<div class="status" aria-live="polite">${status}</div>` : nothing}
      ${
        filesTrashView
          ? trashTpl()
          : html`<button
                class="file-drop ${filesDragActive ? "dragging" : ""}"
                type="button"
                ?disabled=${filesUploading}
                @click=${pickFiles}
                @dragenter=${onFileDrag}
                @dragover=${onFileDrag}
                @dragleave=${onFileDragLeave}
                @drop=${onFileDrop}
              >
                ${icon(Upload, 16)}<span>${dropLabel}</span>
              </button>
              ${pagination.controls}
              ${
                visible.length
                  ? html`<div class="file-groups">
                      ${groups.map(
                        (group) =>
                          html`<section class="file-scope-group">
                            <h2>${scopeTitle(group.scope)}</h2>
                            ${listRowsTpl(group.files.map(fileRow), "file-list")}
                          </section>`,
                      )}
                    </div>`
                  : html`<div class="empty compact">
                      ${filtered ? "No files match these filters." : "No files yet."}
                    </div>`
              }
              ${pagination.controls}`
      }
    `,
    filesHost,
  );
}

function trashTpl() {
  return html`${
    trashRows.length
      ? listRowsTpl(trashRows.map(trashRow), "file-list")
      : html`<div class="empty compact">The recycle bin is empty.</div>`
  }
  ${
    trashNextCursor
      ? html`<div class="list-footer">
          <button class="btn" type="button" ?disabled=${filesLoadingMore} @click=${() => void loadMoreTrash()}>
            ${filesLoadingMore ? "Loading…" : "Load more"}
          </button>
        </div>`
      : nothing
  }`;
}

function trashRow(f: FileRow) {
  const visual = fileVisual(f);
  return html`<div class="file-row-wrap">
    <article class="list-row file-row">
      <span class="file-row-icon ${visual.kind}">${icon(visual.glyph, 18)}</span>
      <span class="list-row-title" dir="auto">${f.name}</span>
      <span class="list-row-meta"><span>${formatBytes(f.sizeBytes)}</span><span>${relTime(f.createdAt)}</span></span>
    </article>
    <button class="btn compact" type="button" ?disabled=${filesBusy.has(f.id)} @click=${() => void restoreFile(f)}>
      ${icon(RotateCcw, 14)}<span>Restore</span>
    </button>
  </div>`;
}

function fileRow(f: FileRow) {
  const contentUrl = fileContentUrl(f.id, f.name);
  const visual = fileVisual(f);
  const content = html`
    <span class="file-row-icon ${visual.kind}">${icon(visual.glyph, 18)}</span>
    <span class="list-row-title" dir="auto">${f.name}</span>
    <span class="list-row-meta"
      ><span>${formatBytes(f.sizeBytes)}</span><span>${relTime(f.createdAt)}</span>${
        f.openable ? nothing : html`<span>Unavailable</span>`
      }</span
    >
  `;
  const row = f.openable
    ? html`<a
        class="list-row file-row"
        href=${contentUrl}
        target="_blank"
        rel="noreferrer"
        @click=${(event: MouseEvent) => previewFile(event, f.name, contentUrl, f.mimetype)}
        >${content}</a
      >`
    : html`<article class="list-row file-row">${content}</article>`;
  return html`<div class="file-row-wrap">
    ${row}${
      f.openable
        ? html`<a
            class="icon-btn subtle compact"
            href=${contentUrl + "?download=1"}
            download=${f.name}
            ${tip("Download")}
            aria-label="Download"
          >
            ${icon(Download, 14)}
          </a>`
        : nothing
    }${
      f.canTrash
        ? html`<button
            class="icon-btn subtle compact"
            type="button"
            ${tip("Move to recycle bin")}
            aria-label="Move to recycle bin"
            ?disabled=${filesBusy.has(f.id)}
            @click=${() => void trashFile(f)}
          >
            ${icon(Trash2, 14)}
          </button>`
        : nothing
    }
  </div>`;
}

async function trashFile(f: FileRow): Promise<void> {
  if (filesBusy.has(f.id)) return;
  filesBusy.add(f.id);
  filesNotice = "";
  drawFiles();
  try {
    await api(`/api/files/${encodeURIComponent(f.id)}`, { method: "DELETE" });
    fileRows = fileRows.filter((r) => r.id !== f.id);
  } catch (e) {
    filesNotice = errMessage(e, "Failed to move the file to the recycle bin.");
  } finally {
    filesBusy.delete(f.id);
    drawFiles();
  }
}

async function restoreFile(f: FileRow): Promise<void> {
  if (filesBusy.has(f.id)) return;
  filesBusy.add(f.id);
  filesNotice = "";
  drawFiles();
  try {
    await api(`/api/files/${encodeURIComponent(f.id)}/restore`, { method: "POST" });
    trashRows = trashRows.filter((r) => r.id !== f.id);
  } catch (e) {
    filesNotice = errMessage(e, "Failed to restore the file.");
  } finally {
    filesBusy.delete(f.id);
    drawFiles();
  }
}

async function fileSha256(file: globalThis.File): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function uploadOne(file: globalThis.File): Promise<void> {
  const scope = filesScope ?? personalScopeId();
  const q = new URLSearchParams();
  if (scope) q.set("scope", scope);
  q.set("sha", await fileSha256(file));
  q.set("name", file.name || "file");
  const r = await webFetch(withBase(`/api/files/upload?${q.toString()}`), {
    method: "POST",
    headers: { "content-type": file.type || "application/octet-stream" },
    body: file,
  });
  if (!r.ok) {
    const text = await r.text();
    let message = `Upload failed (${r.status})`;
    try {
      const parsed = JSON.parse(text) as { message?: string; error?: string };
      message = parsed.message ?? parsed.error ?? message;
    } catch {
      if (text.trim()) message = text.trim();
    }
    throw new Error(message);
  }
}

async function uploadFiles(files: globalThis.File[]): Promise<void> {
  const picked = files.filter((f) => f.size >= 0);
  if (!picked.length || filesUploading) return;
  filesUploading = true;
  filesNotice = `Uploading ${picked.length} ${picked.length === 1 ? "file" : "files"}…`;
  drawFiles();
  let uploaded = 0;
  try {
    for (const file of picked) {
      await uploadOne(file);
      uploaded++;
    }
    filesNotice = `Uploaded ${picked.length} ${picked.length === 1 ? "file" : "files"}.`;
    await loadFiles(appState.viewRenderSeq);
  } catch (e) {
    filesNotice = `${uploaded ? `Uploaded ${uploaded} of ${picked.length}. ` : ""}${errMessage(e, "Upload failed.")}`;
    if (uploaded) await loadFiles(appState.viewRenderSeq);
    else drawFiles();
  } finally {
    filesUploading = false;
    filesDragActive = false;
    drawFiles();
  }
}

function pickFiles(): void {
  const input = document.createElement("input");
  input.type = "file";
  input.multiple = true;
  input.onchange = () => void uploadFiles(Array.from(input.files ?? []));
  input.click();
}

function hasFiles(e: DragEvent): boolean {
  return Array.from(e.dataTransfer?.types ?? []).includes("Files");
}

function onFileDrag(e: DragEvent): void {
  if (!hasFiles(e)) return;
  e.preventDefault();
  if (!filesDragActive) {
    filesDragActive = true;
    drawFiles();
  }
}

function onFileDragLeave(e: DragEvent): void {
  if (!hasFiles(e)) return;
  const current = e.currentTarget as HTMLElement;
  if (e.relatedTarget instanceof Node && current.contains(e.relatedTarget)) return;
  filesDragActive = false;
  drawFiles();
}

function onFileDrop(e: DragEvent): void {
  if (!hasFiles(e)) return;
  e.preventDefault();
  e.stopPropagation();
  filesDragActive = false;
  void uploadFiles(Array.from(e.dataTransfer?.files ?? []));
}

function rowsFromPage(r: { owned?: FileItem[]; shared?: FileItem[] }): FileRow[] {
  return [
    ...(r.owned ?? []).map((f): FileRow => ({ ...f, kind: f.direction === "out" ? "Created" : "Uploaded" })),
    ...(r.shared ?? []).map((f): FileRow => ({ ...f, kind: "Shared" })),
  ];
}

async function fetchFilePage(
  cursor?: string,
  scope = filesScope,
): Promise<{ rows: FileRow[]; nextCursor: string | null }> {
  const q = new URLSearchParams({ limit: String(PAGE_SIZE) });
  if (cursor) q.set("cursor", cursor);
  if (scope) q.set("scope", scope);
  const r = await api<{ owned?: FileItem[]; shared?: FileItem[]; nextCursor?: string }>(`/api/files?${q.toString()}`);
  return { rows: rowsFromPage(r), nextCursor: r.nextCursor ?? null };
}

async function fetchTrashPage(cursor?: string): Promise<{ rows: FileRow[]; nextCursor: string | null }> {
  const q = new URLSearchParams({ limit: String(PAGE_SIZE) });
  if (cursor) q.set("cursor", cursor);
  const r = await api<{ owned?: FileItem[]; nextCursor?: string }>(`/api/files/trash?${q.toString()}`);
  return { rows: rowsFromPage(r), nextCursor: r.nextCursor ?? null };
}

async function loadMoreTrash(): Promise<void> {
  if (!trashNextCursor || filesLoadingMore) return;
  const requestSeq = filesRequestSeq;
  filesLoadingMore = true;
  drawFiles();
  try {
    const page = await fetchTrashPage(trashNextCursor);
    if (requestSeq !== filesRequestSeq) return;
    const byId = new Map(trashRows.map((f) => [f.id, f]));
    for (const row of page.rows) byId.set(row.id, row);
    trashRows = [...byId.values()];
    trashNextCursor = page.nextCursor;
  } catch (e) {
    if (requestSeq !== filesRequestSeq) return;
    filesNotice = errMessage(e, "Failed to load more files.");
  }
  if (requestSeq !== filesRequestSeq) return;
  filesLoadingMore = false;
  drawFiles();
}

async function loadTrash(seq: number): Promise<void> {
  const requestSeq = ++filesRequestSeq;
  filesLoadAllQueued = false;
  filesLoadingMore = false;
  drawFiles(true);
  try {
    const page = await fetchTrashPage();
    if (requestSeq !== filesRequestSeq || seq !== appState.viewRenderSeq || appState.currentView !== "files") return;
    trashRows = page.rows;
    trashNextCursor = page.nextCursor;
  } catch (e) {
    if (requestSeq !== filesRequestSeq || seq !== appState.viewRenderSeq || appState.currentView !== "files") return;
    filesNotice = errMessage(e, "Failed to load the recycle bin.");
  }
  drawFiles();
}

async function setTrashView(on: boolean): Promise<void> {
  filesTrashView = on;
  filesNotice = "";
  trashRows = [];
  trashNextCursor = null;
  const seq = appState.viewRenderSeq;
  if (on) await loadTrash(seq);
  else await loadFiles(seq);
}

async function loadMoreFiles(): Promise<void> {
  if (!filesNextCursor || filesLoadingMore) return;
  const requestSeq = filesRequestSeq;
  const scope = filesScope;
  filesLoadingMore = true;
  filesNotice = "";
  drawFiles();
  try {
    const page = await fetchFilePage(filesNextCursor, scope);
    if (requestSeq !== filesRequestSeq) return;
    const byId = new Map(fileRows.map((f) => [f.id, f]));
    for (const row of page.rows) byId.set(row.id, row);
    fileRows = [...byId.values()];
    filesNextCursor = page.nextCursor;
  } catch (e) {
    if (requestSeq !== filesRequestSeq) return;
    filesNotice = errMessage(e, "Failed to load more files.");
  }
  if (requestSeq !== filesRequestSeq) return;
  filesLoadingMore = false;
  drawFiles();
  if (filesLoadAllQueued) {
    filesLoadAllQueued = false;
    void loadAllFiles();
  }
}

async function loadAllFiles(): Promise<void> {
  if (filesTrashView) return;
  if (!fileListNeedsAllPages({ query: filesQuery, type: filesType, ownership: filesOwnership, sort: "newest" })) return;
  if (filesLoadingMore) {
    filesLoadAllQueued = true;
    return;
  }
  const requestSeq = filesRequestSeq;
  const scope = filesScope;
  filesLoadingMore = true;
  drawFiles();
  try {
    while (filesNextCursor && requestSeq === filesRequestSeq) {
      const page = await fetchFilePage(filesNextCursor, scope);
      if (requestSeq !== filesRequestSeq) return;
      const byId = new Map(fileRows.map((file) => [file.id, file]));
      for (const row of page.rows) byId.set(row.id, row);
      fileRows = [...byId.values()];
      filesNextCursor = page.nextCursor;
    }
  } catch (e) {
    if (requestSeq !== filesRequestSeq) return;
    filesNotice = errMessage(e, "Failed to load all matching files.");
  }
  if (requestSeq !== filesRequestSeq) return;
  filesLoadAllQueued = false;
  filesLoadingMore = false;
  drawFiles();
}

async function loadFiles(seq: number): Promise<void> {
  const requestSeq = ++filesRequestSeq;
  filesLoadAllQueued = false;
  filesLoadingMore = false;
  await ensureContexts();
  drawFiles(true);
  try {
    const page = await fetchFilePage();
    if (requestSeq !== filesRequestSeq || seq !== appState.viewRenderSeq || appState.currentView !== "files") return;
    fileRows = page.rows;
    filesNextCursor = page.nextCursor;
    void loadAllFiles();
  } catch (e) {
    if (requestSeq !== filesRequestSeq || seq !== appState.viewRenderSeq || appState.currentView !== "files") return;
    filesNotice = errMessage(e, "Failed to load files.");
  }
  drawFiles();
}

export async function renderFiles(): Promise<void> {
  if (appState.currentView !== "files") return;
  if (scopedSession.active) {
    if (filesScope !== scopedSession.active.scopeId) {
      filesScope = scopedSession.active.scopeId;
      fileRows = [];
      filesNextCursor = null;
    }
    contextsState.selected = null;
  } else if (contextsState.selected) {
    filesScope = contextsState.selected;
    fileRows = [];
    filesNextCursor = null;
    contextsState.selected = null;
  } else if (filesScope) {
    filesScope = null;
    fileRows = [];
    filesNextCursor = null;
  }
  const seq = appState.viewRenderSeq;
  filesTrashView = false;
  filesNotice = "";
  filesNextCursor = null;
  await loadFiles(seq);
}
