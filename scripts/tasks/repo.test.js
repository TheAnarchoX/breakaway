import { describe, expect, it } from 'vitest';
import { githubFromRemote, inRepo, pickRepo } from './repo.js';

const registry = {
  default: 'widgets',
  repos: [
    { slug: 'widgets', github: 'acme/widgets' },
    { slug: 'breakaway', github: 'acme/breakaway' },
  ],
};

describe('the checkout’s repository', () => {
  it('reads owner/name from every remote shape', () => {
    for (const remote of [
      'https://github.com/acme/widgets',
      'https://github.com/acme/widgets.git',
      'https://github.com/acme/widgets/',
      'https://user@github.com/acme/widgets.git\n',
      'git@github.com:acme/widgets.git',
      'ssh://git@github.com/acme/widgets.git',
      'ssh://git@github.com:22/acme/widgets',
      'http://local_proxy@127.0.0.1:43123/git/acme/widgets',
    ])
      expect(githubFromRemote(remote), remote).toBe('acme/widgets');
    expect(githubFromRemote('http://proxy/git/some.one/my-repo.v2.git')).toBe('some.one/my-repo.v2');
    expect(githubFromRemote('')).toBeNull();
    expect(githubFromRemote(undefined)).toBeNull();
    expect(githubFromRemote('widgets')).toBeNull();
  });

  it('matches the remote against the registry, ignoring case', () => {
    expect(pickRepo({ remote: 'git@github.com:acme/breakaway.git', registry })).toBe('breakaway');
    expect(pickRepo({ remote: 'https://github.com/acme/WIDGETS', registry })).toBe('widgets');
    expect(pickRepo({ remote: 'http://local_proxy@127.0.0.1:1/git/acme/breakaway', registry })).toBe('breakaway');
  });

  it('lets --repo or BREAKAWAY_REPO override the remote, and refuses one the board lacks', () => {
    expect(pickRepo({ named: 'Breakaway', remote: 'https://github.com/acme/widgets', registry })).toBe('breakaway');
    expect(() => pickRepo({ named: 'nowhere', registry })).toThrow(
      /no repository "nowhere" on the board; it has widgets, breakaway\. The owner registers one with npx breakaway repos add/,
    );
  });

  it('behaves as before repositories with an unknown remote or an old board', () => {
    expect(pickRepo({ remote: 'https://github.com/someone/else', registry })).toBeNull();
    expect(pickRepo({ remote: undefined, registry })).toBeNull();
    expect(pickRepo({ remote: 'https://github.com/acme/widgets', registry: null })).toBeNull();
    expect(pickRepo({ named: 'breakaway', registry: null })).toBeNull();
  });

  it('counts a task without repo as the default repository’s', () => {
    expect(inRepo({}, 'widgets', registry)).toBe(true);
    expect(inRepo({ repo: 'widgets' }, 'widgets', registry)).toBe(true);
    expect(inRepo({ repo: 'breakaway' }, 'widgets', registry)).toBe(false);
    expect(inRepo({}, 'breakaway', registry)).toBe(false);
  });
});
