// How the board's frame shares the window: the sidebar, a docked task panel, and the board's
// columns. Pure numbers, so the tests can check them; app.css keeps the same widths.

/** The sidebar's width in px, open (icons and labels) or as a rail (icons): --sidebar-w and --rail-w. */
export const SIDEBAR_WIDTH = { open: 236, rail: 68 };
/** The narrowest a board column gets before the board shows one column at a time instead. */
export const MIN_COLUMN = 108;
/** The gap between board columns (.board-head and .lane-row in app.css). */
export const COLUMN_GAP = 8;
const PANEL_WIDTH = 460; // --panel-w
const VIEW_MIN = 600; // the least room a docked task leaves the view beside it

/** The sidebar until this browser chooses: open where there's room, icons only where there isn't. */
export function sidebarDefault(windowWidth) {
  return windowWidth >= 1280 ? 'open' : 'rail';
}

/** Whether `columns` columns fit side by side in `width` px, none narrower than MIN_COLUMN. */
export function boardFits(width, columns) {
  return width >= columns * MIN_COLUMN + (columns - 1) * COLUMN_GAP;
}

/** The window width from which a task docks beside the view (narrower, it opens as a sheet). */
export function dockFrom(sidebar) {
  return SIDEBAR_WIDTH[sidebar] + VIEW_MIN + PANEL_WIDTH;
}
