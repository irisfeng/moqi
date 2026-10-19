import { html, nothing, render, type TemplateResult } from "lit";
import { Check, Mail, Phone, Search, type IconNode } from "lucide";
import { api } from "./core-bridge";
import { errMessage } from "../../chassis/src/errors";
import { groupPeople, type DirectoryPerson } from "./people-groups.ts";
import { appState } from "./shell-state";
import { copyText } from "./ui";
import { icon } from "./icons";

let host: HTMLDivElement | null = null;
let people: DirectoryPerson[] = [];
let query = "";
let loading = false;
let notice = "";

export function resetPeoplePage(): void {
  host = null;
  people = [];
  query = "";
  loading = false;
  notice = "";
}

export async function renderPeoplePage(): Promise<void> {
  if (appState.currentView !== "people") return;
  loading = true;
  notice = "";
  draw();
  const seq = appState.viewRenderSeq;
  try {
    const result = await api<{ people?: DirectoryPerson[] }>("/api/directory/people");
    if (seq !== appState.viewRenderSeq) return;
    people = result.people ?? [];
  } catch (error) {
    if (seq !== appState.viewRenderSeq) return;
    notice = errMessage(error, "Couldn't load the directory.");
  } finally {
    if (seq === appState.viewRenderSeq) {
      loading = false;
      draw();
    }
  }
}

function contactButton(value: string, glyph: IconNode, label: string): TemplateResult {
  return html`<button
    type="button"
    class="people-contact"
    title=${`${label}: ${value}`}
    aria-label=${`${label}: ${value}`}
    @click=${(event: MouseEvent) => void copyText(value, event.currentTarget as HTMLButtonElement)}
  >
    <span class="people-contact-icon" aria-hidden="true">${icon(glyph, 13)}</span>
    <span class="people-contact-done" aria-hidden="true">${icon(Check, 13)}</span>
    <span class="people-contact-value" dir="ltr">${value}</span>
  </button>`;
}

function draw(): void {
  if (appState.currentView !== "people" || !appState.mainEl) return;
  if (!host || host.parentElement !== appState.mainEl) {
    host = document.createElement("div");
    host.className = "pane people-page";
    appState.mainEl.replaceChildren(host);
  }
  const groups = groupPeople(people, query);
  let empty = "";
  if (!groups.length) {
    if (loading) empty = "Loading the directory…";
    else empty = query.trim() ? "Nobody matches your search." : "Nobody is in the directory yet.";
  }
  render(
    html`
      <div class="list-page-head">
        <h1 class="pane-title">Directory</h1>
        <label class="list-search"
          >${icon(Search, 16)}<span class="sr-only">Search people, departments, email or phone</span
          ><input
            data-focus-key="people-search"
            type="search"
            aria-label="Search people, departments, email or phone"
            placeholder="Search people, departments, email or phone…"
            .value=${query}
            @input=${(event: InputEvent) => {
              query = (event.currentTarget as HTMLInputElement).value;
              draw();
            }}
        /></label>
      </div>
      ${notice ? html`<div class="action-notice">${notice}</div>` : nothing}
      ${empty ? html`<div class="empty compact">${empty}</div>` : nothing}
      <div class="people-list">
        ${groups.map(
          (group) => html`
            <section class="project-group">
              <div class="project-group-head">
                <span dir="auto">${group.department ?? "No department · only admins see this"}</span>
                <span class="project-group-count">· ${group.people.length}</span>
              </div>
              ${group.people.map(
                (person) => html`
                  <div class="people-row">
                    <span class="project-member-avatar" aria-hidden="true"
                      >${[...person.displayName.trim()][0] ?? "?"}</span
                    >
                    <span class="people-name" dir="auto">${person.displayName}</span>
                    <span class="people-contacts">
                      ${person.email ? contactButton(person.email, Mail, "Copy email") : nothing}
                      ${person.phone ? contactButton(person.phone, Phone, "Copy phone number") : nothing}
                    </span>
                  </div>
                `,
              )}
            </section>
          `,
        )}
      </div>
    `,
    host,
  );
}
