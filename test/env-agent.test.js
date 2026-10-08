import { describe, expect, it } from 'vitest';
import { ENV_AGENT_STEPS, ENV_KINDS, envAgentProblems, envAgentPrompt } from '../web/src/lib/env-agent.js';

/** WEB-121: the prompt Have an agent do it writes for a new environment, and what the wizard checks first. */

const base = {
  repo: 'acme/widgets',
  name: 'staging',
  kind: 'staging',
  provider: 'Cloudflare',
  target: null,
  how: /** @type {const} */ ('describe'),
  need: 'A Worker with a D1 database and a queue for exports.',
};

describe('envAgentPrompt (WEB-121)', () => {
  it('names the repository, the environment, its kind and provider, and the owner’s words', () => {
    const prompt = envAgentPrompt(base);
    expect(prompt.split('\n')[0]).toBe(
      'Set up staging, a new staging environment for acme/widgets on Cloudflare, by pull request.',
    );
    expect(prompt).toContain(
      'What it needs, in the owner’s words:\nA Worker with a D1 database and a queue for exports.',
    );
    expect(prompt).not.toContain('Work out what it needs');
  });

  it('asks the agent to infer what the environment needs from the repository', () => {
    const prompt = envAgentPrompt({ ...base, how: 'infer', need: 'ignored' });
    expect(prompt).toContain('Work out what it needs from acme/widgets');
    expect(prompt).toContain('wrangler config');
    expect(prompt).toContain('.github/breakaway-infra/');
    expect(prompt).not.toContain('ignored');
    expect(prompt).not.toContain('in the owner’s words');
  });

  it('writes the file from the owner’s templates, checks it, and never applies', () => {
    const prompt = envAgentPrompt(base);
    expect(prompt).toContain('.github/breakaway-infra/staging.json');
    expect(prompt).toContain('npx breakaway infra add');
    expect(prompt).toContain('npx breakaway infra check');
    expect(prompt).toContain('waits for the owner');
    expect(prompt).toContain('Never apply');
  });

  it('names the target when there is one, and asks for it in the pull request when there isn’t', () => {
    expect(envAgentPrompt({ ...base, target: 'widgets-staging' })).toContain(
      'Its target is widgets-staging: the Worker it runs on has that name.',
    );
    expect(envAgentPrompt(base)).toContain('It has no target yet');
  });

  it('says the kind in words, with a line for a short-lived environment', () => {
    expect(envAgentPrompt({ ...base, kind: 'production', name: 'production' }).split('\n')[0]).toContain(
      'a new production environment',
    );
    const short = envAgentPrompt({ ...base, kind: 'short-lived', name: 'brk-12' });
    expect(short.split('\n')[0]).toContain('a new short-lived environment');
    expect(short).toContain('short-lived.json');
  });

  it('trims the owner’s words and leaves no trailing space', () => {
    const prompt = envAgentPrompt({ ...base, need: '  a Worker  \n\n' });
    expect(prompt).toContain('in the owner’s words:\na Worker\n');
    expect(prompt.endsWith('\n')).toBe(false);
    for (const line of prompt.split('\n')) expect(line).toBe(line.trimEnd());
  });
});

describe('envAgentProblems (WEB-121)', () => {
  it('passes a filled-in wizard', () => {
    expect(envAgentProblems(base)).toEqual({});
    expect(envAgentProblems({ ...base, how: 'infer', need: '' })).toEqual({});
  });

  it('asks for the owner’s words only when they describe it', () => {
    expect(envAgentProblems({ ...base, need: '  ' }).need).toBe('Say what the environment needs first.');
  });

  it('checks the name as Add an environment does', () => {
    expect(envAgentProblems({ ...base, name: '' }).name).toBe('Name the environment, like staging.');
    expect(envAgentProblems({ ...base, name: 'Staging!' }).name).toBe(
      'Use lowercase letters, digits, and hyphens, starting with a letter or digit.',
    );
    expect(envAgentProblems({ ...base, name: 'a'.repeat(41) }).name).toBeDefined();
    expect(envAgentProblems({ ...base, name: 'staging-2' }).name).toBeUndefined();
  });

  it('asks for a provider and a kind it knows', () => {
    expect(envAgentProblems({ ...base, provider: '' }).provider).toBe('Pick a provider.');
    expect(envAgentProblems({ ...base, kind: 'qa' }).kind).toBe('Pick production, staging, or short-lived.');
  });
});

describe('the wizard’s steps (WEB-121)', () => {
  it('has three steps and the board’s three kinds', () => {
    expect(ENV_AGENT_STEPS.map((s) => s.id)).toEqual(['how', 'where', 'prompt']);
    expect(ENV_KINDS.map(([k]) => k)).toEqual(['production', 'staging', 'short-lived']);
  });
});
