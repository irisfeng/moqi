const TRANSCRIPT_BOTTOM_THRESHOLD = 120;

export function createTranscriptNavigation(onLatest: () => void) {
  let cleanup = () => {};
  let currentScroller: HTMLElement | null = null;
  let currentButton: HTMLButtonElement | null = null;
  let currentStack: Element | null = null;
  let refresh = () => {};

  function disconnect() {
    cleanup();
    cleanup = () => {};
    currentScroller = null;
    currentButton = null;
    currentStack = null;
    refresh = () => {};
  }

  function sync(host: HTMLElement) {
    const scroller = host.querySelector<HTMLElement>(".chat-scroll");
    const button = host.querySelector<HTMLButtonElement>(".chat-latest-button");
    const stack = scroller?.querySelector(".message-stack") ?? null;
    if (scroller === currentScroller && button === currentButton && stack === currentStack) {
      refresh();
      return;
    }
    disconnect();
    if (!scroller || !button) return;
    currentScroller = scroller;
    currentButton = button;
    currentStack = stack;
    const update = () => {
      const shell = button.closest<HTMLElement>(".custom-chat-shell");
      if (shell)
        button.style.top = `${scroller.getBoundingClientRect().bottom - shell.getBoundingClientRect().top - 12}px`;
      button.hidden = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight <= TRANSCRIPT_BOTTOM_THRESHOLD;
    };
    const latest = () => {
      onLatest();
      const behavior = scroller.style.scrollBehavior;
      scroller.style.scrollBehavior = "auto";
      scroller.scrollTop = scroller.scrollHeight;
      scroller.style.scrollBehavior = behavior;
      update();
    };
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(update);
    observer?.observe(scroller);
    if (stack) observer?.observe(stack);
    scroller.addEventListener("scroll", update, { passive: true });
    button.addEventListener("click", latest);
    const frame = requestAnimationFrame(update);
    refresh = update;
    cleanup = () => {
      cancelAnimationFrame(frame);
      observer?.disconnect();
      scroller.removeEventListener("scroll", update);
      button.removeEventListener("click", latest);
    };
  }

  return { sync, disconnect };
}
