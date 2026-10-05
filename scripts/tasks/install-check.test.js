import { describe, expect, it } from 'vitest';
import { parseInstall } from '../../src/install.js';
import { checkInstall, confirmInstall, tokenTarget, unverifiedInstall } from './install-check.js';

const STORE = 'a'.repeat(32);
const where = { command: 'rotate-token', configFile: '~/work/breakaway/breakaway.config.json' };
/** The board an owner of acme runs, as its health reports it. */
const ACME = { worker: 'acme-board', secretsPrefix: 'ACME_', secretsStore: STORE, installRepository: 'acme/board' };
const acmeConfig = parseInstall({ worker: 'acme-board', secretsPrefix: 'ACME_', secretsStore: STORE });

describe('the owner’s commands that write secrets check the install (BRK-95)', () => {
  it('lets the board’s own config through', () => {
    expect(checkInstall(acmeConfig, ACME, where)).toEqual({ ok: true });
    // A new install's: Worker secrets on the Worker breakaway, as the template has it.
    const fresh = { worker: 'breakaway', secretsPrefix: 'BREAKAWAY_', secretsStore: null, installRepository: null };
    expect(checkInstall(parseInstall({}), fresh, where)).toEqual({ ok: true });
  });

  it('stops before writing in a checkout whose config is the template’s, and says where to run it', () => {
    const result = checkInstall(parseInstall({}), ACME, where);
    expect(result.ok).toBe(false);
    const { message } = /** @type {{ message: string }} */ (result);
    expect(message).toContain("~/work/breakaway/breakaway.config.json isn't this board's install");
    expect(message).toContain('the Worker breakaway, secrets named BREAKAWAY_…, Worker secrets, no Secrets Store');
    expect(message).toContain(`the board is the Worker acme-board, secrets named ACME_…, the Secrets Store ${STORE}`);
    expect(message).toContain('Nothing was written.');
    expect(message).toContain('Run npx breakaway rotate-token from a checkout of acme/board');
  });

  it('names only what differs', () => {
    const other = parseInstall({ worker: 'acme-board', secretsPrefix: 'ACME_', secretsStore: 'b'.repeat(32) });
    const { message } = /** @type {{ message: string }} */ (checkInstall(other, ACME, where));
    expect(message).toContain(
      `it says the Secrets Store ${'b'.repeat(32)}, and the board is the Secrets Store ${STORE}.`,
    );
    expect(message).not.toContain('Worker acme-board,');
  });

  it('points at the board’s Worker when it has no install repository', () => {
    const board = { ...ACME, installRepository: null };
    const { message } = /** @type {{ message: string }} */ (checkInstall(parseInstall({}), board, where));
    expect(message).toContain("from the checkout whose breakaway.config.json is the board's (the Worker acme-board).");
  });

  it('compares the rest when the board doesn’t say which Secrets Store it uses', () => {
    const { secretsStore, ...older } = ACME;
    expect(checkInstall(acmeConfig, older, where)).toEqual({ ok: true });
    expect(checkInstall(parseInstall({ secretsPrefix: 'ACME_', secretsStore: STORE }), older, where).ok).toBe(false);
  });

  it('warns, and carries on, on a board too old to say which install it is', () => {
    const result = checkInstall(parseInstall({}), undefined, where);
    expect(result).toMatchObject({ ok: true, warning: expect.stringContaining("can't check") });
  });
});

describe('rotate-token without a token the board accepts names the install instead (CLI-5)', () => {
  const at = { configFile: '~/work/breakaway/breakaway.config.json' };

  it('says where the token goes, from the config', () => {
    expect(tokenTarget(parseInstall({}))).toBe('the secret TASKS_API_TOKEN on the Worker breakaway');
    expect(tokenTarget(acmeConfig)).toBe(`ACME_API_TOKEN in the Secrets Store ${STORE}, for the Worker acme-board`);
  });

  it('says why it can’t ask the board, and what the owner confirms', () => {
    const none = unverifiedInstall(acmeConfig, { ...at, token: false });
    expect(none).toContain("There's no token on this machine");
    expect(none).toContain(`~/work/breakaway/breakaway.config.json says the new token goes in ACME_API_TOKEN`);
    expect(none).toContain("the Worker's name or the Secrets Store's ID");
    expect(unverifiedInstall(parseInstall({}), { ...at, token: true })).toContain(
      "The board refused this machine's token",
    );
    expect(unverifiedInstall(parseInstall({}), { ...at, token: true })).not.toContain('Secrets Store');
  });

  it('goes ahead only when the owner names the config’s Worker, or its Secrets Store', () => {
    expect(confirmInstall(acmeConfig, 'acme-board', at)).toEqual({ ok: true });
    expect(confirmInstall(acmeConfig, ` ${STORE} `, at)).toEqual({ ok: true });
    expect(confirmInstall(parseInstall({}), 'breakaway', at)).toEqual({ ok: true });
    const wrong = confirmInstall(parseInstall({}), 'acme-board', at);
    expect(wrong.ok).toBe(false);
    expect(wrong.message).toContain(
      '"acme-board" isn\'t the Worker breakaway that ~/work/breakaway/breakaway.config.json names',
    );
    expect(wrong.message).toContain('nothing was written');
    for (const empty of ['', '  ', undefined, null]) expect(confirmInstall(acmeConfig, empty, at).ok).toBe(false);
  });
});
