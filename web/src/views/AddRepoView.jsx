import { useEffect, useRef, useState } from 'preact/hooks';
import {
  Bot,
  Circle,
  CircleCheck,
  CircleDot,
  Copy,
  ExternalLink,
  FolderGit2,
  RefreshCw,
  Terminal,
  TriangleAlert,
} from 'lucide-preact';
import { api, enc } from '../lib/api.js';
import { ago } from '../lib/model.js';
import {
  addRepoTarget,
  go,
  installDocs,
  loadConnections,
  loadRepos,
  navOrder,
  openAddRepo,
  openTask,
  repoName,
  repos,
  toast,
} from '../lib/store.js';
import SIDEKICK from '../../../prompts/add-repository.md?raw';
import STUB from '../../../prompts/stub.md?raw';

/**
 * The Add a repository wizard (CLD-194): every step of adding a repository to the board, in order, each ticked
 * from what the board can see (GET /api/repos/setup, tools/tasks/src/wizard.js), with what to do, why, the
 * command, and what you should see. What's wrong and its fix are Connections' own rows. The page asks again
 * every 20 seconds while it's open, so steps tick as you go.
 */

const ext = { target: '_blank', rel: 'noopener noreferrer' };
const POLL_MS = 20_000;
const ROUTINES_URL = 'https://claude.ai/code/routines';

async function copy(text, what) {
  try {
    await navigator.clipboard.writeText(text);
    toast(`${what} copied.`, 'success');
  } catch {
    toast('Couldn’t copy. Select it and copy it yourself.', 'error');
  }
}

/** The sidekick prompt (tools/tasks/prompts/add-repository.md) for this repository, its comment dropped. */
const sidekickFor = ({ slug, github }) =>
  SIDEKICK.replace(/^<!--[\s\S]*?-->\n/u, '')
    .replaceAll('<slug>', slug || '<slug>')
    .replaceAll('<owner/name>', github);
const stubFor = (path) => STUB.replaceAll('<prompt path>', path);

/** @param {Record<string, any>} props */
function ExtLink({ href, children }) {
  return (
    <a class="btn btn-outline btn-sm" href={href} {...ext}>
      {children}
      <ExternalLink size={15} aria-hidden="true" />
      <span class="visually-hidden"> (opens in a new tab)</span>
    </a>
  );
}

/**
 * A command to copy; `terminal` ones say they need the owner's own terminal.
 * @param {Record<string, any>} props
 */
function Command({ text, terminal = false, note }) {
  return (
    <div class="wiz-cmd">
      <div class="wiz-cmd-row">
        <code>{text}</code>
        <button
          type="button"
          class="btn btn-quiet btn-icon btn-sm"
          aria-label={`Copy ${text}`}
          onClick={() => copy(text, 'Command')}
        >
          <Copy size={16} aria-hidden="true" />
        </button>
      </div>
      {(terminal || note) && (
        <p class="meta">
          {terminal && (
            <span class="wiz-terminal">
              <Terminal size={14} aria-hidden="true" />
              In your own terminal
            </span>
          )}
          {note && <span>{note}</span>}
        </p>
      )}
    </div>
  );
}

/**
 * The register step's form: checked against the board as you type (a dry run), then registered as the owner.
 * @param {Record<string, any>} props
 */
