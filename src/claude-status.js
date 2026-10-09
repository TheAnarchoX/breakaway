/**
 * Claude's status page (BRK-315): what status.claude.com says about the parts of Claude the board's agents run on.
 * While one of them is down, sessions fail to start or die mid-work, so a chase starts no new agents. Pure, so it's
 * tested on its own; the store fetches the page (store-claude-status.js).
 */
import { readStatusPage } from './github-status.js';

/** Claude's status page, a Statuspage site with its JSON at /api/v2/summary.json. */
export const CLAUDE_STATUS_URL = 'https://status.claude.com';

/** The components agents run on: claude.ai holds the sessions, the API fires the routines, and Claude Code runs them. */
export const CLAUDE_WATCHED = ['claude.ai', 'Claude API (api.anthropic.com)', 'Claude Code'];

/**
 * Claude's status page, read for the components the board's agents run on.
 * @param {any} summary
 */
export const readClaudeStatus = (summary) => readStatusPage(summary, CLAUDE_WATCHED);
