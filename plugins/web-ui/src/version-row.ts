import { html, nothing, type TemplateResult } from "lit";
import { markdown } from "./message-markdown";
import { productRelease, type ReleaseNotes } from "./product-release";

function earlierVersions(history: ReleaseNotes[]): TemplateResult | typeof nothing {
  if (!history.length) return nothing;
  return html`
    <div class="settings-version-history">
      <div class="settings-version-history-title">Earlier versions</div>
      ${history.map(
        (past) => html`
          <details class="settings-version-past">
            <summary>v${past.version}</summary>
            <div class="settings-version-notes">${markdown(past.notes)}</div>
          </details>
        `,
      )}
    </div>
  `;
}

export function versionRow(): TemplateResult | typeof nothing {
  const release = productRelease(document);
  if (!release) return nothing;
  return html`
    <details class="settings-row settings-version">
      <summary class="settings-version-summary">
        <span class="settings-row-copy">
          <span class="settings-row-title">Version</span>
          <span class="settings-row-note">v${release.version}</span>
        </span>
        <span class="btn settings-row-action">What's new</span>
      </summary>
      <div class="settings-version-notes">${markdown(release.notes)}</div>
      ${earlierVersions(release.history)}
    </details>
  `;
}
