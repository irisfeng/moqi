const BRAND_MARK_GEOMETRY = {
  viewBox: "0 0 100 100",
  leftPath: "M23 0H39V49H55V100H23A23 23 0 0 1 0 77V23A23 23 0 0 1 23 0Z",
  rightPath: "M45 0H77A23 23 0 0 1 100 23V77A23 23 0 0 1 77 100H61V43H45Z",
  light: { left: "#1f2328", right: "#1c6a8a" },
  dark: { left: "#ecebe6", right: "#6bb6d3" },
} as const;

const { light, dark } = BRAND_MARK_GEOMETRY;

export const BRAND_MARK_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${BRAND_MARK_GEOMETRY.viewBox}"><style>.l{fill:${light.left}}.r{fill:${light.right}}@media (prefers-color-scheme:dark){.l{fill:${dark.left}}.r{fill:${dark.right}}}</style><path class="l" d="${BRAND_MARK_GEOMETRY.leftPath}"/><path class="r" d="${BRAND_MARK_GEOMETRY.rightPath}"/></svg>`;
