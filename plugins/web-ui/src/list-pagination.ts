import { html, nothing, type TemplateResult } from "lit";
import { fieldSelect } from "./ui";

export function createListPagination() {
  let page = 1;
  let size = 20;
  let filter = "";
  return function paginate<T>(
    items: T[],
    key: string,
    draw: () => void,
    options: { more?: boolean; loading?: boolean; next?: () => Promise<boolean | void> } = {},
  ) {
    if (filter !== key) {
      filter = key;
      page = 1;
    }
    const pages = Math.max(1, Math.ceil(items.length / size));
    if (!options.loading) page = Math.min(page, pages);
    const change = async (target: number) => {
      if (options.loading) return;
      if (options.more && target * size > items.length && (await options.next?.()) === false) return;
      if (filter !== key) return;
      page = Math.max(1, target);
      draw();
      requestAnimationFrame(() => document.querySelector(".pane .list-pagination")?.scrollIntoView({ block: "start" }));
    };
    const start = (page - 1) * size;
    const range = items.length ? `${start + 1}–${Math.min(start + size, items.length)}` : "0";
    const total = options.more ? `${items.length} loaded, more load on demand` : `${items.length} in total`;
    const position = options.more ? `Page ${page}` : `Page ${page} of ${pages}`;
    const controls = html`<nav class="list-pagination" aria-label="List pages">
      <span class="list-pagination-count" aria-live="polite">${range} · ${total}</span>
      <div class="list-pagination-actions">
        ${fieldSelect({
          compact: true,
          ariaLabel: "Items per page",
          value: String(size),
          disabled: options.loading,
          options: [html`<option value="20">20 per page</option>`, html`<option value="50">50 per page</option>`],
          onChange: (value) => {
            size = Number(value);
            page = 1;
            draw();
          },
        })}
        <button
          type="button"
          class="btn compact"
          ?disabled=${page <= 1 || options.loading}
          @click=${() => void change(page - 1)}
        >
          Previous
        </button>
        <span>${position}</span>
        <button
          type="button"
          class="btn compact"
          ?disabled=${options.loading || (page >= pages && !options.more)}
          @click=${() => void change(page + 1)}
        >
          ${options.loading ? "Loading…" : "Next"}
        </button>
      </div>
    </nav>`;
    return {
      rows: items.slice(start, start + size),
      controls: (items.length || options.loading || options.more ? controls : nothing) as
        TemplateResult | typeof nothing,
    };
  };
}
