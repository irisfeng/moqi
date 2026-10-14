import { html, render } from "lit";
import { ExternalLink } from "lucide";
import { appState } from "./shell-state";
import { icon } from "./ui";

type EmbeddedView = "docs" | "pm";

const EMBEDS: Record<EmbeddedView, { root: string; title: string; subtitle: string }> = {
  docs: {
    root: "/docs/",
    title: "Department docs",
    subtitle: "Shared document library, filed by department",
  },
  pm: {
    root: "/pm/",
    title: "Project management",
    subtitle: "Project materials, department access and completeness checks",
  },
};

const hosts = new Map<EmbeddedView, HTMLDivElement>();
const paths = new Map<EmbeddedView, string>();

function onFrameLoad(view: EmbeddedView, e: Event): void {
  const frame = e.target as HTMLIFrameElement;
  try {
    const p = frame.contentWindow?.location.pathname;
    if (p && p.startsWith(EMBEDS[view].root)) paths.set(view, p);
    const want = document.documentElement.classList.contains("dark");
    const got = frame.contentDocument?.documentElement.classList.contains("dark");
    if (typeof got === "boolean" && got !== want) frame.setAttribute("src", frame.src);
  } catch {
    void 0;
  }
}

export function renderEmbeddedView(view: EmbeddedView): void {
  if (appState.currentView !== view || !appState.mainEl) return;
  const embed = EMBEDS[view];
  let host = hosts.get(view);
  if (!host || host.parentElement !== appState.mainEl) {
    host = document.createElement("div");
    host.className = "pane docs-page";
    hosts.set(view, host);
    appState.mainEl.replaceChildren(host);
  }
  render(
    html`
      <div class="list-page-head">
        <div>
          <h1 class="pane-title">${embed.title}</h1>
          <div class="pane-subtitle">${embed.subtitle}</div>
        </div>
        <div class="list-page-actions">
          <a class="btn" href=${embed.root} target="_blank" rel="noopener">
            ${icon(ExternalLink, 15)}<span>Open in new tab</span>
          </a>
        </div>
      </div>
      <iframe
        class="docs-frame"
        src=${paths.get(view) ?? embed.root}
        title=${embed.title}
        @load=${(e: Event) => onFrameLoad(view, e)}
      ></iframe>
    `,
    host,
  );
}
