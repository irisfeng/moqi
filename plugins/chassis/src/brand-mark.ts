const BRAND_MARK_GEOMETRY = {
  viewBox: "0 0 64 64",
  background: "#181d23",
  outerPath: "M43 18.5a18 18 0 1 0 0 27",
  outerStroke: "#f7f8f9",
  outerStrokeWidth: "7.5",
  checkPath: "m24.5 32.5 5.5 5.5 11.5-12",
  checkStroke: "#4f7fff",
  checkStrokeWidth: "5",
} as const;

export const BRAND_MARK_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${BRAND_MARK_GEOMETRY.viewBox}"><rect width="64" height="64" rx="16" fill="${BRAND_MARK_GEOMETRY.background}"/><path d="${BRAND_MARK_GEOMETRY.outerPath}" fill="none" stroke="${BRAND_MARK_GEOMETRY.outerStroke}" stroke-linecap="round" stroke-width="${BRAND_MARK_GEOMETRY.outerStrokeWidth}"/><path d="${BRAND_MARK_GEOMETRY.checkPath}" fill="none" stroke="${BRAND_MARK_GEOMETRY.checkStroke}" stroke-linecap="round" stroke-linejoin="round" stroke-width="${BRAND_MARK_GEOMETRY.checkStrokeWidth}"/></svg>`;
