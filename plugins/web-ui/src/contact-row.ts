import { LitElement, html, nothing } from "lit";
import { ApiError, api } from "./core-bridge";
import { appState } from "./shell-state";

type Contact = { email: string | null; phone: string | null };

class ContactRow extends LitElement {
  static properties = {
    contact: { state: true },
    phone: { state: true },
    busy: { state: true },
    hint: { state: true },
    error: { state: true },
  };
  private contact: Contact | null = null;
  private phone = "";
  private busy = false;
  private hint = "";
  private error = "";

  protected createRenderRoot(): HTMLElement {
    return this;
  }

  connectedCallback(): void {
    super.connectedCallback();
    this.hidden = !this.contact;
    void this.load();
  }

  private async load(): Promise<void> {
    if (this.busy) return;
    try {
      this.show(await api<Contact>("/api/me/contact"));
    } catch {
      this.hidden = true;
    }
  }

  private show(contact: Contact): void {
    this.contact = { email: contact.email ?? null, phone: contact.phone ?? null };
    this.phone = this.contact.phone ?? "";
    this.hidden = false;
  }

  private async save(): Promise<void> {
    if (this.busy || !this.contact) return;
    this.busy = true;
    this.hint = "";
    this.error = "";
    try {
      this.show(await api<Contact>("/api/me/contact", { method: "PUT", body: JSON.stringify({ phone: this.phone }) }));
      this.hint = this.contact.phone ? "Saved. Colleagues see it in the Directory." : "Phone number removed.";
    } catch (error) {
      this.error =
        error instanceof ApiError && error.status === 400 ? error.message : "Couldn't save your phone number.";
    } finally {
      this.busy = false;
    }
  }

  protected render() {
    if (!this.contact) return nothing;
    const unchanged = this.phone.trim() === (this.contact.phone ?? "");
    const locked = this.busy || Boolean(appState.me?.impersonatedBy);
    return html`
      <div class="settings-row-copy">
        <div class="settings-row-title">Contact</div>
        <div class="settings-row-note">Colleagues see your email and phone in the Directory.</div>
        ${
          this.contact.email
            ? html`<div class="settings-row-note settings-contact-email">${this.contact.email}</div>`
            : nothing
        }
        ${this.error ? html`<div class="settings-row-error" role="alert">${this.error}</div>` : nothing}
        ${this.hint ? html`<div class="settings-row-note" role="status">${this.hint}</div>` : nothing}
      </div>
      <form
        class="settings-contact-form"
        @submit=${(event: SubmitEvent) => {
          event.preventDefault();
          void this.save();
        }}
      >
        <input
          class="skill-desc-input"
          type="tel"
          maxlength="32"
          autocomplete="tel"
          aria-label="Phone"
          placeholder="Phone, e.g. 0123-0123 4567 转 806"
          ?disabled=${locked}
          .value=${this.phone}
          @input=${(event: Event) => {
            this.phone = (event.target as HTMLInputElement).value;
            this.hint = "";
          }}
        />
        <button class="btn settings-row-action" type="submit" ?disabled=${locked || unchanged}>Save</button>
      </form>
    `;
  }
}

if (!customElements.get("qm-contact-row")) customElements.define("qm-contact-row", ContactRow);
