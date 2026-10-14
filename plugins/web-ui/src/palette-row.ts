import { html, nothing, type TemplateResult } from "lit";
import { setTheme, storedCustomTheme, storedTheme } from "./settings";
import { galleryThemes, orgThemeId, storedPalette, storePalette, type GalleryTheme } from "./theme-gallery";

function pickPalette(id: string, orgId: string | null): void {
  storePalette(id === orgId ? null : id);
  const choice = storedTheme();
  setTheme(choice === "custom" ? "system" : choice);
}

function followOrganization(): void {
  storePalette(null);
  setTheme(storedTheme());
}

function preview(palette: GalleryTheme): TemplateResult {
  const colors = document.documentElement.classList.contains("dark") ? palette.dark : palette.light;
  return html`
    <span class="settings-palette-preview" style="background:${colors.background ?? "transparent"}" aria-hidden="true">
      <span class="settings-palette-side" style="background:${colors.sidebar ?? "transparent"}"></span>
      <span class="settings-palette-bar" style="background:${colors.foreground ?? "transparent"}"></span>
      <span class="settings-palette-pill" style="background:${colors.cta ?? "transparent"}"></span>
    </span>
  `;
}

function card(palette: GalleryTheme, selected: boolean, isOrg: boolean, orgId: string | null): TemplateResult {
  return html`
    <button
      class="settings-palette-card ${selected ? "selected" : ""}"
      type="button"
      role="radio"
      aria-checked=${selected ? "true" : "false"}
      @click=${() => pickPalette(palette.id, orgId)}
    >
      ${preview(palette)}
      <span class="settings-palette-name">${palette.name}</span>
      ${isOrg ? html`<span class="settings-palette-tag">Org default</span>` : nothing}
    </button>
  `;
}

export function paletteRow(): TemplateResult | typeof nothing {
  const themes = galleryThemes(document);
  if (!themes.length) return nothing;
  const orgId = orgThemeId(document, themes);
  const imported = storedTheme() === "custom" && storedCustomTheme() !== null;
  const picked = storedPalette();
  const hasPick = themes.some((theme) => theme.id === picked);
  const shownId = hasPick ? picked : orgId;
  const selectedId = imported ? null : shownId;
  return html`
    <div class="settings-row settings-palette">
      <div class="settings-row-copy">
        <div class="settings-row-title">Colors</div>
        <div class="settings-row-note">
          Each palette has a light and a dark version. Your choice stays in this browser.
        </div>
        ${
          imported
            ? html`
                <div class="settings-row-note">An imported theme file is in use; picking a palette replaces it.</div>
              `
            : nothing
        }
        ${
          !imported && hasPick && orgId === null
            ? html`<button class="settings-theme-link" type="button" @click=${followOrganization}>
                Use the organization's colors
              </button>`
            : nothing
        }
      </div>
      <div class="settings-palette-cards" role="radiogroup" aria-label="Colors">
        ${themes.map((theme) => card(theme, theme.id === selectedId, theme.id === orgId, orgId))}
      </div>
    </div>
  `;
}
