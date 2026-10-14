import { html, render } from "lit";
import { X, Folder } from "lucide";
import { icon } from "./ui";
import { forkSession, type CoreSession } from "./core-bridge";
import { contextsState, ensureContexts } from "./contexts";
import { userErrorMessage as errMessage } from "./user-error";

interface ProjectChoice {
  scopeId: string;
  name: string;
}

export async function openBringIntoProject(session: CoreSession, onDone: (copy: CoreSession) => void): Promise<void> {
  const opener = document.activeElement as HTMLElement | null;
  const dialog = document.createElement("dialog");
  dialog.className = "project-dialog bring-into-project-dialog";
  dialog.setAttribute("aria-labelledby", "bring-into-project-heading");
  document.body.append(dialog);
  let projects: ProjectChoice[] = [];
  let loading = true;
  let chosen = "";
  let busy = false;
  let error = "";
  const close = () => {
    dialog.close();
    dialog.remove();
    if (opener?.isConnected) opener.focus();
  };
  dialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    if (!busy) close();
  });
  const confirm = async () => {
    if (!chosen || busy) return;
    busy = true;
    error = "";
    draw();
    try {
      const copy = await forkSession(session.id, undefined, chosen);
      close();
      onDone(copy.session);
    } catch (e) {
      busy = false;
      error = errMessage(e, "Could not bring this conversation into the project.");
      draw();
    }
  };
  const draw = () => {
    render(
      html`
        <div class="project-dialog-head">
          <div><h2 id="bring-into-project-heading">Bring into project</h2></div>
          <button class="chip-x" type="button" aria-label="Close" ?disabled=${busy} @click=${close}>
            ${icon(X, 16)}
          </button>
        </div>
        <ul class="bring-into-project-notes">
          <li>This makes a copy of the whole conversation in the project, including tool output and attachments.</li>
          <li>Every current and future member of the project will be able to see it.</li>
          <li>Your personal memory is not carried over.</li>
          <li>The original conversation stays private and unchanged.</li>
        </ul>
        ${
          loading
            ? html`<p role="status">Loading projects…</p>`
            : html`<div class="bring-into-project-list" role="radiogroup" aria-label="Project">
                ${projects.map(
                  (project) =>
                    html`<label class="bring-into-project-option">
                      <input
                        type="radio"
                        name="bring-into-project"
                        .checked=${chosen === project.scopeId}
                        ?disabled=${busy}
                        @change=${() => {
                          chosen = project.scopeId;
                          draw();
                        }}
                      />
                      <span>${project.name}</span>
                    </label>`,
                )}
              </div>`
        }
        ${!loading && !projects.length ? html`<p role="status">You are not a member of any project yet.</p>` : ""}
        ${error ? html`<div class="composer-error" role="alert">${error}</div>` : ""}
        <div class="project-dialog-actions actions">
          <button class="btn" type="button" ?disabled=${busy} @click=${close}>Cancel</button>
          <button class="btn primary" type="button" ?disabled=${!chosen || busy} @click=${() => void confirm()}>
            ${icon(Folder, 14)}${busy ? "Copying…" : "Bring into project"}
          </button>
        </div>
      `,
      dialog,
    );
  };
  draw();
  dialog.showModal();
  const contexts = await ensureContexts();
  if (!contextsState.loaded) error = "Could not load your projects.";
  projects = contexts.flatMap((context) =>
    context.project ? [{ scopeId: context.scopeId, name: context.project.name }] : [],
  );
  loading = false;
  draw();
}
