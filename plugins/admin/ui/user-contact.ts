import { html } from "lit";
import { card } from "./shared.ts";

type Contact = { email: string | null; phone: string | null };

export function contactCard(principal: string, s: Record<string, any>, redraw: () => void) {
  const path = "/api/users/" + encodeURIComponent(principal) + "/contact";
  let contact: Contact | null = null;
  let phone = "";
  let note = "Loading…";
  let hint = "";
  let busy = false;
  async function load() {
    const result = await s.api("GET", path);
    contact = result.ok ? { email: result.data?.email ?? null, phone: result.data?.phone ?? null } : null;
    phone = contact?.phone ?? "";
    note = contact ? "" : result.data?.message || "Failed (" + result.status + ").";
    redraw();
  }
  async function save() {
    if (busy) return;
    busy = true;
    hint = "Saving…";
    redraw();
    const result = await s.api("PUT", path, { phone });
    if (result.ok) {
      contact = { email: result.data?.email ?? null, phone: result.data?.phone ?? null };
      phone = contact.phone ?? "";
      hint = contact.phone ? "Saved. Colleagues see it in the Directory." : "Phone number removed.";
    } else {
      hint = result.data?.message || "Failed (" + result.status + ").";
    }
    busy = false;
    redraw();
  }
  void load();
  return () =>
    card(
      "Contact",
      "Shown to every colleague in the Directory, where a click copies it. The email is the sign-in and can't be changed here.",
      contact
        ? html`<div class="grant-form">
              <div class="f grow">
                <label>Email</label>
                <div>${contact.email ?? "—"}</div>
              </div>
              <div class="f grow">
                <label for="contact-phone">Phone</label>
                <input
                  id="contact-phone"
                  type="tel"
                  maxlength="32"
                  ?disabled=${busy}
                  placeholder="For example: 0123-0123 4567 转 806"
                  .value=${phone}
                  @input=${(e: Event) => {
                    phone = (e.target as HTMLInputElement).value;
                  }}
                  @keydown=${(e: KeyboardEvent) => {
                    if (e.key === "Enter" && !e.isComposing && e.keyCode !== 229) void save();
                  }}
                />
              </div>
              <button type="button" class="primary" ?disabled=${busy} @click=${save}>Save</button>
            </div>
            <p class="hint">${hint}</p>`
        : html`<p class="hint">${note}</p>`,
    );
}
