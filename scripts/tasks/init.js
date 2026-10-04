/**
 * What `npx breakaway repos init <slug>` adds lives in src/init.js (BRK-132), so the board's Worker renders the same
 * files for an empty repository's first commit. The CLI and its tests import it from here.
 */
export * from '../../src/init.js';
