export function observeMobileViewport(): () => void {
  const viewport = window.visualViewport;
  const narrow = window.matchMedia("(max-width: 860px)");
  const root = document.documentElement;
  const update = () => {
    if (!narrow.matches || !viewport || viewport.scale !== 1) {
      root.style.removeProperty("--mobile-viewport-height");
      root.style.removeProperty("--mobile-viewport-top");
      return;
    }
    root.style.setProperty("--mobile-viewport-height", `${viewport.height}px`);
    root.style.setProperty("--mobile-viewport-top", `${viewport.offsetTop}px`);
  };
  viewport?.addEventListener("resize", update);
  viewport?.addEventListener("scroll", update);
  narrow.addEventListener("change", update);
  update();
  return () => {
    viewport?.removeEventListener("resize", update);
    viewport?.removeEventListener("scroll", update);
    narrow.removeEventListener("change", update);
    root.style.removeProperty("--mobile-viewport-height");
    root.style.removeProperty("--mobile-viewport-top");
  };
}
