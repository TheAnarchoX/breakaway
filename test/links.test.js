import { beforeAll, describe, expect, it } from 'vitest';
import { blocks, repoBaseUrl, repoUrl, setRepoBase, tokenize, webUrl } from '../web/src/lib/links.js';

const R = 'https://github.com/acme/widgets';
beforeAll(() => setRepoBase('acme/widgets'));

describe('repository paths', () => {
  it('turns paths from the repository root into GitHub links on main', () => {
    expect(repoUrl('docs/gdpr/beta-testers.md')).toBe(`${R}/blob/main/docs/gdpr/beta-testers.md`);
    expect(repoUrl('docs/moderation-runbook.md#7-the-police')).toBe(
      `${R}/blob/main/docs/moderation-runbook.md#7-the-police`,
    );
    expect(repoUrl('.github/workflows/ci.yml')).toBe(`${R}/blob/main/.github/workflows/ci.yml`);
    expect(repoUrl('AGENTS.md')).toBe(`${R}/blob/main/AGENTS.md`);
    expect(repoUrl('../WORK.md#not-doing')).toBe(`${R}/blob/main/WORK.md#not-doing`);
    expect(repoUrl('./brand/README.md')).toBe(`${R}/blob/main/brand/README.md`);
  });

  it('has no link to make until the board knows its default repository', () => {
    setRepoBase(null);
    expect(repoBaseUrl()).toBeNull();
    expect(repoUrl('docs/tasks.md')).toBeNull();
    setRepoBase('acme/widgets');
    expect(repoBaseUrl()).toBe(R);
  });

  it('links folders as trees', () => {
    expect(repoUrl('brand/design-system/')).toBe(`${R}/tree/main/brand/design-system`);
    expect(repoUrl('docs/gdpr/')).toBe(`${R}/tree/main/docs/gdpr`);
    expect(repoUrl('src/server')).toBe(`${R}/tree/main/src/server`);
  });

  it('sends a bare anchor to WORK.md, where the notes were written', () => {
    expect(repoUrl('#where-things-stand')).toBe(`${R}/blob/main/WORK.md#where-things-stand`);
    expect(repoUrl('#')).toBeNull();
  });

  it("leaves alone what isn't a repository path", () => {
    for (const target of [
      '/about',
      '/api/*',
      'acme.test/?v=2',
      'acme/widgets',
      '@cloudflare/vitest-pool-workers',
      'javascript:alert(1)',
      'data:text/html,x',
      '//evil.example/x',
      'mailto:hello@acme.test',
      'docs/<script>.md',
      'hello',
    ]) {
      expect(repoUrl(target), target).toBeNull();
    }
  });
});

describe('web URLs', () => {
  it('allows only http and https', () => {
    expect(webUrl('https://claude.ai/artifact/6if3vvZ1XqewUpVWc6Y9sa')).toBe(
      'https://claude.ai/artifact/6if3vvZ1XqewUpVWc6Y9sa',
    );
    expect(webUrl('javascript:alert(1)')).toBeNull();
    expect(webUrl('ftp://x')).toBeNull();
    expect(webUrl('not a url')).toBeNull();
  });
});

describe('tokenize', () => {
  it('parses a real note from the old board', () => {
    const tokens = tokenize(
      'Remove the beta tester and send them the invite in [`docs/gdpr/beta-testers.md`](docs/gdpr/beta-testers.md). The privacy notice already says so.',
    );
    expect(tokens).toEqual([
      { type: 'text', text: 'Remove the beta tester and send them the invite in ' },
      {
        type: 'link',
        href: `${R}/blob/main/docs/gdpr/beta-testers.md`,
        label: [{ type: 'code', text: 'docs/gdpr/beta-testers.md' }],
      },
      { type: 'text', text: '. The privacy notice already says so.' },
    ]);
  });

  it("links autolinks and bare URLs, without the sentence's punctuation", () => {
    expect(tokenize('Published at <https://claude.ai/artifact/abc>, see https://taskwarrior.org/docs/sync/.')).toEqual([
      { type: 'text', text: 'Published at ' },
      { type: 'url', text: 'https://claude.ai/artifact/abc', href: 'https://claude.ai/artifact/abc' },
      { type: 'text', text: ', see ' },
      { type: 'url', text: 'https://taskwarrior.org/docs/sync/', href: 'https://taskwarrior.org/docs/sync/' },
      { type: 'text', text: '.' },
    ]);
    expect(tokenize('(https://en.wikipedia.org/wiki/Foo_(bar))')[1].text).toBe(
      'https://en.wikipedia.org/wiki/Foo_(bar)',
    );
  });

  it('links code spans that are repository paths, and nothing else in code', () => {
    const [a, , b, , c] = tokenize('`src/server/pages.js` and `/about` and `**not bold**`');
    expect(a).toEqual({ type: 'code', text: 'src/server/pages.js', href: `${R}/blob/main/src/server/pages.js` });
    expect(b).toEqual({ type: 'code', text: '/about' });
    expect(c).toEqual({ type: 'code', text: '**not bold**' });
  });

  it('keeps unsafe link targets as plain text', () => {
    expect(tokenize('[click](javascript:alert(1))')[0]).toEqual({
      type: 'link',
      label: [{ type: 'text', text: 'click' }],
    });
  });

  it('reads bold, and titles without links', () => {
    expect(tokenize('**Right now** (refreshes)')[0]).toEqual({
      type: 'bold',
      children: [{ type: 'text', text: 'Right now' }],
    });
    expect(tokenize('Publish `security.txt`', { links: false })).toEqual([
      { type: 'text', text: 'Publish ' },
      { type: 'code', text: 'security.txt' },
    ]);
  });
});

describe('blocks', () => {
  it('splits paragraphs and "- " lists', () => {
    const out = blocks('Two sections:\n- **Right now**: live rooms.\n- **Over time**: accounts.\n\nAggregates only.');
    expect(out.map((b) => b.type)).toEqual(['p', 'ul', 'p']);
    expect(out[1].items).toHaveLength(2);
  });
});
