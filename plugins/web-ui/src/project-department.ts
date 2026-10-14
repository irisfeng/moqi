import { html, nothing, type TemplateResult } from "lit";
import { api } from "./core-bridge.ts";
import { errMessage } from "../../chassis/src/errors.ts";
import { fieldSelect } from "./ui.ts";

interface DepartmentPreview {
  members: Array<{ principalId: string; displayName: string }>;
  alreadyIn: number;
}

const picker = {
  projectId: "",
  departments: null as string[] | null,
  selected: "",
  preview: null as DepartmentPreview | null,
  busy: false,
  note: "",
  failed: false,
};
let generation = 0;

export function resetDepartmentPicker(): void {
  generation += 1;
  picker.projectId = "";
  picker.departments = null;
  picker.selected = "";
  picker.preview = null;
  picker.busy = false;
  picker.note = "";
  picker.failed = false;
}

export function departmentSummary(preview: DepartmentPreview): string {
  const added = preview.members.length;
  if (added === 0)
    return preview.alreadyIn
      ? "Everyone in this department is already in the project."
      : "Nobody in this department can be added.";
  return preview.alreadyIn
    ? `${added} people will be added. ${preview.alreadyIn} are already in the project.`
    : `${added} people will be added.`;
}

function fail(error: unknown, fallback: string): void {
  picker.note = errMessage(error, fallback);
  picker.failed = true;
}

async function load(projectId: string, redraw: () => void, department = ""): Promise<void> {
  generation += 1;
  const started = generation;
  picker.busy = true;
  picker.note = "";
  picker.failed = false;
  redraw();
  try {
    const query = department ? `?department=${encodeURIComponent(department)}` : "";
    const result = await api<{ departments: string[]; members?: DepartmentPreview["members"]; alreadyIn?: number }>(
      `/api/projects/${encodeURIComponent(projectId)}/departments${query}`,
    );
    if (started !== generation) return;
    picker.departments = result.departments;
    picker.preview = department ? { members: result.members ?? [], alreadyIn: result.alreadyIn ?? 0 } : null;
  } catch (error) {
    if (started !== generation) return;
    picker.departments ??= [];
    picker.preview = null;
    fail(error, "Couldn't load departments.");
  } finally {
    if (started === generation) {
      picker.busy = false;
      redraw();
    }
  }
}

async function confirm(projectId: string, redraw: () => void, added: () => Promise<unknown>): Promise<void> {
  const preview = picker.preview;
  if (!preview?.members.length || picker.busy) return;
  const started = generation;
  picker.busy = true;
  picker.note = "";
  picker.failed = false;
  redraw();
  try {
    const result = await api<{ added: number }>(`/api/projects/${encodeURIComponent(projectId)}/members/department`, {
      method: "POST",
      body: JSON.stringify({ department: picker.selected, memberIds: preview.members.map((m) => m.principalId) }),
    });
    if (started !== generation) return;
    picker.selected = "";
    picker.preview = null;
    picker.note = `${result.added} people added.`;
    await added();
  } catch (error) {
    if (started !== generation) return;
    fail(error, "Couldn't add the department.");
  } finally {
    if (started === generation) {
      picker.busy = false;
      redraw();
    }
  }
}

export function departmentPicker(
  projectId: string,
  redraw: () => void,
  added: () => Promise<unknown>,
): TemplateResult | typeof nothing {
  if (picker.projectId !== projectId) {
    resetDepartmentPicker();
    picker.projectId = projectId;
    queueMicrotask(() => void load(projectId, redraw));
  }
  const departments = picker.departments;
  if (!departments) return nothing;
  if (!departments.length)
    return html`<div class="project-department-picker">
      <div class="project-member-status ${picker.failed ? "error" : ""}" aria-live="polite">
        ${picker.note || "No departments are recorded yet. An admin adds them with the adoption roster."}
      </div>
    </div>`;
  const preview = picker.preview;
  return html`
    <div class="project-department-picker">
      <label for="project-department">Add a department</label>
      ${fieldSelect({
        id: "project-department",
        value: picker.selected,
        disabled: picker.busy,
        onChange: (value) => {
          picker.selected = value;
          picker.preview = null;
          if (value) void load(projectId, redraw, value);
          else redraw();
        },
        options: [
          html`<option value="" ?selected=${!picker.selected}>Choose a department…</option>`,
          ...departments.map(
            (name) => html`<option value=${name} ?selected=${name === picker.selected}>${name}</option>`,
          ),
        ],
      })}
      ${
        preview
          ? html`<p class="project-department-summary">${departmentSummary(preview)}</p>
              ${
                preview.members.length
                  ? html`<ul class="project-department-list">
                        ${preview.members.map((member) => html`<li dir="auto">${member.displayName}</li>`)}
                      </ul>
                      <p class="project-department-hint">
                        Only the people listed now are added. Anyone who joins the department later is not.
                      </p>
                      <button
                        class="btn primary"
                        type="button"
                        ?disabled=${picker.busy}
                        @click=${() => void confirm(projectId, redraw, added)}
                      >
                        Add these people
                      </button>`
                  : nothing
              }`
          : nothing
      }
      <div class="project-member-status ${picker.failed ? "error" : ""}" aria-live="polite">
        ${picker.busy ? "Working…" : picker.note}
      </div>
    </div>
  `;
}
