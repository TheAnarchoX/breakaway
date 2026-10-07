// Pan and zoom for an SVG drawing (WEB-97): pure helpers over a viewBox, so the console's map (and any other drawing,
// like the graph) can fill its box, zoom about a point, and pan, without leaving what it draws. Everything is in the
// drawing's own units; a component turns the pointer's pixels into them.

/** @typedef {{ x: number, y: number, w: number, h: number }} View a viewBox: its corner, width, and height */

/** How far in a drawing zooms past fitting it. */
export const ZOOM_MAX = 4;
/** How much one step of the buttons or the wheel zooms. */
export const ZOOM_STEP = 1.25;

/**
 * The view that shows all of `bounds` in a box of `box` pixels, centred, no larger than `maxScale` pixels to a unit,
 * with the box's own shape, so the drawing fills it edge to edge and anything around it is the same canvas.
 * @param {View} bounds what's drawn
 * @param {{ w: number, h: number } | null} box the element's size in pixels, or null before it's measured
 * @param {number} [maxScale]
 * @returns {View}
 */
export function fitView(bounds, box, maxScale = 1.4) {
  if (!box || box.w <= 0 || box.h <= 0) return { ...bounds };
  const scale = Math.min(box.w / bounds.w, box.h / bounds.h, maxScale);
  const w = box.w / scale;
  const h = box.h / scale;
  return { x: bounds.x + (bounds.w - w) / 2, y: bounds.y + (bounds.h - h) / 2, w, h };
}

/**
 * `view` kept inside `fit`: never wider than it (zoomed out past fitting), never narrower than `fit.w / max`, and never
 * panned off it.
 * @param {View} view
 * @param {View} fit
 * @param {number} [max]
 * @returns {View}
 */
export function clampView(view, fit, max = ZOOM_MAX) {
  const ratio = fit.h / fit.w;
  const w = Math.min(fit.w, Math.max(fit.w / max, view.w));
  const h = w * ratio;
  const x = Math.min(fit.x + fit.w - w, Math.max(fit.x, view.x));
  const y = Math.min(fit.y + fit.h - h, Math.max(fit.y, view.y));
  return { x, y, w, h };
}

/**
 * Zoom by `factor` (over 1 zooms in) about `at`, a point in the drawing's units that stays where it is on screen; the
 * view's centre when there's none.
 * @param {View} view
 * @param {number} factor
 * @param {{ x: number, y: number } | null} at
 * @param {View} fit
 * @param {number} [max]
 * @returns {View}
 */
export function zoomView(view, factor, at, fit, max = ZOOM_MAX) {
  const p = at ?? { x: view.x + view.w / 2, y: view.y + view.h / 2 };
  const next = clampView({ ...view, w: view.w / factor, h: view.h / factor }, fit, max);
  const k = next.w / view.w;
  return clampView({ ...next, x: p.x - (p.x - view.x) * k, y: p.y - (p.y - view.y) * k }, fit, max);
}

/**
 * Pan by `dx`, `dy` in the drawing's units: what's drawn moves with the pointer, so the view moves the other way.
 * @param {View} view
 * @param {number} dx
 * @param {number} dy
 * @param {View} fit
 * @param {number} [max]
 * @returns {View}
 */
export function panView(view, dx, dy, fit, max = ZOOM_MAX) {
  return clampView({ ...view, x: view.x - dx, y: view.y - dy }, fit, max);
}

/**
 * How far in the view is, where fitting is 1.
 * @param {View} view
 * @param {View} fit
 */
export const zoomOf = (view, fit) => fit.w / view.w;

/** A view as an SVG `viewBox`. */
export const viewBox = (/** @type {View} */ v) => `${v.x} ${v.y} ${v.w} ${v.h}`;
