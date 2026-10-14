import { brandName } from "./brand-name.ts";
export const COMPACT_WORKSPACE_QUERY =
  "(max-width: 860px), (max-width: 1100px) and (max-height: 600px), (max-width: 1100px) and (pointer: coarse)";

export function preferLandscape(): boolean {
  const screen = window.screen;
  const touch = window.matchMedia("(pointer: coarse)").matches;
  if (touch && screen.width > 0 && screen.height > 0) {
    if (Math.min(screen.width, screen.height) > 600) return false;
    if (screen.orientation?.type) return screen.orientation.type.startsWith("portrait");
    if (typeof window.orientation === "number") return Math.abs(window.orientation) % 180 === 0;
    return screen.height > screen.width;
  }
  return window.innerWidth <= 600 && window.innerHeight > window.innerWidth;
}

export function observeMobileWorkspace(): () => void {
  const app = document.getElementById("app");
  if (!app) return () => {};
  const dialog = document.createElement("dialog");
  dialog.className = "orientation-dialog";
  dialog.setAttribute("aria-labelledby", "orientation-title");
  dialog.setAttribute("aria-describedby", "orientation-description");
  dialog.innerHTML = `<div class="orientation-rotate-icon" aria-hidden="true">↻</div>
    <h2 id="orientation-title">Use ${brandName()} in landscape</h2>
    <p id="orientation-description">Landscape gives text, tables and controls more room. Rotate your phone; if it does not switch, turn off the system portrait lock.</p>
    <p class="orientation-note">Rotating does not reload the page, and your current draft is kept.</p>
    <button type="button" class="btn">Use portrait for now</button>`;
  document.body.append(dialog);
  let dismissed = false;
  const dismiss = () => {
    dismissed = true;
    dialog.close();
  };
  dialog.querySelector("button")?.addEventListener("click", dismiss);
  dialog.addEventListener("cancel", dismiss);
  const update = () => {
    const portrait = preferLandscape();
    if (!portrait || !app.querySelector(".layout") || dismissed) {
      if (dialog.open) dialog.close();
      return;
    }
    const otherDialog = [...document.querySelectorAll<HTMLElement>('dialog[open], [role="dialog"]')].some(
      (element) =>
        element !== dialog &&
        !element.closest('[hidden], [aria-hidden="true"]') &&
        window.getComputedStyle(element).display !== "none" &&
        window.getComputedStyle(element).visibility !== "hidden",
    );
    if (otherDialog) {
      if (dialog.open) dialog.close();
      return;
    }
    if (!dialog.open) dialog.showModal();
  };
  const observer = new MutationObserver(update);
  observer.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["open", "hidden", "aria-hidden"],
  });
  window.addEventListener("resize", update);
  window.screen.orientation?.addEventListener("change", update);
  update();
  return () => {
    observer.disconnect();
    window.removeEventListener("resize", update);
    window.screen.orientation?.removeEventListener("change", update);
    dialog.remove();
  };
}