function RegisterForm({ github, suggested }) {
  const [slug, setSlug] = useState(suggested ?? '');
  const [areas, setAreas] = useState('');
  const [check, setCheck] = useState({ error: null, ok: null, releasable: [] });
  const [busy, setBusy] = useState(false);
  const [recheck, setRecheck] = useState(0);
  const timer = useRef(null);
  const body = () => ({ slug: slug.trim(), github, areas: areas.split(/[\s,]+/u).filter(Boolean), by: 'owner' });
  useEffect(() => {
    clearTimeout(timer.current);
    if (!slug.trim() || !areas.trim()) {
      setCheck({ error: null, ok: null, releasable: [] });
      return undefined;
    }
    timer.current = setTimeout(async () => {
      try {
        const { repo } = await api('repos', { method: 'POST', body: { ...body(), dryRun: true } });
        setCheck({ error: null, ok: repo, releasable: [] });
      } catch (error) {
        setCheck({ error: error.message, ok: null, releasable: error.data?.releasable ?? [] });
      }
    }, 400);
    return () => clearTimeout(timer.current);
  }, [slug, areas, recheck]);
  // A clash with a repository taken off the board that no task ever used: give its slug and prefixes back (CLD-205).
  const release = async (name) => {
    setBusy(true);
    try {
      await api(`repos/${enc(name)}/release`, { method: 'POST', body: { by: 'owner' } });
      toast(`Released ${name}. Its short name and prefixes are free again.`, 'success');
      setRecheck((n) => n + 1);
    } catch (error) {
      setCheck({ error: error.message, ok: null, releasable: [] });
    } finally {
      setBusy(false);
    }
  };
  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    try {
      const { repo } = await api('repos', { method: 'POST', body: body() });
      await Promise.all([loadRepos(), loadConnections()]);
      toast(`Registered ${repo.name}.`, 'success');
      openAddRepo({ slug: repo.slug });
    } catch (error) {
      setCheck({ error: error.message, ok: null, releasable: error.data?.releasable ?? [] });
    } finally {
      setBusy(false);
    }
  };
  return (
    <form
      class="setup-register"
      onSubmit={submit}
      aria-describedby={check.error ? 'wiz-register-error' : check.ok ? 'wiz-register-ok' : undefined}
    >
      <div class="field-row">
        <label class="field">
          <span class="field-label">Short name</span>
          <input
            class="input"
            name="slug"
            required
            autoComplete="off"
            spellcheck={false}
            value={slug}
            onInput={(e) => setSlug(e.currentTarget.value)}
            aria-describedby="wiz-slug-hint"
          />
          <span class="field-hint" id="wiz-slug-hint">
            Lowercase letters, digits, and hyphens. It never changes.
          </span>
        </label>
        <label class="field">
          <span class="field-label">Areas</span>
          <input
            class="input"
            name="areas"
            required
            autoComplete="off"
            spellcheck={false}
            placeholder="product:PRD cloud:CLD"
            value={areas}
            onInput={(e) => setAreas(e.currentTarget.value)}
            aria-describedby="wiz-areas-hint"
          />
          <span class="field-hint" id="wiz-areas-hint">
            Each area and its work-ID prefix, as area:PREFIX, separated by spaces. A prefix is 2 to 8 capital letters,
            belongs to this repository only, and never changes.
          </span>
        </label>
      </div>
      <p class="meta" role="status">
        {check.error && (
          <span class="field-error" id="wiz-register-error">
            {check.error}
          </span>
        )}
        {check.ok && (
          <span id="wiz-register-ok">
            No clashes: {check.ok.areas.map((a) => `${a.project} ${a.prefix}`).join(', ')}, and the shared ideas IDEA
            and routines RUN.
          </span>
        )}
      </p>
      {check.releasable.length > 0 && (
        <div class="wiz-release">
          <p class="meta">
            No task was ever in {check.releasable.join(' or ')}, so you can release{' '}
            {check.releasable.length === 1 ? 'its short name and prefixes' : 'their short names and prefixes'} and use
            them here.
          </p>
          {check.releasable.map((name) => (
            <button
              key={name}
              type="button"
              class="btn btn-outline btn-sm"
              disabled={busy}
              aria-busy={busy}
              onClick={() => release(name)}
            >
              Release {name}
            </button>
          ))}
        </div>
      )}
      <button type="submit" class="btn btn-primary btn-sm" disabled={busy || Boolean(check.error)} aria-busy={busy}>
        {busy ? 'Registering…' : `Register ${github}`}
      </button>
    </form>
  );
}

