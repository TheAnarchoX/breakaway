/**
 * The version of the board's CLI and the files repos init copies with it (CLD-193). The board reports it
 * (every API answer's X-Tasks-Cli header, and health), so a copy in another repository can say it's older
 * and how to update it. scripts/tasks/version.test.js fails when the copied files change and this doesn't:
 * bump CLI_VERSION and set CLI_FINGERPRINT to the value it prints. Constants only: the board's Worker imports it,
 * so it lives in the board's package (CLD-135) and the CLI imports it from here.
 */
export const CLI_VERSION = 38;
export const CLI_FINGERPRINT = 'e5cf577cb5354653';
