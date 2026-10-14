import { html, nothing, render } from "lit";
import { ChevronLeft, ChevronRight } from "lucide";
import { icon } from "./ui.ts";

export interface PreviewImage {
  src: string;
  name: string;
}

export function stepImage(index: number, count: number, delta: number): number {
  if (count <= 0) return 0;
  return (((index + delta) % count) + count) % count;
}

export function imagePosition(index: number, count: number): string {
  return `${index + 1} of ${count}`;
}

export function previewLinkedImage(link: HTMLAnchorElement, root: ParentNode | null | undefined): void {
  const found = [...(root ?? document).querySelectorAll<HTMLAnchorElement>("a.file-image")];
  const links = found.includes(link) ? found : [link];
  openImagePreview(
    links.map((a) => ({ src: a.href, name: a.querySelector("img")?.alt || a.href })),
    links.indexOf(link),
  );
}

export function openImagePreview(images: readonly PreviewImage[], start = 0): void {
  if (!images.length) return;
  let index = stepImage(start, images.length, 0);
  const dialog = document.createElement("dialog");
  dialog.className = "project-dialog attachment-preview";
  dialog.addEventListener(
    "close",
    () => {
      render(nothing, dialog);
      dialog.remove();
    },
    { once: true },
  );
  const step = (delta: number): void => {
    if (images.length < 2) return;
    index = stepImage(index, images.length, delta);
    draw();
  };
  dialog.addEventListener("keydown", (event) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    step(event.key === "ArrowLeft" ? -1 : 1);
  });
  function draw(): void {
    const image = images[index]!;
    dialog.setAttribute("aria-label", image.name);
    render(
      html`
        <div class="attachment-preview-head">
          <span dir="auto">${image.name}</span>
          ${
            images.length > 1
              ? html`<span class="attachment-preview-position" aria-live="polite"
                  >${imagePosition(index, images.length)}</span
                >`
              : nothing
          }
          <button type="button" class="btn compact" @click=${() => dialog.close()}>Close</button>
        </div>
        <div class="attachment-preview-stage">
          ${
            images.length > 1
              ? html`<button
                  type="button"
                  class="attachment-preview-step"
                  aria-label="Previous image"
                  @click=${() => step(-1)}
                >
                  ${icon(ChevronLeft, 18)}
                </button>`
              : nothing
          }
          <div class="attachment-preview-body">
            <button
              type="button"
              aria-label="Toggle actual image size"
              @click=${(event: Event) => (event.currentTarget as HTMLElement).classList.toggle("actual-size")}
            >
              <img src=${image.src} alt=${image.name} />
            </button>
          </div>
          ${
            images.length > 1
              ? html`<button
                  type="button"
                  class="attachment-preview-step"
                  aria-label="Next image"
                  @click=${() => step(1)}
                >
                  ${icon(ChevronRight, 18)}
                </button>`
              : nothing
          }
        </div>
      `,
      dialog,
    );
  }
  document.body.append(dialog);
  draw();
  dialog.showModal();
}