/** What each step says: what to do, why, the commands and links, and what you should see when it worked. */
function stepContent(id, d) {
  const slug = d.slug ?? d.suggestedSlug ?? '<slug>';
  const appInstall = d.app?.slug
    ? `https://github.com/apps/${d.app.slug}/installations/new`
    : 'https://github.com/settings/installations';
  const connect = d.isDefault ? 'npx breakaway agents-connect' : `npx breakaway agents-connect --repo ${slug}`;
  switch (id) {
    case 'create':
      return {
        what: (
          <>
            Create <strong>{d.github}</strong> on GitHub: private, and empty (no README, licence, or .gitignore).
          </>
        ),
        why: 'repos init adds the board’s files as its first commit, so an empty repository is the simplest start. One that already has commits works too: init opens a pull request instead.',
        commands: [{ text: `gh repo create ${d.github} --private`, terminal: true }],
        links: [{ href: 'https://github.com/new', label: 'New repository on GitHub' }],
        expect:
          'This ticks with the next step: the board can only see a repository once its GitHub App is installed on it.',
      };
    case 'install':
      return {
        what: (
          <>
            Install the board’s GitHub App on <strong>{d.github}</strong>, then turn on Allow auto-merge in its settings
            (General, then Pull Requests).
          </>
        ),
        why: 'The App is how the board reads the repository, links pull requests to tasks, and merges them. Merge when green needs auto-merge.',
        links: [
          { href: appInstall, label: 'Install the App' },
          { href: `https://github.com/${d.github}/settings`, label: 'Open its settings' },
        ],
        expect: 'All three checks below tick.',
      };
    case 'register':
      return {
        what: 'Give it a short name on the board and its areas, each with a work-ID prefix. The first area gets the first tasks.',
        why: 'The board keeps a registry of the repositories it runs. A prefix belongs to one repository for good, so a work ID like BRK-3 always means one task.',
        form: !d.registered,
        commands: d.registered
          ? []
          : [
              {
                text: `npx breakaway repos add ${slug} ${d.github} --area product:<PREFIX>`,
                terminal: false,
                note: 'Or from a terminal, the same thing.',
              },
            ],
        expect: 'It shows in the repository switcher, and on Connections with its sync as “no commits yet”.',
      };
    case 'init':
      return {
        what: `From a checkout of ${repoName()}, run repos init. It clones the repository next to the checkout and adds what the board’s agents need: the agent prompt, the board’s core and CLI, the session hooks, the tasks skill, a starter AGENTS.md, and Taskwarrior. It asks for each section of the agent prompt first; Enter takes a plain default.`,
        why: 'An agent the board starts reads its instructions from the repository it works in, so they have to be there first. Nothing it finds is overwritten.',
        commands: [
          {
            text: `npx breakaway repos init ${slug}`,
            terminal: true,
            note: 'Add --dry-run to see what it would add first, or --checks "npm test" and the other sections’ flags to answer them without being asked.',
          },
        ],
        expect:
          'On an empty repository it pushes the first commit; on one with commits it opens a pull request for you to merge. This ticks once the board syncs, within 5 minutes.',
      };
    case 'prompt':
      return {
        what: (
          <>
            Check the sections of <code>{d.promptPath}</code> that took the default and replace any{' '}
            <code>&lt;…&gt;</code> left in it with how this repository works, and add how to build to AGENTS.md. Do it
            on a branch, open a pull request, and merge it.
          </>
        ),
        why: 'An agent follows its prompt to the letter: a placeholder left in it is an instruction it can’t follow, so no agent starts here until they’re gone.',
        links: d.promptUrl ? [{ href: d.promptUrl, label: 'Open the prompt on GitHub' }] : [],
        expect:
          'No placeholders left in the prompt on the default branch. The board reads that file, so AGENTS.md is yours to judge.',
      };
    case 'routine':
      return {
        what: (
          <>
            On claude.ai, make a routine for <strong>{d.github}</strong>: a cloud environment that allows{' '}
            {location.host} and has the board’s token as its <code>BREAKAWAY_TOKEN</code> credential, the stub as its
            instructions, and an API trigger.
          </>
        ),
        why: 'A cloud session starts in the repository its routine was saved with, so each repository has its own. The stub only points to the prompt in the repository, so changing the prompt never needs a new paste.',
        stub: true,
        links: [{ href: ROUTINES_URL, label: 'Open routines on claude.ai' }],
        expect: 'The board can’t see claude.ai’s settings, so this ticks with the next step.',
      };
    case 'connect':
      return {
        what: 'Hand the board the routine’s URL and token.',
        why: 'It asks for the token in your terminal, so the token never passes through a chat, a page, or a command line. Run it yourself: through Claude Code’s ! prefix it stops with “this needs a terminal to ask in”.',
        commands: [{ text: connect, terminal: true }],
        expect: `Connections shows its agent routine as Working, and npx breakaway agents lists ${slug} as connected.`,
      };
    case 'task':
      return {
        what: 'From the new repository’s checkout, add a first task, claim it, and release it.',
        why: 'It checks the CLI there talks to the board as this repository: the task gets its prefix, and the claim works from its checkout only.',
        commands: [
          { text: `cd ../${slug}` },
          {
            text: 'npx breakaway add "Add a README" --project <area> --tag agent --horizon now --brief "A short README.md." --done-when "README.md is on the default branch."',
          },
          { text: 'npx breakaway claim <ID>' },
          { text: 'npx breakaway release <ID>' },
        ],
        expect: `The task gets a work ID with this repository’s prefix, and the claim works. The same claim from ${repoName()}’s checkout is refused, naming the repository.`,
      };
    case 'agent':
      return {
        what: 'Start an agent on that task from the board (Start on the task), and follow it to a merged pull request.',
        why: 'The whole chain at once: the routine starts, the session reads the prompt, its output reaches the task, and its pull request finishes the task when it merges.',
        expect:
          'The checks below tick one by one. Its pull request’s title starts with the work ID and it says “Closes <ID>.”. Merging stays yours.',
      };
    default:
      return { what: null };
  }
}

