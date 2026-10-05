/**
 * The number the board's CLI and the files repos init copies were versioned by (CLD-193), frozen by BRK-148: never
 * change it. The board still sends it (every API answer's X-Tasks-Cli header, and `cli` in health), so an old copy of
 * the CLI in another repository says how to switch to npx. What a checkout compares now is the board's release (the
 * X-Tasks-Release header): pull requests no longer bump anything when a copied file changes.
 */
export const CLI_VERSION = 73;
