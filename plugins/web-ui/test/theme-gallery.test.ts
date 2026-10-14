import assert from "node:assert/strict";
import test from "node:test";
import { galleryCss, galleryThemes, orgThemeId, type GalleryTheme } from "../src/theme-gallery.ts";

const paper: GalleryTheme = {
  id: "paper",
  name: "素白",
  light: { background: "#ffffff", foreground: "#1b1d21", cta: "#1c6a8a" },
  dark: { background: "#161719", foreground: "#ececed", cta: "#1f6f8f" },
};
const mist: GalleryTheme = {
  id: "mist",
  name: "雾蓝",
  light: { background: "#f5f7fa", foreground: "#1a2230", cta: "#1c6a8a" },
  dark: { background: "#101419", foreground: "#e8ecf2", cta: "#2a7ca0" },
};

function page(themes: unknown, styles: string[] = []): Document {
  return {
    getElementById: (id: string) => (id === "coworker-themes" && themes !== undefined ? { textContent: themes } : null),
    head: { querySelectorAll: () => styles.map((textContent) => ({ textContent })) },
  } as unknown as Document;
}

test("themes are read in order and a palette with a bad colour is dropped", () => {
  const bad = { ...mist, id: "bad", light: { ...mist.light, cta: "teal" } };
  const themes = galleryThemes(page(JSON.stringify({ themes: [paper, bad, mist] })));
  assert.deepEqual(
    themes.map((theme) => theme.id),
    ["paper", "mist"],
  );
  assert.deepEqual(themes[0], paper);
});

test("a palette with a bad id, name, token, missing half or repeated id is dropped", () => {
  const list = [
    { ...paper, id: "Paper" },
    { ...paper, id: "long", name: "一二三四五六七八九十一二三" },
    { ...paper, id: "noname", name: "" },
    { ...paper, id: "token", light: { Background: "#ffffff" } },
    { ...paper, id: "nodark", dark: undefined },
    paper,
    { ...mist, id: "paper" },
  ];
  const themes = galleryThemes(page(JSON.stringify({ themes: list })));
  assert.deepEqual(
    themes.map((theme) => theme.id),
    ["paper"],
  );
  assert.equal(themes[0].name, "素白");
});

test("a missing or broken block gives no palettes", () => {
  assert.deepEqual(galleryThemes(page(undefined)), []);
  assert.deepEqual(galleryThemes(page("{not json")), []);
  assert.deepEqual(galleryThemes(page(JSON.stringify({ themes: "paper" }))), []);
  assert.deepEqual(galleryThemes(page(JSON.stringify({}))), []);
});

test("the stylesheet scopes each half under html:root so it outranks the organisation theme", () => {
  assert.equal(
    galleryCss(paper),
    "html:root:not(.dark){--background:#ffffff;--foreground:#1b1d21;--cta:#1c6a8a}" +
      "html:root.dark{--background:#161719;--foreground:#ececed;--cta:#1f6f8f}",
  );
});

test("the organisation theme is recognised by its background, foreground and cta, ignoring case", () => {
  const org =
    "html:not(.dark){--background:#F5F7FA;--foreground:#1a2230;--card:#fff;--cta:#1C6A8A}html.dark{--background:#000}";
  assert.equal(orgThemeId(page("", ["body{margin:0}", org]), [paper, mist]), "mist");
});

test("an organisation theme that matches no palette, or none at all, gives null", () => {
  const near = "html:not(.dark){--background:#f5f7fa;--foreground:#1a2230;--cta:#123456}";
  assert.equal(orgThemeId(page("", [near]), [paper, mist]), null);
  const partial = "html:not(.dark){--background:#ffffff;--foreground:#1b1d21}";
  assert.equal(orgThemeId(page("", [partial]), [paper, mist]), null);
  assert.equal(orgThemeId(page("", ["html.dark{--background:#ffffff}"]), [paper, mist]), null);
  assert.equal(orgThemeId(page("", []), [paper, mist]), null);
});
