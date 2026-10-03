import { describe, expect, it } from 'vitest';
import { COLUMN_GAP, MIN_COLUMN, SIDEBAR_WIDTH, boardFits, dockFrom, sidebarDefault } from '../web/src/lib/layout.js';

describe('the board never scrolls sideways', () => {
  it('shows every column while each is at least the narrowest a card reads at', () => {
    const exact = 6 * MIN_COLUMN + 5 * COLUMN_GAP;
    expect(boardFits(exact, 6)).toBe(true);
    expect(boardFits(exact - 1, 6)).toBe(false);
  });

  it('fits all six columns beside a collapsed sidebar on an 800 px window', () => {
    const board = 800 - SIDEBAR_WIDTH.rail - 2 * 16; // the main area's padding
    expect(boardFits(board, 6)).toBe(true);
  });

  it('fits all six columns beside the open sidebar and a docked task on a 1440 px window', () => {
    const board = 1440 - SIDEBAR_WIDTH.open - 460 - 2 * 16;
    expect(boardFits(board, 6)).toBe(true);
  });

  it('falls back to one column with a picker on a phone', () => {
    expect(boardFits(390 - 2 * 12, 6)).toBe(false);
  });
});

describe('where a task opens', () => {
  it('docks beside the view only when the view keeps room next to the sidebar', () => {
    expect(dockFrom('rail')).toBeLessThan(dockFrom('open'));
    expect(dockFrom('rail')).toBe(SIDEBAR_WIDTH.rail + 600 + 460);
    expect(dockFrom('open')).toBe(SIDEBAR_WIDTH.open + 600 + 460);
  });
});

describe('the sidebar', () => {
  it('starts open on a wide window and as icons on a narrower one, until this browser chooses', () => {
    expect(sidebarDefault(1440)).toBe('open');
    expect(sidebarDefault(1280)).toBe('open');
    expect(sidebarDefault(1279)).toBe('rail');
    expect(sidebarDefault(900)).toBe('rail');
  });
});
