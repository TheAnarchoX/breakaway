import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { hookCommand, sessionHooks } from './init.js';
import { checkoutRunsHooks } from './plugin-hooks.js';

const ROOT = '/work/widgets';
const plugin = { CLAUDE_PLUGIN_ROOT: '/home/me/.claude/plugins/breakaway' };
const reading = (files) => (path) => files[path] ?? null;
const settings = (text) => reading({ [join(ROOT, '.claude', 'settings.json')]: text });

describe('the plugin’s hooks beside a checkout’s own (BRK-159)', () => {
  it('step aside when the checkout’s settings run the board’s hooks, in any form', () => {
    expect(checkoutRunsHooks(ROOT, plugin, settings(JSON.stringify({ hooks: sessionHooks() })))).toBe(true);
    expect(checkoutRunsHooks(ROOT, plugin, settings('"npx --yes breakaway@next hook wait"'))).toBe(true);
    expect(checkoutRunsHooks(ROOT, plugin, settings(JSON.stringify(hookCommand('session', { fromCopy: true }))))).toBe(
      true,
    );
    const local = reading({ [join(ROOT, '.claude', 'settings.local.json')]: hookCommand('session') });
    expect(checkoutRunsHooks(ROOT, plugin, local)).toBe(true);
  });

  it('run when the checkout has the plugin instead, or no settings', () => {
    const plugged = JSON.stringify({ enabledPlugins: { 'breakaway@breakaway': true }, hooks: { Stop: [] } });
    expect(checkoutRunsHooks(ROOT, plugin, settings(plugged))).toBe(false);
    expect(checkoutRunsHooks(ROOT, plugin, reading({}))).toBe(false);
  });

  it('never stop the checkout’s own hooks', () => {
    expect(checkoutRunsHooks(ROOT, {}, settings(JSON.stringify({ hooks: sessionHooks() })))).toBe(false);
  });
});