/** @param {Record<string, any>} props */
function StepIcon({ step, now }) {
  if (step.done) return <CircleCheck size={20} aria-hidden="true" class="wiz-icon is-done" />;
  if (now) return <CircleDot size={20} aria-hidden="true" class="wiz-icon is-now" />;
  return <Circle size={20} aria-hidden="true" class="wiz-icon" />;
}

/** @param {Record<string, any>} props */
function Checks({ step }) {
  if (!step.checks?.length) return null;
  return (
    <ul class="wiz-checks">
      {step.checks.map((c) => (
        <li key={c.id} class={c.done ? 'is-done' : ''}>
          {c.done ? <CircleCheck size={16} aria-hidden="true" /> : <Circle size={16} aria-hidden="true" />}
          <span>
            {c.name}
            {c.wid && (
              <>
                {' '}
                (
                <button type="button" class="link-button" onClick={() => openTask(c.wid)}>
                  {c.wid}
                </button>
                {c.number && (
                  <>
                    ,{' '}
                    <a href={c.url ?? '#'} {...ext}>
                      #{c.number}
                    </a>
                  </>
                )}
                )
              </>
            )}
            <span class="visually-hidden">{c.done ? ', done' : ', not yet'}</span>
          </span>
        </li>
      ))}
    </ul>
  );
}

/** @param {Record<string, any>} props */
function Step({ step, index, d }) {
  const now = d.now === step.id;
  const c = stepContent(step.id, { ...d, promptUrl: step.url });
  const body = (
    <div class="wiz-body">
      <p>{c.what}</p>
      <p class="muted">
        <strong>Why:</strong> {c.why}
      </p>
      {step.id === 'prompt' && step.placeholders?.length > 0 && (
        <div class="wiz-placeholders">
          <p class="meta">Still to fill in:</p>
          <ul>
            {step.placeholders.map((p) => (
              <li key={p}>
                <code>{p}</code>
              </li>
            ))}
          </ul>
        </div>
      )}
      {c.form && <RegisterForm github={d.github} suggested={d.suggestedSlug} />}
      {c.commands?.map((cmd) => (
        <Command key={cmd.text} {...cmd} />
      ))}
      {(c.links?.length > 0 || c.stub) && (
        <div class="wiz-actions">
          {c.stub && (
            <button type="button" class="btn btn-outline btn-sm" onClick={() => copy(stubFor(d.promptPath), 'Stub')}>
              <Copy size={16} aria-hidden="true" />
              Copy stub
            </button>
          )}
          {c.links?.map((l) => (
            <ExtLink key={l.href} href={l.href}>
              {l.label}
            </ExtLink>
          ))}
        </div>
      )}
      <Checks step={step} />
      <p class="wiz-expect">
        <strong>When it worked:</strong> {c.expect}
      </p>
      {step.problem && (
        <div class="conn-fix">
          <p>
            <TriangleAlert size={15} aria-hidden="true" class="wiz-warn" /> <strong>{step.problem.name}:</strong>{' '}
            {step.problem.detail}
          </p>
          <p>
            <strong>To fix it:</strong> {step.problem.fix}
          </p>
          {step.problem.link && <ExtLink href={step.problem.link}>Open</ExtLink>}
        </div>
      )}
    </div>
  );
  return (
    <li class={`wiz-step ${step.done ? 'is-done' : ''} ${now ? 'is-now' : ''}`} aria-current={now ? 'step' : undefined}>
      <details open={now}>
        <summary>
          <StepIcon step={step} now={now} />
          <span class="wiz-step-name">
            <span class="wiz-step-n">{index + 1}.</span> {step.name}
            <span class="visually-hidden">{step.done ? ', done' : now ? ', to do now' : ', to do'}</span>
          </span>
          {step.detail && <span class="meta wiz-step-detail">{step.detail}</span>}
        </summary>
        {body}
      </details>
    </li>
  );
}

