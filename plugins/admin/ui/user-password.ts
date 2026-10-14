import { html } from "lit";
import { badge, card } from "./shared.ts";

type PasswordState = { version: string; forceChange: boolean; locked: boolean };

function statusBadge(state: PasswordState) {
  if (state.locked) return badge("locked after failed sign-ins", "warn");
  if (state.forceChange) return badge("initial password, change due at sign-in", "info");
  return badge("chosen by the person", "ok");
}

export function passwordCard(principal: string, s: Record<string, any>, redraw: () => void) {
  const path = "/api/users/" + encodeURIComponent(principal);
  let state: PasswordState | null = null;
  let note = "Loading…";
  let hint = "";
  let busy = false;
  let operation = "";
  async function load() {
    const result = await s.api("GET", path + "/password");
    state = result.ok && typeof result.data?.version === "string" ? result.data : null;
    note = state ? "" : result.data?.message || "Failed (" + result.status + ").";
    redraw();
  }
  async function reset() {
    if (
      !state ||
      !s.confirm(
        "Restore this person's initial password?\n\nThey are signed out on every device. They sign in with the initial password they were first given and must then choose a new one.",
      )
    )
      return;
    busy = true;
    hint = "Resetting…";
    redraw();
    operation ||= crypto.randomUUID();
    const result = await s.api("POST", path + "/password-reset", { version: state.version, operationId: operation });
    if (result.status !== 0) operation = "";
    hint = result.ok
      ? "Done. They sign in with their initial password and choose a new one."
      : result.data?.message || "Failed (" + result.status + ").";
    await load();
    busy = false;
    redraw();
  }
  void load();
  return () =>
    card(
      "Password",
      "Restore the initial password this person was first given. They are signed out on every device and must choose a new password at their next sign-in. No password is shown or sent.",
      state
        ? html`<div>
            <div class="obstatus">Current status: ${statusBadge(state)}</div>
            <button type="button" class="danger-link" ?disabled=${busy} @click=${reset}>
              Restore initial password →
            </button>
            <p class="hint">${hint}</p>
          </div>`
        : html`<p class="hint">${note}</p>
            <p class="hint">${hint}</p>`,
    );
}
