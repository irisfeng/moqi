import { html, nothing } from "lit";
import { badge, card, renderer, table } from "./shared.ts";
import {
  ANNOUNCEMENT_LEVEL_LABELS,
  ANNOUNCEMENT_STATUS_META,
  announcementDraft,
  announcementStatus,
  defaultAnnouncementWindow,
  takedownEndsAt,
  toDatetimeLocalValue,
} from "./announcement-rules.ts";

export function announcements(root: HTMLElement, d: any, s: Record<string, any>) {
  const paint = renderer(root);
  const list: any[] = d.announcements || [];
  const now = Date.now();
  const active = list.filter((a) => announcementStatus(a, now) === "active").length;
  s.defaultShell({
    stats: [
      [String(active), "Active"],
      [String(list.length), "Announcements"],
    ],
  });
  const initial = defaultAnnouncementWindow();
  let editId: string | null = null;
  let level = "notice";
  let title = "";
  let body = "";
  let startsAt = initial.startsAt;
  let endsAt = initial.endsAt;
  let popup = false;
  let pending = false;
  let message = "";
  let tone = "";
  const say = (text: string, kind = "") => {
    message = text;
    tone = kind;
    draw();
  };
  const resetForm = () => {
    const w = defaultAnnouncementWindow();
    editId = null;
    level = "notice";
    title = "";
    body = "";
    startsAt = w.startsAt;
    endsAt = w.endsAt;
    popup = false;
    message = "";
    tone = "";
    draw();
  };
  const startEdit = (a: any) => {
    editId = a.id;
    level = a.level;
    title = a.title;
    body = a.body;
    startsAt = toDatetimeLocalValue(new Date(a.startsAt));
    endsAt = a.endsAt === null ? "" : toDatetimeLocalValue(new Date(a.endsAt));
    popup = a.popup === true;
    message = "";
    tone = "";
    draw();
    root.querySelector(".card")?.scrollIntoView({ block: "center" });
    (root.querySelector("#announcement-title") as HTMLInputElement | null)?.focus();
  };
  const failure = (r: any, fallback: string) =>
    r.status === 403 ? "Only organization admins can manage announcements." : r.data?.message || fallback;
  const submit = async () => {
    const draft = announcementDraft(level, title, body, startsAt, endsAt);
    if (draft.error) return say(draft.error, "err");
    const { error: _error, ...fields } = draft;
    const payload = { ...fields, popup };
    pending = true;
    say(editId ? "Saving…" : "Publishing…", "saving");
    const r = editId
      ? await s.api("PUT", "/api/announcements/" + encodeURIComponent(editId), payload)
      : await s.api("POST", "/api/announcements", payload);
    pending = false;
    if (!r.ok) return say(failure(r, editId ? "Save failed." : "Publish failed."), "err");
    s.reload();
  };
  const addImage = async (input: HTMLInputElement) => {
    const file = input.files?.[0];
    input.value = "";
    if (!file) return;
    pending = true;
    say("Uploading image…", "saving");
    try {
      const response = await fetch(s.apiBase + "/api/announcement-images", {
        method: "POST",
        headers: {
          "content-type": file.type || "application/octet-stream",
          "x-file-name": encodeURIComponent(file.name || "image"),
          "x-content-sha256": await s.fileSha256(file),
        },
        body: file,
      });
      const data = await response.json().catch(() => null);
      pending = false;
      if (!response.ok || typeof data?.url !== "string")
        return say(failure({ status: response.status, data }, "Image upload failed."), "err");
      body = body + (body && !body.endsWith("\n") ? "\n\n" : "") + "![](" + data.url + ")\n";
      say("Image added to the body.", "ok");
    } catch {
      pending = false;
      say("Image upload failed.", "err");
    }
  };
  const takeDown = async (a: any) => {
    if (
      !s.confirm(
        'Take down the announcement "' + s.firstLine(a.title, 60) + '"? Users will stop seeing it immediately.',
      )
    )
      return;
    const r = await s.api("PUT", "/api/announcements/" + encodeURIComponent(a.id), { endsAt: takedownEndsAt(a) });
    if (!r.ok) return say(failure(r, "Take down failed."), "err");
    s.reload();
  };
  const levelTones: Record<string, string> = { incident: "err", maintenance: "warn" };
  const levelBadge = (value: string) => badge(ANNOUNCEMENT_LEVEL_LABELS[value] || value, levelTones[value] ?? "muted");
  const stacked = (primary: string, secondary: string) => ({
    node: html`<div>
      <div class="primaryline">${primary}</div>
      ${secondary ? html`<div class="subline">${secondary}</div>` : nothing}
    </div>`,
  });
  const rowOf = (a: any) => {
    const status = announcementStatus(a, now);
    return [
      { node: levelBadge(a.level) },
      stacked(s.firstLine(a.title, 96), s.firstLine(a.body, 96)),
      s.fmtTime(a.startsAt),
      a.endsAt === null ? "No end" : s.fmtTime(a.endsAt),
      { node: badge(...ANNOUNCEMENT_STATUS_META[status]) },
      status === "ended" ? { text: "" } : { action: { label: "Take down", danger: true, run: () => takeDown(a) } },
      { action: { label: "Edit", run: () => startEdit(a) } },
    ];
  };
  function draw() {
    paint(
      html`<div class="list-root">
        ${card(
          "Publish announcement",
          "A broadcast to all users: it appears at the top of the user interface from its start time and disappears when it ends or is taken down, with no deploy needed.",
          html`<div class="grant-form">
              <div class="f">
                <label>Level</label>
                <div style="display:flex;align-items:center;gap:14px;flex-wrap:wrap">
                  ${Object.entries(ANNOUNCEMENT_LEVEL_LABELS).map(
                    ([value, text]) =>
                      html`<label
                        style="display:flex;align-items:center;gap:6px;cursor:pointer;margin:0;font-size:13px;font-weight:400;color:var(--text)"
                        ><input
                          type="radio"
                          name="announcement-level"
                          style="width:auto"
                          .value=${value}
                          .checked=${level === value}
                          @change=${() => {
                            level = value;
                          }}
                        />${text}</label
                      >`,
                  )}
                </div>
              </div>
              <div class="f grow">
                <label for="announcement-title">Title</label>
                <input
                  id="announcement-title"
                  type="text"
                  placeholder="For example: maintenance tonight 22:00-23:00"
                  maxlength="200"
                  .value=${title}
                  @input=${(e: Event) => {
                    title = (e.target as HTMLInputElement).value;
                  }}
                />
              </div>
              <div class="f">
                <label for="announcement-starts">Start time</label>
                <input
                  id="announcement-starts"
                  type="datetime-local"
                  .value=${startsAt}
                  @input=${(e: Event) => {
                    startsAt = (e.target as HTMLInputElement).value;
                  }}
                />
              </div>
              <div class="f">
                <label for="announcement-ends">End time</label>
                <input
                  id="announcement-ends"
                  type="datetime-local"
                  .value=${endsAt}
                  @input=${(e: Event) => {
                    endsAt = (e.target as HTMLInputElement).value;
                  }}
                />
              </div>
              <div class="f grow" style="flex-basis:100%">
                <label for="announcement-body">Body</label>
                <textarea
                  id="announcement-body"
                  placeholder="Body (Markdown supported). Explain what is happening and how it affects everyone."
                  maxlength="20000"
                  .value=${body}
                  @input=${(e: Event) => {
                    body = (e.target as HTMLTextAreaElement).value;
                  }}
                ></textarea>
              </div>
              <div class="f grow" style="flex-basis:100%">
                <label
                  style="display:flex;align-items:center;gap:6px;cursor:pointer;margin:0;font-size:13px;font-weight:400;color:var(--text)"
                  ><input
                    id="announcement-popup"
                    type="checkbox"
                    style="width:auto"
                    .checked=${popup}
                    @change=${(e: Event) => {
                      popup = (e.target as HTMLInputElement).checked;
                    }}
                  />Also show as a pop-up the first time each person opens the product</label
                >
              </div>
              <input
                id="announcement-image"
                type="file"
                accept="image/png,image/jpeg,image/webp"
                hidden
                @change=${(e: Event) => void addImage(e.target as HTMLInputElement)}
              />
              <button
                type="button"
                ?disabled=${pending}
                @click=${() => (root.querySelector("#announcement-image") as HTMLInputElement | null)?.click()}
              >
                Add image
              </button>
              <button type="button" class="primary" ?disabled=${pending} @click=${submit}>
                ${editId ? "Save changes" : "Publish announcement"}
              </button>
              <button type="button" class=${editId ? "" : "hidden"} @click=${resetForm}>Cancel edit</button>
            </div>
            <p class=${"status" + (tone ? " " + tone : "")} style="margin:10px 0 0">${message}</p>`,
        )}${card(
          "Announcement list",
          "Includes active and past announcements. Taking one down sets its end time to now.",
          table(["Level", "Title", "Start", "End", "Status", "", ""], list.map(rowOf), "No announcements yet."),
        )}
      </div>`,
    );
  }
  draw();
}