/**
 * Which repository: owner/name for a new one, or one already registered to carry on with. The wizard's first step,
 * and Settings' Repositories on a fresh install (WEB-32).
 */
export function Pick() {
  const [value, setValue] = useState('');
  const [error, setError] = useState(null);
  const submit = (e) => {
    e.preventDefault();
    const github = value
      .trim()
      .replace(/^https:\/\/github\.com\//u, '')
      .replace(/\.git$/u, '')
      .replace(/\/$/u, '');
    if (!/^[\w.-]{1,39}\/[\w.-]{1,100}$/u.test(github)) {
      setError('Give it as owner/name, like acme/widgets, or its github.com link.');
      return;
    }
    const known = repos.value.list.find((r) => r.github.toLowerCase() === github.toLowerCase());
    openAddRepo(known ? { slug: known.slug } : { github });
  };
  return (
    <div class="wiz-pick">
      <form class="setup-register" onSubmit={submit}>
        <label class="field">
          <span class="field-label">GitHub repository</span>
          <input
            class="input"
            required
            autoComplete="off"
            spellcheck={false}
            placeholder="owner/name"
            value={value}
            onInput={(e) => {
              setValue(e.currentTarget.value);
              setError(null);
            }}
            aria-describedby={error ? 'wiz-pick-error' : 'wiz-pick-hint'}
          />
          <span class="field-hint" id="wiz-pick-hint">
            As owner/name, or its github.com link. It doesn’t have to exist yet: creating it is the first step.
          </span>
        </label>
        {error && (
          <p class="field-error" id="wiz-pick-error" role="alert">
            {error}
          </p>
        )}
        <button type="submit" class="btn btn-primary btn-sm">
          Start
        </button>
      </form>
      {repos.value.list.length > 0 && (
        <section class="conn-group" aria-labelledby="wiz-carry-on">
          <h2 id="wiz-carry-on">Carry on with one</h2>
          <p class="muted small">
            Every repository on the board has its own page here, so you can pick up where you left off.
          </p>
          <ul class="wiz-repos">
            {repos.value.list.map((r) => (
              <li key={r.slug}>
                <button type="button" class="btn btn-outline btn-sm" onClick={() => openAddRepo({ slug: r.slug })}>
                  <FolderGit2 size={16} aria-hidden="true" />
                  {r.name}
                </button>
                <span class="meta">{r.github}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

/**
 * Taking it back off the board, and what's left to delete by hand.
 * @param {Record<string, any>} props
 */
function WayOut({ d }) {
  if (!d.registered || d.isDefault) return null;
  return (
    <section class="conn-group wiz-out" aria-labelledby="wiz-out">
      <h2 id="wiz-out">Changed your mind?</h2>
      <p class="muted small">
        Take it off the board. Its sync, agents, and routines stop, and its slug and prefixes stay its own. It’s refused
        while it has open tasks or running agents, unless you add --force.
      </p>
      <Command
        text={`npx breakaway repos remove ${d.slug}`}
        terminal
        note="It also drops its routine from the board’s Secrets Store."
      />
      <p class="muted small">
        Registered it by mistake, and no task was ever in it? Release it too, and its slug and prefixes can be
        registered again.
      </p>
      <Command text={`npx breakaway repos release ${d.slug}`} terminal />
      <p class="muted small">
        Then, by hand: delete the repository on GitHub (Settings, then Danger zone; or run{' '}
        <code>gh auth refresh -h github.com -s delete_repo</code> once, then <code>gh repo delete {d.github}</code>),
        delete its routine on claude.ai, and delete your local clone.
      </p>
    </section>
  );
}

export function AddRepoView() {
  const target = addRepoTarget.value;
  const key = target ? (target.slug ? `slug=${enc(target.slug)}` : `github=${enc(target.github)}`) : null;
  const [state, setState] = useState({ data: null, error: null, checking: false });
  const load = async (quiet = false) => {
    if (!key) return;
    if (!quiet) setState((s) => ({ ...s, checking: true }));
    try {
      const data = await api(`repos/setup?${key}&check=1`);
      setState({ data, error: null, checking: false });
    } catch (error) {
      setState((s) => ({ ...s, error: error.message, checking: false }));
    }
  };
  useEffect(() => {
    navOrder.value = [];
    setState({ data: null, error: null, checking: false });
    if (!key) return undefined;
    load();
    const poll = setInterval(() => {
      if (document.visibilityState === 'visible') load(true);
    }, POLL_MS);
    return () => clearInterval(poll);
  }, [key]);
  // Registered from another tab or the CLI: carry on on its own page.
  const d = state.data;
  useEffect(() => {
    if (d?.registered && target?.github) openAddRepo({ slug: d.slug });
  }, [d?.registered]);
  const n = d ? d.steps.findIndex((s) => s.id === d.now) : -1;
  return (
    <div class="connections-view wizard">
      <div class="conn-top">
        <div class="view-intro">
          <h1>Add a repository</h1>
          <p class="muted">
            Every step of adding a repository to the board, in order. Each one ticks itself once the board can see it’s
            done, so there’s nothing to confirm by hand. Do it yourself, or copy a prompt for a local agent to walk you
            through it.
          </p>
        </div>
        {d && (
          <div class="conn-check">
            <button
              type="button"
              class="btn btn-primary btn-sm"
              onClick={() => load()}
              disabled={state.checking}
              aria-busy={state.checking}
            >
              <RefreshCw size={16} aria-hidden="true" class={state.checking ? 'spin' : ''} />
              {state.checking ? 'Checking…' : 'Check now'}
            </button>
            <span class="meta">
              {d.checked ? (
                <>
                  GitHub checked <time dateTime={d.checked}>{ago(d.checked)}</time>
                </>
              ) : (
                'GitHub not checked yet'
              )}
            </span>
          </div>
        )}
      </div>
      {!target && <Pick />}
      {state.error && (
        <p class="field-error" role="alert">
          {state.error}
        </p>
      )}
      {target && !d && !state.error && (
        <p class="muted" aria-busy="true">
          Checking…
        </p>
      )}
      {d && (
        <>
          <div class="wiz-head">
            <p class={`conn-summary ${d.done ? '' : 'is-next'}`} role="status">
              {d.done ? <CircleCheck size={18} aria-hidden="true" /> : <CircleDot size={18} aria-hidden="true" />}
              {d.done
                ? `${d.name ?? d.github} is on the board, from its first task to a merged pull request.`
                : `${d.registered ? d.name : d.github}: step ${n + 1} of ${d.steps.length}, ${d.steps[n].name.charAt(0).toLowerCase()}${d.steps[n].name.slice(1)}.`}
            </p>
            <div class="wiz-sidekick">
              <button
                type="button"
                class="btn btn-outline btn-sm"
                onClick={() => copy(sidekickFor({ slug: d.slug ?? d.suggestedSlug, github: d.github }), 'Prompt')}
              >
                <Bot size={16} aria-hidden="true" />
                Copy a prompt for a local agent
              </button>
              <p class="meta">
                For Claude Code in a checkout of {repoName()}. It checks each step and does what an agent may;
                registering, connecting, starting agents, and merging stay yours.
              </p>
            </div>
          </div>
          <ol class="wiz-steps">
            {d.steps.map((s, i) => (
              <Step key={s.id} step={s} index={i} d={d} />
            ))}
          </ol>
          <WayOut d={d} />
          <p class="meta">
            <button type="button" class="link-button" onClick={() => openAddRepo(null)}>
              Add another repository
            </button>
            {' · '}
            <button type="button" class="link-button" onClick={() => go('connections')}>
              Connections
            </button>
            {installDocs.value && ' · '}
            {installDocs.value && (
              <a href={`${installDocs.value}#adding-a-repository`} {...ext}>
                How it works<span class="visually-hidden"> (opens in a new tab)</span>
              </a>
            )}
          </p>
        </>
      )}
    </div>
  );
}
