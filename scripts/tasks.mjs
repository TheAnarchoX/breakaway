#!/usr/bin/env node
/**
 * npx breakaway: the task board (breakaway) from any machine with Node, including cloud agents.
 * Talks to the board's JSON API; claims there are atomic. See docs/tasks.md.
 *
 * Settings come from the environment, then tasks.env in this machine's folder for the board ($BREAKAWAY_HOME,
 * else ~/.config/breakaway; scripts/tasks/settings.js):
 *   BREAKAWAY_TOKEN       API token (or the cloud environment's API credential)
 *   BREAKAWAY_URL         the board; default: this checkout's .taskrc (sync.server.url),
 *                         then breakaway.config.json (tools/tasks/ in a copy)
 *   BREAKAWAY_AGENT       your name on claims (default user@host)
 *   BREAKAWAY_REPO        the repository to work in (default: the checkout's origin)
 *   BREAKAWAY_CLIENT_ID   for `setup` (Taskwarrior sync), with BREAKAWAY_SECRET
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { createPrivateKey, pbkdf2Sync, randomBytes, randomUUID } from 'node:crypto';
import {
  appendFileSync,
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir, hostname, userInfo } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DECISION_TEMPLATE,
  PING_TEMPLATE,
  decisionField,
  proposalField,
  structureLines,
  textFields,
} from './tasks/structure.js';
import { looksLikeSecret } from '../src/ping.js';
import { sessionReport, shortHash, stubText } from '../src/session-report.js';
import { promptPathOf } from '../src/repos.js';
import { hookFailure, sessionProxy, routeThroughSessionProxy } from './tasks/proxy.js';
import { githubFromRemote, inRepo, pickRepo } from './tasks/repo.js';
import { appInPlace } from './tasks/github-connect.js';
import { unsupportedSystem, wranglerFailure } from './tasks/platform.js';
import { checkInstall, confirmInstall, tokenTarget, unverifiedInstall } from './tasks/install-check.js';
import { NO_TERMINAL, ask as askIn } from './tasks/ask.js';
import {
  CLI_PACKAGE,
  PLUGIN_BRANCH,
  PLUGIN_REPO,
  PROMPT_SECTIONS,
  initCommitMessage,
  initPlan,
  machineTaskrc,
  promptSections,
} from './tasks/init.js';
import {
  chaseRequest,
  chaseSummary,
  featureBody,
  featureLines,
  featureListLines,
  progressLine,
  forceFields,
  generalAgentRequest,
  generalAgentSummary,
  routineMakerRequest,
  routineWrite,
  githubRequest,
  specLines,
  specListLines,
  specRequest,
  specsRequest,
  ideaTask,
  packageReleaseRequest,
  pullAgentRequest,
  pullAgentSummary,
  reviewRequest,
  staleCliWarning,
  releaseBehind,
  removedRepoByHand,
  unknownSubcommand,
} from './tasks/cli.js';
import { InfraReadError, infraRead } from './tasks/infra-read.js';
import { keepLines } from './tasks/keep.js';
import { checkMcp, headersRepo, mcpAgent, mcpConfig, mcpHeaders, mcpLines } from './tasks/mcp.js';
import {
  listenFor,
  listenText,
  listenWindow,
  mergeViews,
  pelotonLines,
  pelotonPost,
  pickPeloton,
  pickPlanPeloton,
  planRevision,
  planText,
} from './tasks/peloton.js';
import { CLI_VERSION } from '../src/cli-version.js';
import { cwdOf, parentOf, sessionDir } from './tasks/session-dir.js';
import { parseInstall, secretName } from '../src/install.js';
import {
  NAMES,
  boardUrl,
  configDir,
  parseEnvFile,
  readSetting,
  settingFrom,
  taskrcFixes,
  tildePath,
} from './tasks/settings.js';

// The plugin's headersHelper runs in the plugin's folder, and can't move itself to the session's checkout (CLI-20):
// `mcp --headers` moves there before it reads the checkout's settings, origin, and branch. It never fails over it.
if (process.argv[2] === 'mcp' && process.argv.includes('--headers')) {
  const dir = sessionDir({ env: process.env, cwd: process.cwd(), pid: process.pid, parentOf, cwdOf });
  try {
    if (dir) process.chdir(dir);
  } catch {
    /* gone, or not a folder: stay */
  }
}

const CONFIG_DIR = configDir({ env: process.env, home: homedir() });
const ENV_FILE = join(CONFIG_DIR, 'tasks.env');
// Every other repository's routine, as agents-connect --repo wrote it to the Secrets Store: the owner's copy,
// so connecting one more merges instead of dropping the others (the Secrets Store never gives a value back).
const ROUTINES_FILE = join(CONFIG_DIR, 'tasks-routines.json');
const TASKRC_FILE = join(CONFIG_DIR, 'taskrc');
/** The package's root: this checkout when the CLI is run from one, the npm package's folder under npx. */
const PKG = join(dirname(fileURLToPath(import.meta.url)), '..');
/** True under npx (BRK-7): the CLI is the npm package, not a file in the repository it works in. */
const PACKAGED = PKG.split(/[\\/]/u).includes('node_modules');
/** The checkout the CLI works in: its own folder when it's a file there, else the git root of the folder it's run in. */
const REPO = PACKAGED ? checkoutRoot() : PKG;
function checkoutRoot() {
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return process.cwd();
  }
}
/**
 * One of the board's shared files (the install's config, the shared taskrc), found next to the CLI: at the package's
 * root in the board's checkout and in the npm package, in tools/tasks/ in a repository `repos init` copied it to.
 */
function sharedFile(name) {
  const own = join(REPO, name);
  if (existsSync(own)) return own;
  const copied = join(REPO, 'tools', 'tasks', name);
  return existsSync(copied) || !PACKAGED ? copied : join(PKG, name);
}
const CONFIG_FILE = sharedFile('breakaway.config.json');

/**
 * The board's install, from breakaway.config.json: its Secrets Store and the prefix of its secrets' names. Read only by
 * the owner's commands that write secrets; a checkout without the file gets a new install's defaults, as the package
 * does (BRK-77 retired the first install's names).
 */
function installConfig() {
  if (!existsSync(CONFIG_FILE)) return parseInstall({});
  try {
    return parseInstall(JSON.parse(readFileSync(CONFIG_FILE, 'utf8')));
  } catch (error) {
    fail(`${CONFIG_FILE}: ${error.message}`);
  }
}

/**
 * Stops `command` before it writes a secret when this checkout's install config isn't the board's (BRK-95): its
 * secrets would get the wrong names, or go to a Worker that isn't the board's. `health` saves a second request.
 */
async function ensureBoardInstall(command, health = null) {
  const board = (health ?? (await call('GET', 'health'))).install;
  const result = checkInstall(installConfig(), board, { command, configFile: tildePath(CONFIG_FILE, homedir()) });
  if (!result.ok) fail(result.message);
  if (result.warning) console.error(`tasks: ${result.warning}`);
}

/**
 * rotate-token without a token the board accepts (CLI-5): it can't ask the board which install it is, so it says
 * where it would write, and the owner names the Worker (or the Secrets Store) with --worker or when asked.
 */
async function confirmUnverifiedInstall(hadToken) {
  const local = installConfig();
  const where = { configFile: tildePath(CONFIG_FILE, homedir()) };
  console.log(unverifiedInstall(local, { ...where, token: hadToken }));
  let answer = opts.worker;
  if (answer === undefined) {
    if (!process.stdin.isTTY) fail(`${NO_TERMINAL}, or pass --worker <name>.`);
    const { createInterface } = await import('node:readline');
    answer = await askIn("The Worker's name: ", {
      input: process.stdin,
      output: process.stdout,
      createInterface,
    }).catch((error) => fail(error.message));
  }
  const confirmed = confirmInstall(local, answer, where);
  if (!confirmed.ok) fail(confirmed.message);
}

/** Stops `command` before it does anything on a system the install doesn't support: Windows outside WSL (CLI-3). */
function ensureSupportedSystem(command) {
  const message = unsupportedSystem(command, process.platform);
  if (message) fail(message);
}

/** A file in this checkout, or null when it isn't there. */
function readOptional(path) {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

/** The install's config as far as finding the board goes: null without one, or when it doesn't parse. */
function configForUrl() {
  try {
    return JSON.parse(readOptional(CONFIG_FILE) ?? 'null');
  } catch {
    return null;
  }
}

const HELP = `npx breakaway <command> [options]

Reading                (list, next, claim, and add work in this checkout's repository; see Repositories below)
  list                   open tasks, best first (the default command)
    --ready --blocked --active --mine --owner   narrow it down
    --project <p> --tag <t> --horizon <h> --status pending|completed|deleted|all
  show <ref>             one task: description, done when, related, comments, dependencies, and what it blocks
  next                   the best ready task for an agent (+agent, not +decide, unclaimed)
    --claim              …and claim it in the same step
    --project <p> --horizon <h> --tag <t>
  activity               recent changes, newest first  [--limit <n>]
  agents                 cloud agents: what's running, what's waiting to start
  agents new "<prompt>"  start an agent from a prompt: it makes its own task  [--image <file>]… [--repo <slug>] [--force] (owner)
  agents new --decision <ref> ["<note>"]   start an agent that brings the work waiting for an answered decision in line with its answers; the board writes its prompt  [--force] (owner)
  agents new --next minor|major ["<note>"]   start an agent that sets package.json to the next minor or major release; the board writes its prompt  [--repo <slug>] [--force] (owner)
  agents new --spec <path> "<what should change>"   start an agent that changes a spec as you ask and brings the tasks that
                         link it in line; the board writes its prompt  [--repo <slug>] [--force] (owner)
  agents start <ref>     start a Claude cloud agent on a task  [--note <text>] [--force]
  agents refine <ref>    start an agent that improves a task, not builds it  --note <what to look at or change> [--force]
  agents plan [<plan>]   your Claude plan and what it allows; pro, max5, or max20 picks one (owner) and sets the limits to its defaults
  agents next            start the next few ready tasks, one per area  [--count <n>] [--dry-run] [--repo <slug>]
  routines               saved prompts the owner runs with a button, and their caps
  routines run <slug>    run one now: makes a RUN task and starts an agent on it  [--note <text>] [--force]
  routines new "<what you want>"   start an agent that asks how the routines should run, then makes them and turns
                         them on  [--repo <slug>] [--force] (owner)
  features               features by release: each one's progress and chase, and tags that could be features
  features show <slug>   one feature: its release, progress, what waits for you, its chase, and its tasks in order
  chase <slug>           start a chase (owner): the board starts an agent on every ready task in the feature and on
                         what blocks it, within its limits, until all are done or in review
    --parallel <n>       the most agents at once in one area (default 3); on a running chase, it changes it
    --dry-run            show what would start now, and start nothing
  chase <slug> stop      stop it (owner): nothing new starts; running agents finish
  horizon close          close now: finished tasks go to the archive, next becomes now, later becomes next  [--dry-run]
  github fix <n>         start an agent on a pull request's conflicts, failing checks, or review comments (owner)  [--problem conflicts|failing|review] [--note <text>] [--repo <slug>] [--force]
  github review <n>      start an agent that reviews a pull request that can merge as it stands, on the task it closes, as
                         Review with an agent does; on a Dependabot one it tests the update, as Safe to merge? does
                         (owner)  [--note <text>] [--repo <slug>] [--force]
  github release <pre-release>   release a package's pre-release (1.4.0-main.5) as its stable on latest, as Release on the
                         GitHub page does: the board starts release.yml's stable job, and npm waits for your 2FA (owner);
                         --next minor or major opens the pull request that sets the next version (patch, the default, counts
                         by itself). Refused once that stable is out  [--next patch|minor|major] [--repo <slug>]
  specs                  the repository's specs, newest first: each one's status and its tasks  [--repo <slug>]
  specs show <path>      one spec: its status, last change, Markdown, and the tasks that link it  [--repo <slug>]
  github                 the checkout's repository on GitHub: open pull requests, checks, reviews, CI, deploys, alerts  [--sync] [--repo <slug>]
  hook session|wait      the Claude Code session hooks a repository's .claude/settings.json runs (npx breakaway hook session)
  health                 the server's state
  mcp                    print the claude mcp add line and the .mcp.json entry that connect an MCP client to the board's
                         /mcp from this checkout, with the token as $BREAKAWAY_TOKEN, never its value. Writes nothing
    --check              …or check the server answers: initialize and tools/list, or the board's error
    --headers            …or print the headers Claude Code sends to /mcp as JSON, the token included: the plugin's
                         headersHelper. Only Authorization outside a repository the board tracks
  export                 every task (all repositories, statuses, and horizons) as JSON, checked against health's count  [--out <file>]
  connections            is everything the board leans on wired up: GitHub, Cloudflare, Claude, sync, push; the fix for each that isn't

Working
  claim <ref>            take a task (atomic: fails if someone else has it)  [--force]
                         refuses another repository's task unless --repo names it
  release <ref>          give it back  [--force]
  comment <ref> <text>   add a comment (signed with your agent name); note is the same command
  review <ref> --verdict ready|follow-up|changes <note>   your review of the pull request that closes the task you
                         hold: a comment on it, and the review on the pull request's page (the note is Markdown)  [--pr <n>]
  done <ref>             finish it  [--note <text>] [--pr <url>]
  add <description>      new task; gets the next work ID for its project
    --project <p> --tag <t>… --priority H|M|L --horizon now|next|later
    --repo <slug>        the repository it belongs to (default: the checkout's; its areas decide the prefix)
    --depends <ref,…> --related <ref,…> --spec <path> --due <date> --wait <date>
    --brief <text> | --brief-file <path>   the description (--note is the same)
    --done-when <text>   what has to be true to call it done
    --decision <file.json>   questions for the owner to answer on the board (adds +decide); see decision --template
  decision <ref> --template   print an example decision file to edit (nothing here answers a decision: the owner does, on the board)
  ping <ref> <message>   tell the owner you need them, in the inbox and as a push (you must hold the task; a few a day)
    --kind blocked|question|stale|done|fyi   blocked: needs the owner; question: a small question; stale: can't reproduce or already fine; done: looks finished; fyi: inbox only
    --proposal <file.json>   changes for the owner to apply in one press: tasks to add, dependencies, edits, finish, release (ping --template)
  ping --template        print an example proposal file to edit
  peloton                who else is working (in your repository, and your chase's), the chase's plan and open
                         huddle, and what they posted since you last read: new posts are starred  [--all] every post
  peloton checkin <text> say you're here and what you'll change, the files or areas you'll touch, before your first
                         change (you must hold a task); posts on your repository's peloton and your chase's too
  peloton step|note|ask|propose|review <text>   say what you did, talk, ask, propose a change to the plan or the
                         tasks, or ask for a look at your approach; posts on your chase's peloton if your task is in
                         one, else your repository's  [--peloton <name>] picks one
  peloton reply <post> <text>   answer a post, on the peloton it's on
  peloton huddle <question>     call a huddle on your chase's peloton: every agent stops to talk one thing through
  peloton in <huddle> [<text>]  join the open huddle (or say why not now)
  peloton outcome <huddle> <text>   close the huddle you called with what was agreed, and who does what
  peloton plan           print your chase's plan  [--all] its earlier revisions too  [--peloton chase:<feature>]
  peloton plan --file <path> --why <text>   revise the chase's plan (up to 4,000 characters; a line on what changed)
  peloton listen         wait for what's for you, in the foreground, instead of stopping: returns at once on an urgent
                         post, a message, or a change to your pull request, gathers other posts for 30 seconds, and
                         returns after 9 minutes with nothing; then run it again, unless it says to stop
                         [--for <minutes>] up to 9  [--task <ref>] the task you listen on, when you hold more than one
  idea <text>            write down an idea for an agent to shape into tasks and a spec (area Ideas, IDEA-n)
    --horizon now|next|later|auto   the horizon for the tasks it makes (default auto: the agent chooses)
    --auto               start its agent by itself when there's room (your choice; off by default here)
    --image <file>       attach an image (repeatable; up to 4, 1 MB each, PNG/JPEG/WebP/GIF)
    --repo <slug>        the repository it belongs to (default: the checkout's, as for add)
  attach <ref> <file>    attach an image to a task (the owner's; agents read them, they don't add)  [--alt <caption>]
  attachments <ref>      list a task's images  [--save <dir>]  downloads them so you can read them
  modify <ref>           change fields
    --description (the title) --project --priority --horizon --spec --pr --due --wait --status
    --brief <text> | --brief-file <path>   rewrite the description (the owner, or an agent on a task it made or is refining)
    --done-when <text>   change what has to be true to call it done
    --decision <file.json>   set the decision's questions (answers to questions that still exist are kept)
    --related <ref> --unrelated <ref>   add or remove a "see also" link (repeatable; it doesn't block)
    --tag <t> --untag <t> --depends <ref> --undepends <ref>   (repeatable)
    --autostart yes|no   start a cloud agent by itself when the task is ready

  repos                  the repositories this board runs, their areas and work-ID prefixes
  repos add <slug> <owner/name>   register one (owner)  --area <project:PREFIX[:Name]>… [--name <text>] [--branch <name>]
                         (--branch: default branch; without it, the one GitHub reports for the repository, else main)
                         [--prompt <path>] where its agent prompt is in its checkout (default tools/tasks/routine-prompt.md)
                         then repos init <slug>, its routine on claude.ai, and agents-connect --repo <slug>
  repos init <slug>      add the files the board's agents need to a registered repository (owner): clones it
                         (into ../<slug>, or --dir <path>), then pushes them as the first commit of an empty one, or
                         opens a pull request; never overwrites a file it has  [--dry-run]
                         In a terminal it asks for each section of the agent prompt (Enter takes the default), or
                         takes them from --building --checks --pull-requests --direction --dependency-updates
                         --never-share <text>; --defaults takes the default for the rest without asking
                         The tasks skill and the session hooks come from breakaway's Claude Code plugin, which
                         .claude/settings.json turns on; until the plugin is out, they're copied, and it says so
    --update             refresh the copied files (core, Taskwarrior files, release helpers) in a pull request when
                         they're older than this checkout's, and move a repository with copies to the plugin; the
                         repository's own (its prompt, AGENTS.md) are never touched
    --copies             copy the tasks skill and the session hooks instead of using the plugin (with or without --update)
    --pipeline           also add the deploy flow: .github/breakaway-pipeline.json for the Workers --staging <name> and
                         --production <name> (asked in a terminal; default <slug>-staging and <slug>), what it renders,
                         and a minimal CI when the repository has no workflow. Only new files: never one it already has
    --package            also add the release flow for the npm package package.json names, with its publishConfig.access
                         (none for a private package.json); with --pipeline, both flows
  repos setup <slug|owner/name>   the Add a repository wizard's steps for it: which are done, the one to do now, and
                         any fix; read only, so an agent helping the owner may run it (the board's /#/add-repo)
  repos remove <slug>    take one off the board (owner): its sync, webhooks, agents, and routines stop; its tasks
                         stay, and its slug and prefixes stay its own. Refused with open tasks or running agents  [--force]
  repos release <slug>   give a removed repository's slug and prefixes back, as after registering one by mistake
                         (owner); refused if any task was ever in it or a saved routine still names it
  repos modify <slug>    change one (owner): --area <project:PREFIX> adds an area, --remove-area <project> drops one with no tasks, --name, --branch, --github,
                         --agents-max <n|none> and --agents-hourly <n|none> cap its agents under the board's shared limits,
                         --prompt <path|none> says where its agent prompt is in its checkout (default tools/tasks/routine-prompt.md)
                         --specs <dir|none> says where its specs are (default docs/specs)
                         --pipeline <file.json|none> sets its deploy pipeline ({"workers": {"staging", "production"}, "package": "<npm name>", "workflows": {...}, "deployPaths"},
                         with workers, package, or both) or clears it
  features add <slug>    new feature: its tasks join by carrying <slug> as a tag  [--title <text>]
                         [--brief <text> | --brief-file <path>] [--release <x.y.z>] (agents add one without a release)
                         --from <ref> (owner): made from the group <ref> is in on the Dependencies view: its open tasks
                         join, and tasks already in another feature stay there
  features modify <slug> change one (owner): --title, --brief, --brief-file, --release <x.y.z|none>, --state open|shipped
  routines add <slug>    new routine (owner, or the agent of a routine maker's task)  --name <text> --prompt <text> | --prompt-file <path>  [--done-when <text>] [--horizon now|next|later] [--gap <minutes>] [--daily <n>]
                         [--repo <slug>] the repository it runs in (default: the checkout's)
  routines modify <slug> change one (owner, or the agent of the routine maker's task that made it): the same options (--repo <slug> moves it), and --enabled yes|no; --schedule "0 9 * * 1" runs it on a cron schedule (UTC), --schedule "" clears it; --trigger-start auto|wait sets whether a webhook or GitHub event starts the agent or waits for your Start; --github-events pr_merged,release_published,workflow_failed (or "") starts it on those GitHub events
  routines trigger <slug> new webhook/API trigger (owner): prints its secret once  [--label <text>]
  routines revoke <slug> <id>  revoke a trigger
  routines pause|resume  stop or allow every routine  [--daily-all <n>] sets the cap for all routines a day
  routines cap <n>       the cap for all routines a day, up to your Claude plan's ceiling (see agents plan)

Setup (owner)
  setup                  connect this machine's Taskwarrior (writes taskrc in this machine's folder for the board, with every repository's report and context)
  rotate-sync            new client ID and sync secret; the server re-encrypts its history (the old secret isn't needed)
  rotate-token           new API token; every browser is signed out. Works without the old one: you confirm the install
                         by the Worker's name, asked for or given with --worker <name>
  github-connect <code>  store the GitHub App's keys (the board's GitHub view gives the code); refuses when the board
                         already has an App, unless --replace
  agents-connect         store the agent routine's URL and token (docs/tasks.md#cloud-agents-from-the-board)
                         --repo <slug> connects another repository's routine; --replace drops ones this machine doesn't hold
  init-secrets           once, for a brand-new board; --force starts again, keeping the old file as a .bak

Install repository     (no board needed: the files and steps that deploy a board from its own repository)
  install init [dir]     write an install repository into <dir> (default: here): its config, breakaway.json, the Deploy and
                         Update workflows, and a README; never overwrites a file. In a terminal it asks for the board's name,
                         Worker, address, and Secrets Store, or takes --name --worker --url --secrets-store
                         [--secrets-prefix <P_>] [--store <name>] [--jurisdiction eu|fedramp] [--repository <owner/name>]
                         [--install-repository <owner/name>] (default: origin's)
                         [--channel stable|main] [--version <release>]
  install resolve|check|config|previous|healthy|update   the steps those workflows run (docs in the install's README)

Deploy and release flows   (no board needed: run in the checkout of the repository that deploys or publishes)
  pipeline init          render .github/breakaway-pipeline.json into Deploy, Promote, and Roll back (for its workers),
                         .github/deploy-paths.json, and Release (for its npm package); without the config it prints an
                         example. Never overwrites a file  [--update] replaces what it rendered before  [--dry-run]
  pipeline check         say whether the config is sound and the workflows are what it renders now (exits 1 if not)

Infrastructure   (init needs no board: run it in the checkout of the repository whose infrastructure the board applies)
  infra init             render .github/workflows/breakaway-infra.yml, the workflow that applies one approved plan to one
                         of the environments in .github/breakaway-infra/; the board starts it, agents never do
                         [--update] replaces what it rendered before  [--dry-run]  [--branch <name>] (default: origin's)
  infra                  this repository's environments: kind, provider, target, frozen, observe only, a plan waiting
                         (read only, like every infra read below; approving, rejecting, and freezing are the owner's,
                         on the board)
  infra show <environment>   one environment: its desired state, drift, and inventory, with what each resource uses
  infra plans            plans, newest first  [--environment <name>] [--state draft|waiting|approved|rejected|applying|
                         applied|failed|"rolled back"] [--before <id>] [--limit <n>]
  infra plan <id>        one plan: what changes, the cost change, the policy's answer, what else it touches, and
                         whether it can be undone
  infra signals          what the board heard, newest first: health, alerts, and cost  [--environment <name>]
                         [--resource <id>] [--kind health|alert|cost] [--level info|warning|critical] [--source <id>]
                         [--before <id>] [--limit <n>]  [--days] the daily summaries  [--all] every repository's
  infra incidents        open incidents: tasks tagged +incident  [--status completed|all] [--all] every repository's
  infra check [<environment>]   before a pull request: check .github/breakaway-infra/ here (each environment's file
                         and policy.json, naming the file, line, and field that's wrong), then show the plan each valid
                         file would make from what runs now and the policy's answer; the board keeps none of it
                         (exits 1 if a file doesn't check or the board refuses one)

Repositories
  The checkout's repository is the one its origin remote names (git remote get-url origin), matched
  against repos. --repo <slug> or BREAKAWAY_REPO=<slug> picks another, --all shows every repository
  in list and next. show works for any ID. A checkout the board doesn't know works as before.

<ref> is a work ID (OPS-8), a UUID, or its first 8 characters.
Everywhere: --json for machine-readable output, --as <name> to claim as someone else.
Projects: ideas and routines are the board's; repos lists each repository's areas.

Settings: BREAKAWAY_TOKEN, BREAKAWAY_URL, BREAKAWAY_AGENT, BREAKAWAY_REPO, from the environment or tasks.env in
  $BREAKAWAY_HOME (default ~/.config/breakaway).
  Without BREAKAWAY_URL the board is this checkout's .taskrc sync.server.url. See docs/tasks.md#another-install.
  Last come the breakaway plugin's settings for Claude Code (board_url, token, agent_name). health says which
  source each setting came from.`;

// ---- settings ----------------------------------------------------------------------------

function readEnvFile() {
  return existsSync(ENV_FILE) ? parseEnvFile(readFileSync(ENV_FILE, 'utf8')) : {};
}

const fileEnv = readEnvFile();
/**
 * A setting by its key in NAMES (scripts/tasks/settings.js): `TOKEN` reads BREAKAWAY_TOKEN, then the plugin's `token`
 * when the CLI runs in a Claude Code session with the breakaway plugin (CLI-8).
 */
const setting = (key, fallback) => settingFrom(key, { env: process.env, file: fileEnv }).value ?? fallback;
const BOARD = boardUrl({
  env: process.env,
  file: fileEnv,
  taskrc: readOptional(join(REPO, '.taskrc')),
  config: configForUrl(),
});
/** The board's address, or null when nothing says which board (the commands then ask for one). */
const BASE = BOARD.url;
/** A setting's name in tasks.env: `TOKEN` is BREAKAWAY_TOKEN. */
const envName = (key) => NAMES[key];
// In a cloud session, go through its proxy: that's where the board's API credential is added.
routeThroughSessionProxy();

// ---- arguments ---------------------------------------------------------------------------

const REPEATABLE = new Set([
  'image',
  'tag',
  'untag',
  'depends',
  'undepends',
  'related',
  'unrelated',
  'area',
  'remove-area',
]);
const FLAGS = new Set([
  'json',
  'ready',
  'blocked',
  'active',
  'mine',
  'owner',
  'claim',
  'force',
  'help',
  'sync',
  'dry-run',
  'auto',
  'template',
  'all',
  'replace',
  'update',
  'defaults',
  'package',
  'check',
  'headers',
  'days',
]);
/** Flags only in repos init (BRK-91): --pipeline takes a file in repos modify, and is a flag there. */
const INIT_FLAGS = new Set(['pipeline', 'copies']);

function parse(argv) {
  const positional = [];
  const opts = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--') continue;
    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }
    const [name, inline] = arg.slice(2).split(/=(.*)/su);
    if (FLAGS.has(name) || (INIT_FLAGS.has(name) && positional[0] === 'repos' && positional[1] === 'init')) {
      opts[name] = true;
      continue;
    }
    // biome-ignore lint/suspicious/noAssignInExpressions: read the next argument as the value
    const value = inline ?? argv[(i += 1)];
    if (value === undefined) fail(`--${name} needs a value`);
    if (REPEATABLE.has(name)) opts[name] = [...(opts[name] ?? []), ...value.split(',')];
    else opts[name] = value;
  }
  return { positional, opts };
}

function fail(message) {
  console.error(`tasks: ${message}`);
  process.exit(1);
}

// ---- HTTP --------------------------------------------------------------------------------

/**
 * One request to the board's API. Fails the command on an error, unless `soft` (null instead) or `raw` (`{ ok, status,
 * data }` for any answer, and status 0 when the board can't be reached, so a loop can ask again).
 */
async function call(method, path, body, { soft = false, raw = false } = {}) {
  // Without a token the request still goes out: in a Claude cloud environment with an API
  // credential for this host, the agent proxy adds the Authorization header on the way.
  const token = setting('TOKEN');
  let res;
  try {
    res = await fetch(`${BASE}/api/${path}`, {
      method,
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (error) {
    if (raw) return { ok: false, status: 0, data: { error: reasonOf(error) } };
    fail(
      `can't reach ${BASE} (${reasonOf(error)}). Cloud sessions need ${new URL(BASE).host} allowed in their network settings.`,
    );
  }
  warnIfStale(res.headers.get('X-Tasks-Cli'), res.headers.get('X-Tasks-Release'));
  if (res.status === 401 && !token)
    fail(
      `no token. Set BREAKAWAY_TOKEN, put it in ${ENV_FILE}, set it in the breakaway plugin's settings, or add it as an API credential in the cloud environment (see docs/tasks.md#cloud-agents).`,
    );
  const data = await res.json().catch(() => ({
    // The board always answers in JSON, so anything else came from something in between.
    error:
      res.status === 403 && sessionProxy(process.env)
        ? `HTTP 403 from the session's proxy, not the board. The cloud environment has to allow ${new URL(BASE).host}: see docs/tasks.md#cloud-agents.`
        : `HTTP ${res.status}`,
  }));
  if (raw) return { ok: res.ok, status: res.status, data };
  if (!res.ok) {
    if (soft) return null;
    if (opts.json) console.log(JSON.stringify({ status: res.status, ...data }, null, 2));
    fail(data.error ?? `HTTP ${res.status}`);
  }
  return data;
}

let warnedStale = false;
/**
 * Once a run: say so when this copy of the CLI is older than the board's (CLD-193), or this checkout of the board's own
 * repository is behind the release the board runs (BRK-148). On stderr, so --json stays clean.
 */
function warnIfStale(board, release = null) {
  // An old copy says how to switch on every run, even when the board doesn't say its version.
  if (warnedStale || (board === null && PACKAGED)) return;
  warnedStale = true;
  // Only the board's own repository has the Worker; repos init copies the CLI without it.
  const boardCheckout = !PACKAGED && existsSync(join(REPO, 'src/worker.js'));
  let slug = repoContext?.slug ?? null;
  if (!boardCheckout && !PACKAGED && !slug) {
    try {
      slug = /^context=(\S+)/mu.exec(readFileSync(join(REPO, '.taskrc'), 'utf8'))?.[1] ?? null;
    } catch {
      /* no .taskrc */
    }
  }
  const git = (args) => spawnSync('git', ['-C', REPO, ...args], { encoding: 'utf8', timeout: 5000 });
  const behind =
    boardCheckout &&
    Boolean(release) &&
    releaseBehind(release, (args) => git(args).status, {
      shallow: git(['rev-parse', '--is-shallow-repository']).stdout?.trim() === 'true',
    });
  const warning = staleCliWarning({
    own: CLI_VERSION,
    board,
    boardCheckout,
    slug,
    packaged: PACKAGED,
    release,
    behind,
  });
  if (warning) console.error(`tasks: ${warning}`);
}

/** Uploads one image file to a task. */
async function upload(taskRef, file, alt = '') {
  let bytes;
  try {
    bytes = readFileSync(file);
  } catch {
    fail(`can't read ${file}`);
  }
  const token = setting('TOKEN');
  let res;
  try {
    res = await fetch(`${BASE}/api/tasks/${enc(taskRef)}/attachments`, {
      method: 'POST',
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        'Content-Type': 'application/octet-stream',
        'X-Attachment-Name': enc(basename(file)),
        'X-Attachment-Alt': enc(alt),
      },
      body: bytes,
    });
  } catch (error) {
    fail(`can't reach ${BASE} (${reasonOf(error)}).`);
  }
  const data = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
  if (!res.ok) fail(data.error ?? `HTTP ${res.status}`);
  return data.attachment;
}

/** Why a fetch failed: the innermost cause says, like "Proxy response (403) !== 200" from a proxy that refuses the host. */
function reasonOf(error) {
  let root = error;
  while (root.cause) root = root.cause;
  return root.code === 'UND_ERR_ABORTED' || typeof root.code !== 'string' ? root.message : root.code;
}

const enc = encodeURIComponent;

// ---- the checkout's repository (CLD-123) -------------------------------------------------

let repoContext;
/**
 * {slug, registry}: the repository this checkout works in, from --repo, BREAKAWAY_REPO, or the
 * origin remote. slug is null on a board without repositories or in a checkout it doesn't know, and
 * then everything works as before.
 */
async function checkoutRepo() {
  if (repoContext) return repoContext;
  const registry = await call('GET', 'repos', undefined, { soft: true });
  let remote = null;
  try {
    remote = execFileSync('git', ['remote', 'get-url', 'origin'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    /* not a git checkout, or no origin */
  }
  try {
    repoContext = {
      slug: pickRepo({ named: opts.repo ?? setting('REPO'), remote, registry }),
      registry,
    };
  } catch (error) {
    fail(error.message);
  }
  return repoContext;
}

/** The repository list and next stay in: none with --all. */
const scopedRepo = async () => (opts.all ? null : (await checkoutRepo()).slug);

// ---- output ------------------------------------------------------------------------------

function age(iso) {
  if (!iso) return '';
  const mins = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60000));
  if (mins < 60) return `${mins}m`;
  if (mins < 2880) return `${Math.round(mins / 60)}h`;
  return `${Math.round(mins / 1440)}d`;
}

const ref = (t) => t.wid ?? t.short ?? t.uuid.slice(0, 8);
const ago = (iso) => age(iso);

/** Which task this checkout is working on, for the session hook (scripts/tasks/session-hook.mjs). */
function markSession(t) {
  try {
    writeFileSync(
      join(REPO, '.task-session'),
      `${JSON.stringify({ uuid: t.uuid, wid: t.wid, repo: t.repo ?? null, agent: t.claim, at: new Date().toISOString() })}\n`,
    );
  } catch {
    /* not in a checkout: nothing to mark */
  }
}

/**
 * In a Claude Code session, the first entry of the task's live output. The hook sends the rest
 * and stays quiet when it can't, so this says so where the agent sees it.
 */
async function startSessionLog(t) {
  if (!process.env.CLAUDECODE || setting('SESSION_LOG') === 'off') return;
  const token = setting('TOKEN');
  let why;
  try {
    const res = await fetch(`${BASE}/api/tasks/${enc(t.uuid)}/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({
        agent: t.claim,
        remote: process.env.CLAUDE_CODE_REMOTE === 'true',
        entries: [{ kind: 'start', at: Date.now(), text: `Claimed ${ref(t)} as ${t.claim}` }],
      }),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) why = `HTTP ${res.status}`;
  } catch (error) {
    why = reasonOf(error);
  }
  if (why)
    console.error(
      `tasks: this session's live output won't show on ${ref(t)} (${why}). In a cloud session, check its environment allows ${new URL(BASE).host} (docs/tasks.md#cloud-agents).`,
    );
}

/**
 * In a cloud session, what its claim tells the board about its environment, so the routine that started it reads
 * Verified on Connections (BRK-142): whether a name was set, where the token came from, and the hash of this
 * checkout's copy of the stub. Never a value. Null outside a cloud session.
 */
async function environmentReport() {
  if (process.env.CLAUDE_CODE_REMOTE !== 'true') return null;
  const path = ['tools/tasks/prompts/stub.md', 'prompts/stub.md'].map((p) => join(REPO, p)).find((p) => existsSync(p));
  const stub = path ? await shortHash(stubText(readFileSync(path, 'utf8'))) : null;
  return sessionReport({ env: process.env, file: fileEnv, named: Boolean(opts.as), stub });
}

/** The session hook couldn't post this checkout's live output: say so where the agent and the owner see it (BRK-86). */
function warnHookFailure() {
  try {
    const claim = JSON.parse(readFileSync(join(REPO, '.task-session'), 'utf8'));
    const failed = claim?.uuid && hookFailure(claim.uuid);
    if (failed)
      console.error(
        `tasks: the session hook couldn't post ${claim.wid ?? 'this task'}'s live output (${failed.reason}, ${failed.at.slice(0, 16).replace('T', ' ')} UTC), so the board shows none. docs/tasks.md#cloud-agents says what to check.`,
      );
  } catch {
    /* no claim here */
  }
}

function unmarkSession(t) {
  try {
    const path = join(REPO, '.task-session');
    if (existsSync(path) && JSON.parse(readFileSync(path, 'utf8')).uuid === t.uuid) rmSync(path);
  } catch {
    /* nothing to clear */
  }
}

function line(t) {
  const bits = [
    ref(t).padEnd(8),
    (t.priority || '-').padEnd(1),
    (t.horizon ?? '-').padEnd(5),
    (t.project ?? '-').padEnd(10),
    t.description,
  ];
  const extra = [];
  if (t.tags.length) extra.push(t.tags.map((x) => `+${x}`).join(' '));
  if (t.claim) extra.push(`claimed by ${t.claim} ${age(t.start)}`);
  if (t.blocked) extra.push(`blocked by ${t.blockedBy.length}`);
  if (t.waiting) extra.push(`waiting until ${t.wait.slice(0, 10)}`);
  if (t.status !== 'pending') extra.push(`${t.status}${t.end ? ` ${t.end.slice(0, 10)}` : ''}`);
  return `${bits.join('  ')}${extra.length ? `  (${extra.join('; ')})` : ''}`;
}

function detail(t) {
  const out = [`${ref(t)} · ${t.description}`, ''];
  const row = (k, v) => v && out.push(`  ${k.padEnd(11)} ${v}`);
  const inReview = t.status === 'pending' && (t.github ?? []).some((p) => p.closes && p.state === 'open');
  row(
    'Status',
    `${t.status}${t.end ? ` (${t.end.slice(0, 10)})` : ''}${inReview ? ', in review' : ''}${t.blocked ? ', blocked' : ''}${t.waiting ? ', waiting' : ''}${t.ready && !inReview ? ', ready' : ''}`,
  );
  row('Project', t.project);
  row('Horizon', t.horizon);
  row('Priority', t.priority);
  row('Tags', t.tags.map((x) => `+${x}`).join(' '));
  row('Claimed by', t.claim && `${t.claim} (${age(t.start)} ago)`);
  row('Spec', t.spec);
  row('PR', t.pr);
  row('Due', t.due?.slice(0, 10));
  row('Wait', t.wait?.slice(0, 10));
  row('UUID', t.uuid);
  for (const x of [...(t.ships ?? [])].sort((p, q) => (p.stage === q.stage ? 0 : p.stage === 'staging' ? -1 : 1))) {
    row(
      x.stage === 'staging' ? 'On staging' : 'Live',
      `in ${x.version ?? x.sha.slice(0, 7)} (commit ${x.sha.slice(0, 7)}${x.mergeSha && x.mergeSha !== x.sha ? `, merged as ${x.mergeSha.slice(0, 7)}` : ''}, ${x.at.slice(0, 10)}${x.run ? `, run ${x.run}` : ''}${x.tag ? `, release ${x.tag}` : ''})`,
    );
  }
  const merged =
    t.status === 'completed' && !t.shipped && !t.staged
      ? (t.github ?? []).filter((p) => p.closes && p.state === 'merged')
      : [];
  if (merged.length)
    row(
      'Shipped',
      merged.every((p) => Array.isArray(p.workers) && !p.workers.length)
        ? 'no deploy needed (docs, skills, or CI only)'
        : 'not yet: staging does not run it',
    );
  else if (t.staged && !t.shipped) row('Shipped', 'not live yet: promote it from staging');
  for (const p of t.github ?? []) {
    const checks =
      p.checks?.state && p.checks.state !== 'none'
        ? `, checks ${p.checks.state} (${p.checks.passed}/${p.checks.total})`
        : '';
    row(
      p.closes ? 'Closed by' : 'Mentioned',
      `#${p.number} ${p.state}${p.draft ? ' (draft)' : ''}${checks}${p.review && p.review !== 'none' ? `, ${p.review.replace('_', ' ')}` : ''}: ${p.title}`,
    );
  }
  for (const d of t.dependsOn ?? []) row('Depends on', `${d.wid ?? d.uuid.slice(0, 8)} ${d.description} [${d.status}]`);
  for (const d of t.blockingTasks ?? []) row('Blocks', `${d.wid ?? d.uuid.slice(0, 8)} ${d.description}`);
  out.push(...structureLines(t));
  return out.join('\n');
}

function print(data, human) {
  if (opts.json) console.log(JSON.stringify(data, null, 2));
  else console.log(human(data));
}

// ---- commands ----------------------------------------------------------------------------

/** A board from before a route answers 404 with "no route for …", or reads `listen` as a peloton's name. */
const noRoute = (res) => res.status === 404 && /^no route for|no peloton "listen"/u.test(String(res.data?.error ?? ''));

/**
 * `peloton listen`: waits for what's for the agent (IDEA-36 section 3), asking the board every 5 seconds, and prints
 * it. Run in the foreground whenever the agent would otherwise stop and wait.
 */
async function pelotonListen(me) {
  const window = listenWindow(opts.for);
  if ('error' in window) return fail(window.error);
  const path = `peloton/listen?agent=${enc(me)}${opts.task ? `&task=${enc(opts.task)}` : ''}`;
  const ask = async () => {
    const res = await call('GET', path, undefined, { raw: true });
    if (noRoute(res)) return 'no-route';
    // A wrong --task or agent name, or a token the board refuses, won't come right by asking again.
    if ([400, 401, 403, 404].includes(res.status)) fail(res.data?.error ?? `HTTP ${res.status}`);
    return res.ok ? res.data : null;
  };
  const heard = await listenFor({
    ask,
    sleep: (ms) => new Promise((done) => setTimeout(done, ms)),
    now: Date.now,
    window: window.ms,
  });
  print(heard, listenText);
}

/** `peloton plan` prints the chase's plan; with `--file <path> --why <text>`, it revises it (IDEA-36 section 5). */
async function pelotonPlan(me) {
  if (args.length > 1)
    fail('peloton plan takes no text: write the plan in a file and pass --file <path> --why "<what changed>"');
  if (opts.why !== undefined && opts.file === undefined)
    fail('say where the plan is: --file <path> --why "<what changed>"');
  // The board's list marks nothing seen, so reading the plan leaves the agent's new posts for its hooks.
  const { pelotons: list = [] } = await call('GET', 'peloton');
  let rosters = new Map();
  if (!opts.peloton && list.filter((p) => p.kind === 'chase' && p.open).length > 1) {
    const open = list.filter((p) => p.kind === 'chase' && p.open);
    const details = await Promise.all(open.map((p) => call('GET', `peloton/${enc(p.peloton)}`)));
    rosters = new Map(details.map((d) => [d.peloton, d.roster ?? []]));
  }
  const to = pickPlanPeloton(list, { chosen: opts.peloton, agent: me, rosters });
  if ('error' in to) return fail(to.error);
  const route = `peloton/${enc(to.peloton)}/plan`;
  if (opts.file === undefined) {
    const res = await call('GET', route, undefined, { raw: true });
    if (noRoute(res)) fail('this board has no plan yet: it runs an older release');
    if (!res.ok) fail(res.data?.error ?? `HTTP ${res.status}`);
    return print(res.data, (d) => planText(d, { all: opts.all }));
  }
  let text;
  try {
    text = readFileSync(opts.file, 'utf8');
  } catch (error) {
    fail(`can't read ${opts.file}: ${reasonOf(error)}`);
  }
  const revision = planRevision(text, opts.why);
  if ('error' in revision) return fail(revision.error);
  const res = await call('PUT', route, { ...revision, agent: me }, { raw: true });
  if (noRoute(res)) fail('this board has no plan yet: it runs an older release');
  if (!res.ok) {
    if (opts.json) console.log(JSON.stringify({ status: res.status, ...res.data }, null, 2));
    fail(res.data?.error ?? `HTTP ${res.status}`);
  }
  print(res.data, (d) => `Revised the plan on ${to.peloton}: v${d.plan.version}, ${d.plan.why}`);
}

const agent = () => opts.as ?? setting('AGENT', `${userInfo().username}@${hostname()}`);
const need = (value, what) => value ?? fail(`say which ${what}: npx breakaway ${command} <${what}>`);

function changesFrom(o) {
  const c = {};
  for (const key of ['description', 'project', 'priority', 'horizon', 'spec', 'pr', 'due', 'wait', 'status'])
    if (key in o) c[key] = o[key];
  if (c.priority) c.priority = c.priority.toUpperCase();
  if (o.tag) c.addTags = o.tag;
  if (o.untag) c.removeTags = o.untag;
  Object.assign(
    c,
    textFields(o, (path) => readFileSync(path, 'utf8')),
  );
  try {
    Object.assign(
      c,
      decisionField(o, (path) => readFileSync(path, 'utf8')),
    );
  } catch (error) {
    fail(error.message);
  }
  if (c.brief !== undefined || c.done_when !== undefined) c.by = agent();
  if (o.related) c.addRelated = o.related;
  if (o.unrelated) c.removeRelated = o.unrelated;
  if (o.depends) c.addDepends = o.depends;
  if (o.undepends) c.removeDepends = o.undepends;
  if ('autostart' in o) c.autostart = ['yes', 'on', 'true'].includes(String(o.autostart).toLowerCase()) ? 'yes' : null;
  return c;
}

/** Where the board's address, token, and agent name came from (CLI-8): the sources only, never a value. */
function settingSources() {
  const sources = { env: process.env, file: fileEnv };
  return { url: BOARD.from, token: settingFrom('TOKEN', sources).from, agent: settingFrom('AGENT', sources).from };
}

const SOURCE = {
  environment: 'the environment',
  'tasks.env': ENV_FILE,
  '.taskrc': "this checkout's .taskrc",
  config: "the install's breakaway.config.json",
  plugin: "the breakaway plugin's settings",
};

/** settingSources() in a line: `address from …, token from …, agent name from …`. */
function describeSources({ url, token, agent: name }) {
  return [
    `address from ${SOURCE[url] ?? 'nowhere'}`,
    `token ${token ? `from ${SOURCE[token]}` : "not set (a cloud session's proxy may add it)"}`,
    `agent name ${name ? `from ${SOURCE[name]}` : 'not set'}`,
  ].join(', ');
}

const commands = {
  /** The Claude Code session hooks (BRK-7), so a repository's .claude/settings.json runs them through npx. */
  async hook() {
    await import(args[0] === 'wait' ? './tasks/message-wait.mjs' : './tasks/session-hook.mjs');
  },
  async list() {
    const { tasks } = await call('GET', `tasks?status=${enc(opts.status ?? 'pending')}`);
    const repo = await scopedRepo();
    const me = agent();
    const shown = tasks.filter(
      (t) =>
        (!repo || inRepo(t, repo, repoContext.registry)) &&
        (!opts.ready || (t.ready && !t.claim)) &&
        (!opts.blocked || t.blocked) &&
        (!opts.active || t.claim || t.active) &&
        (!opts.mine || t.claim === me) &&
        (!opts.owner || t.tags.includes('owner') || t.tags.includes('decide')) &&
        (!opts.project || t.project === opts.project) &&
        // The archive is hidden from open work only: --status completed or all lists it too (CLD-193).
        (opts.horizon
          ? t.horizon === opts.horizon
          : t.horizon !== 'archive' || (opts.status ?? 'pending') !== 'pending') &&
        (opts.tag ?? []).every((tag) => t.tags.includes(tag)),
    );
    print(shown, (list) => (list.length ? list.map(line).join('\n') : 'Nothing here.'));
  },
  async horizon() {
    if (args[0] !== 'close') fail('horizon close [--dry-run]');
    const r = await call('POST', 'horizons/close', { dryRun: Boolean(opts['dry-run']) });
    print(
      r,
      (d) =>
        `${d.dryRun ? 'Would close' : 'Closed'} now: ${d.archived} archived, ${d.carriedOver} carried over in now, ${d.movedUp} moved up (next becomes now, later becomes next).`,
    );
  },
  async show() {
    const { task } = await call('GET', `tasks/${enc(need(args[0], 'task'))}`);
    print(task, detail);
  },
  /**
   * Every task on the board, in every repository, status, and horizon, as the board's JSON, checked against the
   * count health gives (CLD-193: a stale Taskwarrior replica's task export quietly missed half of them).
   */
  async export() {
    const [{ tasks }, health] = await Promise.all([call('GET', 'tasks?status=all'), call('GET', 'health')]);
    const json = `${JSON.stringify({ exported: new Date().toISOString(), count: tasks.length, tasks }, null, 2)}\n`;
    if (opts.out) writeFileSync(opts.out, json, { mode: 0o600 });
    else process.stdout.write(json);
    const total = health.tasks?.total;
    if (total !== tasks.length)
      fail(
        `exported ${tasks.length} tasks, but the board has ${total}: the export isn't complete. Try again; if it repeats, the board's list is missing some.`,
      );
    console.error(`Exported all ${tasks.length} tasks${opts.out ? ` to ${opts.out}` : ''}; the board has ${total}.`);
  },
  async agents() {
    const sub = args[0];
    if (sub === 'next') {
      const body = {
        count: Number(opts.count ?? 3),
        dryRun: Boolean(opts['dry-run']),
        horizon: opts.horizon,
        repo: opts.repo,
      };
      const plan = await call('POST', 'agents/next', body);
      print(plan, (p) =>
        [
          ...(p.started.length
            ? [
                p.dryRun ? 'Would start:' : 'Started:',
                ...p.started.map((s) => `  ${s.wid.padEnd(8)} ${s.description}${s.url ? `\n           ${s.url}` : ''}`),
              ]
            : ['Nothing to start.']),
          ...(p.skipped.length
            ? ['', 'Not now:', ...p.skipped.slice(0, 12).map((s) => `  ${s.wid.padEnd(8)} ${s.reason}`)]
            : []),
        ].join('\n'),
      );
      return;
    }
    if (sub === 'plan') {
      // The owner's Claude plan (CLD-198): Claude doesn't say, so the board asks. Picking one is the owner's.
      if (args[1]) {
        const { settings } = await call('PATCH', 'agents/settings', {
          plan: args[1],
          by: opts.as ?? setting('AGENT'),
        });
        print(
          { settings },
          (d) =>
            `Plan set. ${d.settings.max} agents at once, ${d.settings.hourly} starts an hour; change either on the Agents view.`,
        );
        return;
      }
      const a = await call('GET', 'agents');
      print({ plan: a.settings.plan, plans: a.plans, limits: a.limits }, (d) =>
        [
          ...d.plans.map(
            (p) =>
              `${p.id === d.plan ? '*' : ' '} ${p.id.padEnd(6)} ${p.name.padEnd(8)} agents at once up to ${p.agents.most} (sets ${p.agents.default}), routine runs a day up to ${p.routinesDaily.most} (sets ${p.routinesDaily.default})`,
          ),
          '',
          `Starts an hour: up to ${d.limits.hourly} (Claude allows ${d.limits.routineHourly} for each routine and ${d.limits.accountHourly} for your account, on every plan).`,
        ].join('\n'),
      );
      return;
    }
    if (sub === 'new') {
      const decision = typeof opts.decision === 'string' ? opts.decision : null;
      const next = typeof opts.next === 'string' ? opts.next : null;
      const spec = typeof opts.spec === 'string' ? opts.spec : null;
      const built = generalAgentRequest(args.slice(1).join(' '), {
        // From a decision, the board runs it in the decision's repository unless --repo says otherwise.
        repo: opts.repo ?? (decision ? null : (await checkoutRepo()).slug),
        decision,
        next,
        spec,
        force: Boolean(opts.force),
        by: opts.as ?? setting('AGENT'),
      });
      if (built.error || !built.request) fail(built.error ?? 'bad request');
      if ((opts.image ?? []).length > 4) fail('an agent takes up to 4 images');
      for (const file of opts.image ?? []) if (!existsSync(file)) fail(`can't read ${file}`);
      const answer = await call(...built.request);
      // The task exists now: attach the images to it, as an idea's are.
      for (const file of opts.image ?? []) {
        const image = await upload(ref(answer.task), file);
        if (!opts.json) console.log(`Attached ${image.name} (${Math.ceil(image.size / 1024)} KB).`);
      }
      print(answer, (d) => generalAgentSummary(d, { next, spec }));
      return;
    }
    if (sub === 'start') {
      const { task, run } = await call('POST', 'agents/start', {
        ref: need(args[1], 'task'),
        note: opts.note,
        ...forceFields(opts.force, opts.as ?? setting('AGENT')),
      });
      print({ task, run }, () => `Started an agent on ${task.wid ?? task.short}: ${run.url}`);
      return;
    }
    if (sub === 'refine') {
      if (typeof opts.note !== 'string' || !opts.note.trim())
        fail('say what it should look at or change: agents refine <task> --note "…"');
      const { task, run } = await call('POST', 'agents/start', {
        ref: need(args[1], 'task'),
        note: opts.note,
        mode: 'refine',
        ...forceFields(opts.force, opts.as ?? setting('AGENT')),
      });
      print({ task, run }, () => `Started an agent refining ${task.wid ?? task.short}: ${run.url}`);
      return;
    }
    const a = await call('GET', 'agents');
    print(a, (d) =>
      [
        d.connected
          ? `Routine connected${d.plans ? ` (${d.plans.find((p) => p.id === d.settings.plan)?.name ?? d.settings.plan})` : ''}. ${d.running.length} of ${d.settings.max} running, ${d.budget.used} of ${d.budget.limit} starts this hour, auto-start ${d.settings.autostart ? 'on' : 'off'}.`
          : "The routine isn't connected yet (docs/tasks.md#cloud-agents-from-the-board).",
        ...(d.running.length
          ? [
              '',
              'Running',
              ...d.running.map(
                (r) =>
                  `  ${r.wid.padEnd(8)} ${r.agent} for ${ago(r.startedAt)}${r.live ? ', live' : ''}${r.lastLine ? `: ${r.lastLine}` : ''}`,
              ),
            ]
          : []),
        ...((d.repos ?? []).length > 1
          ? [
              '',
              'Repositories (sharing the slots and starts above)',
              ...d.repos.map(
                (r, _, all) =>
                  `  ${r.slug.padEnd(Math.max(14, ...all.map((o) => o.slug.length)))} ${r.connected ? 'connected' : 'not connected'}, ${r.running} running${r.caps.max ? ` (cap ${r.caps.max})` : ''}, ${r.used} starts this hour${r.caps.hourly ? ` (cap ${r.caps.hourly})` : ''}`,
              ),
            ]
          : []),
        ...(d.queue.length ? ['', 'Waiting to start', ...d.queue.map((q) => `  ${q.wid.padEnd(8)} ${q.reason}`)] : []),
      ].join('\n'),
    );
  },
  /** Repositories (IDEA-14): reading is for everyone; adding and changing is the owner's, so an agent's name is sent and refused. */
  async repos() {
    const sub = args[0];
    const signer = opts.as ?? setting('AGENT');
    const fields = () =>
      Object.fromEntries(
        Object.entries({
          name: opts.name,
          defaultBranch: opts.branch,
          github: opts.github,
          addAreas: opts.area,
          removeAreas: opts['remove-area'],
          by: signer,
        }).filter(([, v]) => v !== undefined),
      );
    const areas = (r) => r.areas.map((a) => `${a.project} ${a.prefix}`).join(', ');
    if (sub === 'init') {
      await initRepo(need(args[1], 'repository'));
      return refreshMachineTaskrc();
    }
    if (sub === 'remove') {
      await removeRepo(need(args[1], 'repository').toLowerCase(), signer);
      return refreshMachineTaskrc();
    }
    if (sub === 'release') {
      // A removed repository no task ever used gives its slug and prefixes back (CLD-205), as after registering one by mistake.
      const res = await call('POST', `repos/${enc(need(args[1], 'repository').toLowerCase())}/release`, { by: signer });
      print(
        res,
        (r) =>
          `Released ${r.released.slug} (${r.released.github}): its slug and prefixes (${r.released.areas.map((a) => a.prefix).join(', ')}) can be registered again.`,
      );
      return;
    }
    if (sub === 'setup') {
      // The wizard's steps (CLD-194): a slug, or owner/name before it's registered. Asks GitHub live, like the page.
      const which = need(args[1], 'repository');
      const query = which.includes('/') ? `github=${enc(which)}` : `slug=${enc(which.toLowerCase())}`;
      const data = await call('GET', `repos/setup?${query}&check=1`);
      print(data, (d) =>
        [
          `${d.registered ? `${d.slug} (${d.github})` : `${d.github}, not registered yet${d.suggestedSlug ? ` (suggested slug: ${d.suggestedSlug})` : ''}`}: ${d.done ? 'every step is done' : `step ${d.steps.findIndex((s) => s.id === d.now) + 1} of ${d.steps.length} to do now`}`,
          ...d.steps.map((s, i) => {
            const mark = s.done ? '[x]' : s.id === d.now ? '[>]' : '[ ]';
            const lines = [`${mark} ${i + 1}. ${s.name}${s.detail ? `: ${s.detail}` : ''}`];
            for (const c of s.checks ?? [])
              lines.push(
                `      ${c.done ? '[x]' : '[ ]'} ${c.name}${c.wid ? ` (${c.wid}${c.number ? `, #${c.number}` : ''})` : ''}`,
              );
            if (s.problem) lines.push(`      To fix it: ${s.problem.fix}`);
            return lines.join('\n');
          }),
        ].join('\n'),
      );
      return;
    }
    if (sub === 'add') {
      const { addAreas, ...rest } = fields();
      const { repo } = await call('POST', 'repos', {
        slug: need(args[1], 'slug'),
        github: need(args[2], 'owner/name'),
        areas: addAreas,
        ...rest,
        // Where its agent prompt is in its checkout, as repos modify --prompt sets it (CLD-205).
        ...(opts.prompt !== undefined && opts.prompt !== 'none' ? { routine: { prompt: String(opts.prompt) } } : {}),
      });
      print({ repo }, (r) => `Registered ${r.repo.slug} (${r.repo.github}): ${areas(r.repo)}.`);
      return refreshMachineTaskrc();
    }
    if (sub === 'modify') {
      const slug = need(args[1], 'repository');
      const change = fields();
      const routineFlags =
        opts['agents-max'] !== undefined || opts['agents-hourly'] !== undefined || opts.prompt !== undefined;
      const current =
        routineFlags || opts.specs !== undefined
          ? (await call('GET', 'repos')).repos.find((r) => r.slug === slug.toLowerCase())
          : null;
      // Its caps on agents, under the board's shared limits, and where its agent prompt is (CLD-127): kept with the rest of its routine settings.
      if (routineFlags) {
        const routine = { ...current?.routine };
        for (const [flag, key] of [
          ['agents-max', 'max'],
          ['agents-hourly', 'hourly'],
        ]) {
          if (opts[flag] !== undefined) routine[key] = opts[flag] === 'none' ? null : Number(opts[flag]);
        }
        if (opts.prompt !== undefined) routine.prompt = opts.prompt === 'none' ? null : String(opts.prompt);
        change.routine = routine;
      }
      // Where its specs are (IDEA-31), kept with the rest of its settings; none goes back to docs/specs.
      if (opts.specs !== undefined)
        change.settings = { ...current?.settings, specs: opts.specs === 'none' ? null : String(opts.specs) };
      // Its deploy pipeline (BRK-44): a JSON file, or none to clear it; the board refuses one it couldn't use, with the reason.
      if (opts.pipeline !== undefined) {
        if (opts.pipeline === 'none') change.pipeline = null;
        else {
          let text;
          try {
            text = readFileSync(String(opts.pipeline), 'utf8');
          } catch {
            throw new Error(`can't read ${opts.pipeline}: --pipeline takes the path of a JSON file, or none`);
          }
          try {
            change.pipeline = JSON.parse(text);
          } catch {
            throw new Error(`${opts.pipeline} isn't JSON`);
          }
        }
      }
      const { repo } = await call('PATCH', `repos/${enc(slug)}`, change);
      print({ repo }, (r) => `Saved ${r.repo.slug}: ${areas(r.repo)}.`);
      return;
    }
    const data = await call('GET', 'repos');
    // The slug column is as wide as the longest slug, so a long one lines up too (CLD-191).
    const width = Math.max(14, ...data.repos.map((r) => r.slug.length));
    print(data, (d) =>
      !d.repos.length
        ? 'No repository yet. Register the first with repos add <slug> <owner/name> --area <project:PREFIX>; it becomes the default, so tasks without a repository are its.'
        : d.repos
            .map(
              (r) =>
                `${r.slug.padEnd(width)} ${r.github}${r.isDefault ? ' (default: tasks without a repo)' : ''}\n${' '.repeat(width + 1)}${areas(r)}, and the shared ideas IDEA, routines RUN`,
            )
            .join('\n'),
    );
  },
  async routines() {
    const sub = args[0];
    const fields = () => {
      const prompt = opts['prompt-file'] ? readFileSync(opts['prompt-file'], 'utf8') : opts.prompt;
      const yes = (v) => (v === undefined ? undefined : ['yes', 'true', 'on'].includes(String(v)));
      return {
        name: opts.name,
        prompt,
        schedule: opts.schedule,
        done_when: opts['done-when'],
        horizon: opts.horizon,
        enabled: yes(opts.enabled),
        triggerStart: opts['trigger-start'],
        githubEvents: opts['github-events'],
        gapMinutes: opts.gap === undefined ? undefined : Number(opts.gap),
        dailyCap: opts.daily === undefined ? undefined : Number(opts.daily),
      };
    };
    const clean = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));
    // Who writes (BRK-220 section 5): the owner, or a routine maker's agent while it holds its task.
    const by = opts.as ?? setting('AGENT');
    if (sub === 'new') {
      // Make with an agent (BRK-220 section 1): a routine maker's task in the checkout's repository unless --repo.
      const built = routineMakerRequest(args.slice(1).join(' '), {
        repo: opts.repo ?? (await checkoutRepo()).slug,
        force: Boolean(opts.force),
        by,
      });
      if (built.error || !built.request) fail(built.error ?? 'bad request');
      print(await call(...built.request), (d) => generalAgentSummary(d));
      return;
    }
    if (sub === 'run') {
      const { task, run } = await call('POST', `routines/${enc(need(args[1], 'routine'))}/run`, {
        note: opts.note,
        ...forceFields(opts.force, by),
      });
      print({ task, run }, () => `Started ${task.wid}: ${run.url}`);
      return;
    }
    if (sub === 'add') {
      // A routine runs in one repository (CLD-127): --repo, else the checkout's (none: the board's default).
      const repo = opts.repo ?? (await checkoutRepo()).slug ?? undefined;
      const { routine } = await call(
        'POST',
        'routines',
        routineWrite(clean({ slug: need(args[1], 'slug'), ...fields(), repo }), by),
      );
      print({ routine }, () => `Saved the routine ${routine.slug}. Run it: npx breakaway routines run ${routine.slug}`);
      return;
    }
    if (sub === 'modify') {
      const { routine } = await call(
        'PATCH',
        `routines/${enc(need(args[1], 'routine'))}`,
        routineWrite(clean({ ...fields(), repo: opts.repo }), by),
      );
      print({ routine }, () => `Saved ${routine.slug}.`);
      return;
    }
    if (sub === 'trigger') {
      const slug = need(args[1], 'routine');
      const { trigger, secret } = await call(
        'POST',
        `routines/${enc(slug)}/triggers`,
        routineWrite({ label: opts.label }, by),
      );
      print({ trigger, secret }, () =>
        [
          `Made trigger ${trigger.id} (${trigger.label}) for ${slug}. The secret is shown once; the board keeps only its hash:`,
          '',
          `  ${secret}`,
          '',
          `POST ${BASE}/api/routines/${slug}/fire with "Authorization: Bearer <secret>" (or an X-Routine-Secret header), and an optional JSON body {"note": "…", "data": {"key": "value"}}.`,
        ].join('\n'),
      );
      return;
    }
    if (sub === 'revoke') {
      await call(
        'DELETE',
        `routines/${enc(need(args[1], 'routine'))}/triggers/${enc(need(args[2], 'trigger id'))}`,
        routineWrite({}, by),
      );
      print({ ok: true }, () => 'Revoked.');
      return;
    }
    if (sub === 'cap') {
      // The cap for all routines a day (CLD-199), without pausing or resuming them.
      const { settings } = await call(
        'PATCH',
        'routines/settings',
        routineWrite({ dailyCap: Number(need(args[1], 'runs a day')) }, by),
      );
      print({ settings }, (d) => `All routines can run ${d.settings.dailyCap} times a day.`);
      return;
    }
    if (sub === 'pause' || sub === 'resume') {
      const { settings } = await call(
        'PATCH',
        'routines/settings',
        routineWrite(
          clean({
            paused: sub === 'pause',
            dailyCap: opts['daily-all'] === undefined ? undefined : Number(opts['daily-all']),
          }),
          by,
        ),
      );
      print({ settings }, () => (settings.paused ? 'All routines are paused.' : 'Routines can run.'));
      return;
    }
    const r = await call('GET', 'routines');
    const several = new Set(r.routines.map((x) => x.repo)).size > 1;
    print(r, (d) =>
      [
        `${d.settings.runsToday} of ${d.settings.dailyCap} routine runs in the last day${d.settings.paused ? ', all paused' : ''}.`,
        ...(d.routines.length ? [''] : ['', 'No routines yet: routines add <slug> --name … --prompt …']),
        ...d.routines.map(
          (x) =>
            `  ${x.slug.padEnd(16)} ${several ? `${x.repo}: ` : ''}${x.enabled ? 'on ' : 'off'} ${x.openRun ? `running ${x.openRun.wid}` : x.lastRun ? `last ${x.lastRun.wid ?? ''} ${ago(x.lastRun.at)}` : 'never run'}, ${x.runsToday} of ${x.dailyCap} today${x.schedule ? `, schedule ${x.schedule}${x.nextRun ? ` (next ${x.nextRun.slice(0, 16).replace('T', ' ')} UTC)` : ''}` : ''}${x.triggers?.length ? `, ${x.triggers.length} trigger${x.triggers.length === 1 ? '' : 's'} (${x.triggerStart === 'auto' ? 'start by themselves' : 'wait for Start'}; ids ${x.triggers.map((t) => t.id).join(', ')})` : ''}${x.disabledReason ? `, off: ${x.disabledReason}` : ''}`,
        ),
      ].join('\n'),
    );
  },
  async infra() {
    const { slug } = await checkoutRepo();
    if (args[0] === 'check') {
      // infra check (CLI-14): the checkout's files, checked here, then the board's preview, which keeps nothing.
      const { infraCheck, readInfraFolder } = await import('./tasks/infra-check.js');
      const { topOf } = await import('./tasks/pipeline.js');
      const result = await infraCheck(args.slice(1), {
        files: readInfraFolder(topOf(process.cwd())),
        repo: slug,
        post: (path, body) => call('POST', path, body, { raw: true }),
      });
      print(result.data, () => result.text);
      process.exitCode = result.code;
      return;
    }
    // Architect's reads (CLI-13): every request is a GET, so an agent's token reads and never writes.
    let result;
    try {
      result = await infraRead(args, {
        get: (path) => call('GET', path, undefined, { raw: true }),
        repo: slug,
        opts,
        inRepo: (t) => !slug || inRepo(t, slug, repoContext.registry),
      });
    } catch (error) {
      if (!(error instanceof InfraReadError)) throw error;
      if (opts.json) console.log(JSON.stringify({ error: error.message }, null, 2));
      fail(error.message);
    }
    print(result.data, () => result.text);
  },
  async specs() {
    // A repository's specs (IDEA-31), read from its default branch on GitHub: the checkout's unless --repo names another.
    const { slug } = await checkoutRepo();
    if (args[0] === 'show') {
      const built = specRequest(args.slice(1).join(' ') || undefined, slug);
      if (built.error || !built.request) fail(built.error ?? 'bad request');
      print(await call(...built.request), (d) => specLines(d).join('\n'));
      return;
    }
    print(await call(...specsRequest(slug)), (d) => specListLines(d).join('\n'));
  },
  async features() {
    const sub = args[0];
    const body = () =>
      featureBody({
        title: opts.title,
        brief: opts['brief-file'] ? readFileSync(opts['brief-file'], 'utf8') : opts.brief,
        release: opts.release,
        state: opts.state,
      });
    // Who asks, so the board can refuse an agent what's the owner's (a release, a change).
    const by = opts.as ?? setting('AGENT');
    if (sub === 'add') {
      const slug = need(args[1], 'slug').toLowerCase();
      const from = opts.from === undefined ? {} : { from: opts.from };
      const added = await call('POST', 'features', { slug, ...body(), ...from, ...(by ? { by } : {}) });
      print(added, (d) =>
        [
          `Added the feature ${d.feature.slug}${d.feature.release ? `, aimed at ${d.feature.release}` : ''}: ${progressLine(d.feature.progress)}.`,
          ...(d.joined
            ? [
                `Joined by its tag: ${d.joined.join(', ')}.`,
                ...d.kept.map((k) => `${k.wid} stays in ${k.feature}: a task is in one feature.`),
                `Chase it: npx breakaway chase ${d.feature.slug}`,
              ]
            : [`Tasks join it by the tag: npx breakaway modify <ref> --tag ${d.feature.slug}`]),
        ].join('\n'),
      );
      return;
    }
    if (sub === 'modify') {
      const changes = body();
      if (!Object.keys(changes).length) fail('say what to change: --title, --brief, --release, or --state');
      const { feature } = await call('PATCH', `features/${enc(need(args[1], 'feature').toLowerCase())}`, {
        ...changes,
        ...(by ? { by } : {}),
      });
      print({ feature }, (d) => `Saved ${d.feature.slug}.`);
      return;
    }
    if (sub === 'show') {
      const { feature } = await call('GET', `features/${enc(need(args[1], 'feature').toLowerCase())}`);
      print({ feature }, (d) => featureLines(d.feature).join('\n'));
      return;
    }
    print(await call('GET', 'features'), (d) => featureListLines(d).join('\n'));
  },
  async chase() {
    const built = chaseRequest(args[0], args[1], {
      parallel: opts.parallel,
      dryRun: Boolean(opts['dry-run']),
      by: opts.as ?? setting('AGENT'),
    });
    if (built.error) fail(built.error);
    const answer = await call(...built.request);
    print(answer, (d) =>
      chaseSummary(args[0].toLowerCase(), d, {
        stop: args[1] === 'stop',
        parallel: opts.parallel === undefined ? undefined : Number(opts.parallel),
      }),
    );
  },
  async next() {
    const body = { agent: agent(), claim: Boolean(opts.claim), project: opts.project, horizon: opts.horizon };
    const repo = await scopedRepo();
    if (repo) body.repo = repo;
    if (opts.tag) body.tags = ['agent', ...opts.tag];
    const { task } = await call('POST', 'next', body);
    if (task && opts.claim) {
      markSession(task);
      await startSessionLog(task);
    }
    print(task, (t) =>
      t ? `${opts.claim ? 'Claimed' : 'Next up'}: ${detail(t)}` : 'Nothing ready for an agent right now.',
    );
  },
  async claim() {
    // The board refuses a task of another repository than the one sent (--all doesn't widen a claim).
    const { slug: repo } = await checkoutRepo();
    const session = await environmentReport();
    const { task } = await call('POST', `tasks/${enc(need(args[0], 'task'))}/claim`, {
      agent: agent(),
      force: Boolean(opts.force),
      ...(repo ? { repo } : {}),
      ...(session ? { session } : {}),
    });
    markSession(task);
    await startSessionLog(task);
    print(task, (t) => `Claimed ${ref(t)} as ${t.claim}: ${t.description}`);
  },
  async release() {
    const { task } = await call('POST', `tasks/${enc(need(args[0], 'task'))}/release`, {
      agent: agent(),
      force: Boolean(opts.force),
    });
    unmarkSession(task);
    print(task, (t) => `Released ${ref(t)}.`);
  },
  async review() {
    const built = reviewRequest(args[0], opts.verdict, args.slice(1).join(' '), { by: agent(), pr: opts.pr });
    if (built.error || !built.request) fail(built.error ?? 'bad request');
    const { review, task } = await call(...built.request);
    print({ review, task }, (r) => `Left your review of #${r.review.pr} on ${ref(r.task)}: ${r.review.label}.`);
  },
  // The board's `annotate` route is the comments route's alias; using it keeps this working on a board that hasn't deployed /comments yet.
  async comment() {
    const text = args.slice(1).join(' ');
    if (!text) fail(`say what to write: npx breakaway ${command} <task> <text>`);
    const { task } = await call('POST', `tasks/${enc(need(args[0], 'task'))}/annotate`, { text, by: agent() });
    print(task, (t) => `Commented on ${ref(t)}.`);
  },
  async done() {
    const id = need(args[0], 'task');
    if (opts.pr) await call('PATCH', `tasks/${enc(id)}`, { pr: opts.pr });
    const { task } = await call('POST', `tasks/${enc(id)}/done`, { note: opts.note });
    unmarkSession(task);
    print(task, (t) => `Done: ${ref(t)} ${t.description}`);
  },
  async add() {
    const description = args.join(' ');
    if (!description) fail('say what the task is: npx breakaway add "Publish security.txt" --project ops');
    /** @type {any} */
    const body = { ...changesFrom(opts), description, tags: opts.tag, depends: opts.depends, related: opts.related };
    const { slug: repo } = await checkoutRepo();
    if (repo) body.repo = repo;
    // --note is the older name for the description.
    if (opts.note && body.brief === undefined) Object.assign(body, { brief: opts.note, by: agent() });
    delete body.addTags;
    delete body.addDepends;
    delete body.addRelated;
    delete body.removeRelated;
    const { tasks } = await call('POST', 'tasks', body);
    print(tasks[0], (t) => `Added ${ref(t)}: ${t.description}`);
  },
  async decision() {
    if (!opts.template)
      fail(
        'decision <task> --template prints an example file. Only the owner answers a decision, on the board; read the questions and answers with show.',
      );
    print(DECISION_TEMPLATE, (q) => JSON.stringify(q, null, 2));
  },
  async ping() {
    if (opts.template) return print(PING_TEMPLATE, (t) => JSON.stringify(t, null, 2));
    const message = args.slice(1).join(' ').trim();
    if (!opts.kind)
      fail(
        'say why: npx breakaway ping <task> --kind blocked|question|stale|done|fyi "<message>" [--proposal <file.json>]',
      );
    if (!message) fail('say what happened and what you need: npx breakaway ping <task> --kind <kind> "<message>"');
    if (looksLikeSecret(message)) fail('that message looks like it holds a token or key; say what happened without it');
    let proposal;
    try {
      proposal = proposalField(opts, (path) => readFileSync(path, 'utf8')).proposal;
    } catch (error) {
      fail(error.message);
    }
    const out = await call('POST', `tasks/${enc(need(args[0], 'task'))}/pings`, {
      kind: opts.kind,
      message,
      by: agent(),
      ...(proposal === undefined ? {} : { proposal }),
    });
    print(out, (r) =>
      r.dropped
        ? `Not sent: the same ping is already there (${r.ping.task}, ${r.ping.kind}).`
        : `Pinged the owner about ${r.ping.task} (${r.ping.kind}).${r.ping.warnings.length ? `\nNote for the owner: ${r.ping.warnings.join('; ')}.` : ''}${r.ping.push ? '' : ' It shows in the inbox without a notification.'}`,
    );
  },
  async peloton() {
    const me = agent();
    const read = async () => (await call('GET', `peloton?agent=${enc(me)}`)).pelotons ?? [];
    if (!args[0]) {
      const views = await read();
      return print({ agent: me, pelotons: views }, () => pelotonLines(views, { agent: me, all: opts.all }));
    }
    if (args[0] === 'listen') return pelotonListen(me);
    if (args[0] === 'plan') return pelotonPlan(me);
    const post = pelotonPost(args[0], args.slice(1));
    if ('error' in post) return fail(post.error);
    // Read first: it says which peloton the post goes to, and which posts were new before it.
    const views = await read();
    const to = pickPeloton(views, { ...post, chosen: opts.peloton, agent: me });
    if ('error' in to) return fail(to.error);
    const posted = [];
    let after = views;
    for (const peloton of to.pelotons) {
      const out = await call('POST', `peloton/${enc(peloton)}`, {
        agent: me,
        kind: post.kind,
        text: post.text,
        ...(post.kind === 'reply' ? { reply_to: post.replyTo } : {}),
      });
      posted.push(out.post);
      after = mergeViews(after, out.peloton);
    }
    const where = posted.map((p) => `#${p.id} on ${p.peloton}`).join(' and ');
    print({ post: posted[0], posts: posted, pelotons: after }, () =>
      [`Posted ${where}.`, pelotonLines(after, { agent: me, all: opts.all })].join('\n\n'),
    );
  },
  async idea() {
    const idea = args.join(' ').trim();
    if (!idea) fail('write the idea: npx breakaway idea "Let people send a room link as a QR code" [--auto]');
    const horizon = String(opts.horizon ?? 'auto').toLowerCase();
    if (!['now', 'next', 'later', 'auto'].includes(horizon)) fail('--horizon is now, next, later, or auto');
    const { slug: repo } = await checkoutRepo();
    const { tasks } = await call('POST', 'tasks', ideaTask(idea, { horizon, auto: Boolean(opts.auto), repo }));
    const t = tasks[0];
    for (const file of opts.image ?? []) {
      const image = await upload(ref(t), file);
      if (!opts.json) console.log(`Attached ${image.name} (${Math.ceil(image.size / 1024)} KB).`);
    }
    print(
      t,
      () =>
        `Saved ${ref(t)}: ${t.description} (horizon: ${horizon})\n${opts.auto ? 'Its agent starts by itself when there’s room.' : `Start its agent from the board, or: npx breakaway agents start ${ref(t)}`}`,
    );
  },
  async attach() {
    const task = need(args[0], 'task');
    const image = await upload(task, need(args[1], 'image file'), opts.alt ?? '');
    print(image, (i) => `Attached ${i.name} to ${task} (${Math.ceil(i.size / 1024)} KB, image ${i.id}).`);
  },
  async attachments() {
    const task = need(args[0], 'task');
    const { attachments } = await call('GET', `tasks/${enc(task)}/attachments`);
    if (opts.save) {
      mkdirSync(opts.save, { recursive: true });
      const token = setting('TOKEN');
      for (const image of attachments) {
        const res = await fetch(`${BASE}/api/attachments/${image.id}`, {
          headers: token ? { Authorization: `Bearer ${token}` } : {},
        });
        if (!res.ok) fail(`couldn't download ${image.name} (HTTP ${res.status})`);
        const ext = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' }[image.type];
        const file = join(
          opts.save,
          `${image.id}-${image.name.replace(/[^\w.-]+/gu, '_').replace(/\.\w+$/u, '')}.${ext}`,
        );
        writeFileSync(file, Buffer.from(await res.arrayBuffer()));
        image.file = file;
      }
    }
    print(attachments, (list) =>
      list.length
        ? list
            .map(
              (i) =>
                `${i.id}  ${i.name}  ${i.type}  ${Math.ceil(i.size / 1024)} KB${i.alt ? `  "${i.alt}"` : ''}${i.file ? `\n    saved: ${i.file}` : ''}`,
            )
            .join('\n')
        : 'No images.',
    );
  },
  async modify() {
    const changes = changesFrom(opts);
    if (!Object.keys(changes).length) fail('nothing to change; see npx breakaway --help');
    // Who changes it, whichever field: a general agent's edits of other tasks follow their own rule (IDEA-30 section 2).
    changes.by = agent();
    const { task } = await call('PATCH', `tasks/${enc(need(args[0], 'task'))}`, changes);
    print(task, (t) => `Changed ${ref(t)}.\n\n${detail(t)}`);
  },
  async activity() {
    const limit = Number(opts.limit ?? 20);
    const { events } = await call('GET', `activity?limit=${enc(limit)}`);
    const says = (c) =>
      ({
        created: 'added',
        done: 'finished',
        reopened: 'opened again',
        deleted: 'deleted',
        purged: 'removed from the history',
        claimed: `claimed by ${c.by}`,
        released: 'released',
        note: `note: ${c.text}`,
        numbered: `got its work ID ${c.wid}`,
        changed: `changed ${c.fields?.join(', ')}`,
        ping: `ping (${c.pingKind}) from ${c.by}: ${c.text}`,
        unreadable: "a change the server can't read",
      })[c.kind] ?? c.kind;
    print(events, (list) =>
      list.length
        ? list
            .map((e) => {
              const who = e.task ? `${(e.task.wid ?? e.task.uuid.slice(0, 8)).padEnd(8)} ${e.task.description}` : '';
              return `${e.at.slice(0, 16).replace('T', ' ')}  ${e.source === 'taskwarrior' ? 'task' : 'api '}  ${who}\n${e.changes.map((c) => `      ${says(c)}`).join('\n')}`;
            })
            .join('\n')
        : 'No activity yet.',
    );
  },
  async github() {
    const action = args[0];
    if (action === 'fix' || action === 'review') {
      const built = pullAgentRequest(action, args[1], {
        repo: (await checkoutRepo()).slug,
        problem: opts.problem,
        note: opts.note,
        force: Boolean(opts.force),
        by: opts.as ?? setting('AGENT'),
      });
      if (built.error || !built.request) fail(built.error ?? 'bad request');
      const answer = await call(...built.request);
      print(answer, (a) => pullAgentSummary(action, args[1].replace(/^#/u, ''), a));
      return;
    }
    if (action === 'release') {
      const built = packageReleaseRequest(args[1], {
        repo: (await checkoutRepo()).slug,
        by: opts.as ?? setting('AGENT'),
        next: typeof opts.next === 'string' ? opts.next : null,
      });
      if (built.error || !built.request) fail(built.error ?? 'bad request');
      const answer = await call(...built.request);
      const next = built.request[2].next;
      print(
        answer,
        () =>
          `Started ${answer.workflow}'s stable job for ${args[1]}. It stages the stable on npm's latest, where it waits for your approval with 2FA.${next && next !== 'patch' ? ` Then a pull request sets package.json to the next ${next}.` : ''}`,
      );
      return;
    }
    const g = await call(...githubRequest((await checkoutRepo()).slug, { sync: Boolean(opts.sync) }));
    print(g, (d) => {
      if (!d.connected) return "GitHub isn't connected yet: open the GitHub view on the board (docs/tasks.md#github).";
      const checks = (c) => (c.state === 'none' ? 'no checks' : `checks ${c.state} (${c.passed}/${c.total})`);
      const out = [
        `${d.repo}, synced ${d.lastSync ? d.lastSync.slice(0, 16).replace('T', ' ') : 'never'}${d.error ? ` (last sync failed: ${d.error})` : ''}`,
      ];
      if (d.alerts.length)
        out.push(
          '',
          'Security alerts',
          ...d.alerts.map(
            (a) => `  ${a.severity.padEnd(8)} ${a.package}: ${a.summary}${a.fixedIn ? ` (fixed in ${a.fixedIn})` : ''}`,
          ),
        );
      out.push('', `Open pull requests (${d.open.length})`);
      for (const p of d.open) {
        out.push(`  #${p.number} ${p.draft ? '[draft] ' : ''}${p.title}`);
        out.push(
          `      ${checks(p.checks)}, review ${p.review.decision.replace('_', ' ')}${p.closes.length ? `, closes ${p.closes.join(', ')}` : ''}`,
        );
      }
      if (d.deploys?.length) {
        out.push('', `Deploys (${d.deploys.length})`);
        for (const x of d.deploys.slice(0, 8))
          out.push(
            `  ${x.state.padEnd(8)} ${x.env} ${(x.version ?? x.sha).slice(0, 8)} (${x.sha.slice(0, 7)}, ${(x.updated ?? '').slice(0, 16).replace('T', ' ')})${x.shipped?.length ? `: ${x.env === d.pipeline?.staging ? 'on staging' : 'live'} ${x.shipped.map((t) => t.wid).join(', ')}` : ''}`,
          );
      }
      if (d.releases?.length) out.push('', `Releases: ${d.releases.map((r) => r.tag).join(', ')}`);
      const failing = d.runs
        .filter((r) => r.status === 'completed' && ['failure', 'timed_out'].includes(r.conclusion))
        .slice(0, 5);
      if (failing.length)
        out.push('', 'Recent failed runs', ...failing.map((r) => `  ${r.name} on ${r.branch}: ${r.url}`));
      return out.join('\n');
    });
  },
  /** How to connect an MCP client to the board's /mcp from this checkout, and --check whether it answers (CLI-6). */
  async mcp() {
    // --headers is the plugin's headersHelper: it asks the board itself, and never fails (CLI-9).
    const { slug } = opts.headers ? { slug: null } : await checkoutRepo();
    let branch = null;
    try {
      branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
    } catch {
      /* not a git checkout */
    }
    const named = opts.as ?? setting('AGENT');
    const name = mcpAgent({ named, branch, fallback: agent() });
    if (opts.headers) {
      const token = setting('TOKEN');
      let remote = null;
      try {
        remote = execFileSync('git', ['remote', 'get-url', 'origin'], {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
        });
      } catch {
        /* not a git checkout, or no origin */
      }
      // Claude Code says which server it's connecting: the plugin's board_url, when the CLI's settings don't name one.
      const server = process.env.CLAUDE_CODE_MCP_SERVER_URL?.replace(/\/mcp\/?$/u, '');
      const repo = await headersRepo({
        base: BASE ?? (server?.startsWith('http') ? server : null),
        token,
        named: opts.repo ?? setting('REPO'),
        remote,
        fetch,
      });
      // Standard output is Claude Code's, and only the headers go there: never --json's wrapping, never a line of text.
      console.log(JSON.stringify(mcpHeaders({ token, named, agent: name, repo })));
      return;
    }
    const tokenVar = envName('TOKEN');
    const config = mcpConfig({ url: BASE, agent: name, repo: slug, tokenVar });
    if (!opts.check) {
      print(config, () => mcpLines(config, { repo: slug, tokenVar }).join('\n'));
      return;
    }
    const checked = await checkMcp({
      endpoint: config.endpoint,
      token: setting('TOKEN'),
      agent: name,
      repo: slug,
      fetch,
    });
    print(checked, (c) => c.lines.join('\n'));
    if (!checked.ok) process.exitCode = 1;
  },
  async health() {
    const settings = settingSources();
    print({ ...(await call('GET', 'health')), settings }, (h) =>
      [
        h.ok ? 'The task server is healthy.' : `The task server can't read its history: ${h.replicaError}`,
        `  ${h.tasks.pending} open of ${h.tasks.total} tasks, ${h.versions} versions`,
        `  snapshot: ${h.snapshot ? `${h.snapshot.created.slice(0, 16)}, ${h.snapshot.versionsSince} versions since` : 'none'}`,
        `  settings: ${describeSources(settings)}`,
      ].join('\n'),
    );
  },
  /** Every connection with its state and, for each that isn't working, the fix (IDEA-14). Read only. */
  async connections() {
    const STATE = { working: 'Working', attention: 'Needs attention', off: 'Not connected' };
    // A routine's row says whether a session it started has reported back (BRK-142).
    const READING = { verified: 'Verified', unverified: 'Not verified yet' };
    const GROUP = {
      repos: 'Repositories',
      cloudflare: 'Cloudflare',
      github: 'GitHub',
      claude: 'Claude',
      taskwarrior: 'Taskwarrior',
      push: 'Push',
    };
    print(await call('GET', 'connections'), (d) => {
      const out = [
        d.attention
          ? `${d.attention} connection${d.attention === 1 ? ' needs' : 's need'} you.`
          : 'Every connection is working.',
        `GitHub last checked: ${d.checked ? `${d.checked.slice(0, 16).replace('T', ' ')} UTC` : 'not yet (Check now on the board, or the hourly cron)'}`,
      ];
      // A fresh install's steps, in order (CLD-131); none on an install from before repositories.
      if (d.setup && !d.setup.done)
        out.push(
          '',
          'Set up the board',
          ...d.setup.steps.map((s, i) => `  ${i + 1}. ${s.done ? 'Done ' : 'To do'}  ${s.name}`),
        );
      let group = null;
      for (const c of d.connections) {
        if (c.group !== group) {
          group = c.group;
          out.push('', GROUP[group] ?? group);
        }
        const when = c.at ? ` (${c.at.slice(0, 16).replace('T', ' ')})` : '';
        out.push(`  ${(READING[c.reading] ?? STATE[c.state] ?? c.state).padEnd(16)} ${c.name}: ${c.detail}${when}`);
        if (c.fix) out.push(`  ${''.padEnd(16)} Fix: ${c.fix}`);
        if (c.fix && c.link) out.push(`  ${''.padEnd(16)} ${c.link}`);
      }
      if (d.cannotCheck?.length)
        out.push('', 'Not checked (the board can’t see these)', ...d.cannotCheck.map((x) => `  ${x.name}: ${x.why}`));
      return out.join('\n');
    });
  },
  async setup() {
    ensureSupportedSystem('setup');
    const clientId = setting('CLIENT_ID');
    const secret = setting('SECRET');
    if (!clientId || !secret)
      fail(
        `no sync credentials. Put ${envName('CLIENT_ID')} and ${envName('SECRET')} in ${ENV_FILE} (ask the owner), then run this again.`,
      );
    const registry = await call('GET', 'repos', undefined, { soft: true });
    writePrivate(
      TASKRC_FILE,
      machineTaskrc(
        `# Written by npx breakaway setup. Keep private.\nsync.server.client_id=${clientId}\nsync.encryption_secret=${secret}\n`,
        (registry?.repos ?? []).map((r) => r.slug),
        readFileSync(sharedFile('taskrc'), 'utf8'),
        registry?.repos?.find((r) => r.isDefault)?.slug,
      ),
    );
    console.log(`Wrote ${TASKRC_FILE}, with a report and context for each repository on the board.`);
    const fixes = taskrcFixes(readOptional(join(REPO, '.taskrc')), {
      url: BASE,
      include: tildePath(TASKRC_FILE, homedir()),
      file: TASKRC_FILE,
    });
    // Syncing a replica with another board's server would leave it unable to come back (CLD-195), so stop here.
    if (fixes.length) fail(`${fixes.join('\n')}\nThen run npx breakaway setup again (docs/tasks.md#another-install).`);
    const version = spawnSync('task', ['--version'], { encoding: 'utf8' });
    if (version.status !== 0) {
      console.log(
        "Taskwarrior isn't installed here; npx breakaway works without it. To add it: https://taskwarrior.org/download/",
      );
      return;
    }
    if (Number(version.stdout.trim().split('.')[0]) < 3)
      fail(`Taskwarrior ${version.stdout.trim()} is too old; sync needs 3.0 or newer.`);
    execFileSync(join(REPO, 'scripts', 'task'), ['sync'], { stdio: 'inherit' });
    console.log('\nTaskwarrior is synced. Try: scripts/task board   (or plain `task board` with direnv)');
  },
  /**
   * Owner: new client ID and sync secret. The server re-encrypts its whole history under the new
   * key in one step and keeps every version ID, so replicas carry on once they have the new
   * values. The new values are saved before the server switches, so they can't be lost. The old
   * secret isn't needed: the server re-encrypts with the key it holds, so this is also how an
   * owner who lost the secret everywhere gets Taskwarrior sync back (CLI-5).
   */
  async 'rotate-sync'() {
    ensureSupportedSystem('rotate-sync');
    const env = readEnvFile();
    if (!readSetting('SECRET', { file: env }))
      console.log(
        `${ENV_FILE} has no sync secret. That's fine: the board re-encrypts its history with the key it holds, and this writes new values.`,
      );
    const health = await call('GET', 'health');
    if (!health.ok) fail(`the server can't read its history (${health.replicaError}); fix that first (docs/tasks.md).`);
    await ensureBoardInstall('rotate-sync', health);
    const next = { ...env, ...newSyncCredentials() };
    writePrivate(`${ENV_FILE}.next`, envFile(next));
    const result = await call('POST', 'admin/rekey', {
      clientId: next[envName('CLIENT_ID')],
      key: next[envName('SYNC_KEY')],
    });
    promoteEnvFile();
    console.log(
      `Re-encrypted ${result.versions} versions${result.snapshot ? ' and the snapshot' : ''}. The old client ID is refused from now on.`,
    );
    const stored = updateSecretsStore({
      CLIENT_ID: next[envName('CLIENT_ID')],
      SYNC_KEY: next[envName('SYNC_KEY')],
    });
    Object.assign(process.env, next);
    await commands.setup();
    console.log(
      [
        '',
        stored
          ? 'The Secrets Store has the new values.'
          : 'The server uses the new values already; put them in the Secrets Store when you can (docs/tasks.md#secrets).',
        'On every other machine: copy the new tasks.env and run npx breakaway setup. Cloud agents only use the token, so they need nothing.',
        'Update the copy in your password manager.',
      ].join('\n'),
    );
  },
  /**
   * Owner: a new API token. Every browser is signed out; cloud environments need the new one. With the
   * old token lost, or refused, the board can't say which install it is, so the owner confirms the
   * one the checkout's config names (CLI-5): --worker <name>, or typed when asked.
   */
  async 'rotate-token'() {
    ensureSupportedSystem('rotate-token');
    const old = setting('TOKEN');
    let res;
    try {
      res = await fetch(`${BASE}/api/health`, { headers: old ? { Authorization: `Bearer ${old}` } : {} });
    } catch (error) {
      fail(`can't reach ${BASE} (${reasonOf(error)}), so nothing was changed.`);
    }
    if (res.status === 401) await confirmUnverifiedInstall(Boolean(old));
    else if (!res.ok) fail(`the board answered HTTP ${res.status} to health, so nothing was changed.`);
    else await ensureBoardInstall('rotate-token', await res.json());
    const env = readEnvFile();
    const token = randomBytes(32).toString('base64url');
    writePrivate(`${ENV_FILE}.next`, envFile({ ...env, [envName('TOKEN')]: token }));
    if (!updateSecretsStore({ API_TOKEN: token })) {
      fail(`couldn't update the Secrets Store, so nothing changed (the new token is in ${ENV_FILE}.next; delete it).`);
    }
    promoteEnvFile();
    process.env[envName('TOKEN')] = token;
    for (let i = 0; i < 30; i += 1) {
      const res = await fetch(`${BASE}/api/session`, { headers: { Authorization: `Bearer ${token}` } }).catch(
        () => null,
      );
      if (res?.status === 200) {
        console.log(
          'The new token works. Every browser is signed out; update the board’s token in cloud environments and your password manager.',
        );
        return;
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
    fail(
      `${tokenTarget(installConfig())} has the new token, but the server doesn't accept it yet. Try npx breakaway health in a minute.`,
    );
  },
  /** Owner, once for a new board: fresh credentials in tasks.env (the Secrets Store comes next). */
  /**
   * Owner, once per repository: its routine's /fire URL and token (asked for here, never on a command line).
   * The default repository's go in its two secrets, as always; `--repo <slug>` puts another's in
   * the install's ROUTINES secret (BREAKAWAY_ROUTINES with breakaway's prefix), JSON keyed by slug, merged with this machine's copy of the others.
   */
  async 'agents-connect'() {
    ensureSupportedSystem('agents-connect');
    const { repos, default: fallback } = await call('GET', 'repos');
    const slug = opts.repo ? String(opts.repo).toLowerCase() : fallback;
    if (!repos.some((r) => r.slug === slug)) fail(unknownRepo(slug, repos));
    await ensureBoardInstall('agents-connect');
    if (!process.stdin.isTTY) fail(NO_TERMINAL);
    const others = slug !== fallback ? await heldRoutines(fallback, slug, 'storing this one') : null;
    const { createInterface } = await import('node:readline');
    // Fails clearly without a terminal (Claude Code's ! prefix, a pipe) instead of hanging (CLD-191).
    const ask = (question, hidden = false) =>
      askIn(question, { hidden, input: process.stdin, output: process.stdout, createInterface }).catch((error) =>
        fail(error.message),
      );
    const url = await ask(`${slug}'s routine URL (https://api.anthropic.com/v1/claude_code/routines/trig_…/fire): `);
    if (!/^https:\/\/api\.anthropic\.com\/v1\/claude_code\/routines\/trig_\w+\/fire$/u.test(url))
      fail("that isn't a routine /fire URL; copy it from the routine's API trigger.");
    const token = await ask('Routine token (sk-ant-oat01-…, not shown): ', true);
    if (!/^sk-ant-oat01-[\w-]+$/u.test(token))
      fail("that isn't a routine token; generate one in the routine's API trigger.");
    if (!others) {
      if (!updateSecretsStore({ ROUTINE_URL: url, ROUTINE_TOKEN: token }))
        fail("couldn't update the Secrets Store (the reason is above), so the routine isn't connected.");
    } else {
      const next = { ...others, [slug]: { url, token } };
      if (!updateSecretsStore({ ROUTINES: JSON.stringify(next) }))
        fail("couldn't update the Secrets Store (the reason is above), so the routine isn't connected.");
      writePrivate(ROUTINES_FILE, `${JSON.stringify(next, null, 2)}\n`);
    }
    console.log(
      `Stored. The board can start agents in ${slug} within a minute (the Secrets Store takes a moment). Check with: npx breakaway agents${
        others ? `\nThis machine's copy of the other repositories' routines is ${ROUTINES_FILE}; keep it private.` : ''
      }`,
    );
  },
  /**
   * Owner, once: after GitHub created the App (from the board's GitHub view), trade the code for
   * the App's ID, key, and webhook secret, and pipe them into the Secrets Store.
   */
  async 'github-connect'() {
    ensureSupportedSystem('github-connect');
    const code = need(args[0], 'code');
    // Before the code is traded: it works once, and the keys it gives have to go into the board's own secrets.
    await ensureBoardInstall('github-connect');
    // Each code comes from a new App: on a board that has one, it would replace the working App's keys (CLI-2).
    const inPlace = appInPlace(await call('GET', 'connections', undefined, { soft: true }), {
      replace: Boolean(opts.replace),
    });
    if (!inPlace.ok) fail(inPlace.message);
    if (inPlace.note) console.log(inPlace.note);
    const res = await fetch(`https://api.github.com/app-manifests/${enc(code)}/conversions`, {
      method: 'POST',
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': installConfig().worker,
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });
    /** @type {any} */
    const app = await res.json().catch(() => ({}));
    if (!res.ok)
      fail(
        `GitHub said ${res.status}${app.message ? `: ${app.message}` : ''}. A code works once, within an hour; start again from the GitHub view.`,
      );
    // One line of base64 (PKCS#8 DER): the Secrets Store takes the value from stdin as one line.
    const key = createPrivateKey(app.pem).export({ type: 'pkcs8', format: 'der' }).toString('base64');
    const stored = updateSecretsStore({
      GITHUB_APP_ID: String(app.id),
      GITHUB_KEY: key,
      GITHUB_WEBHOOK_SECRET: app.webhook_secret,
    });
    if (!stored) {
      const backup = join(CONFIG_DIR, 'github-app.json');
      writePrivate(
        backup,
        JSON.stringify({ id: app.id, slug: app.slug, key, webhookSecret: app.webhook_secret }, null, 2),
      );
      fail(
        `the App exists (${app.html_url}), but its keys couldn't go into the Secrets Store. They're in ${backup} (0600); put them in by hand (docs/tasks.md#github), then delete that file.`,
      );
    }
    console.log(
      [
        `Created the GitHub App "${app.name}" and stored its keys in the Secrets Store.`,
        '',
        `Last step: install it on ${/** @type {any} */ (installConfig()).repository ?? 'your repository'} ("Only select repositories", then that one):`,
        `  ${app.html_url}/installations/new`,
        '',
        'The board syncs within seconds of the install. Check with: npx breakaway github --sync',
      ].join('\n'),
    );
  },
  async 'init-secrets'() {
    if (existsSync(ENV_FILE) && !opts.force)
      fail(`${ENV_FILE} already exists. To change credentials on a running board, use rotate-sync or rotate-token.`);
    const install = installConfig();
    // A new install has no address until it's deployed (CLD-139).
    const known = BOARD.from !== 'default' || install.url !== null;
    // --force never loses the only copy of the sync secret: the old file is kept the way rotations keep it (CLI-2).
    const kept = backupEnvFile();
    if (kept) console.log(`Kept the old one as ${kept} (0600).`);
    writePrivate(
      ENV_FILE,
      envFile({
        ...(known ? { [envName('URL')]: BASE } : {}),
        [envName('TOKEN')]: randomBytes(32).toString('base64url'),
        ...newSyncCredentials(),
      }),
    );
    const keep = keepLines({
      envFile: tildePath(ENV_FILE, homedir()),
      routinesFile: tildePath(ROUTINES_FILE, homedir()),
      githubFile: tildePath(join(CONFIG_DIR, 'github-app.json'), homedir()),
    });
    if (install.secretsStore) {
      console.log(
        [
          `Wrote ${ENV_FILE} (0600). Next: put the values in the Secrets Store (docs/tasks.md#secrets).`,
          '',
          ...keep,
        ].join('\n'),
      );
      return;
    }
    console.log(
      [
        `Wrote ${ENV_FILE} (0600).`,
        '',
        ...keep,
        '',
        'Next, deploy the board (docs/tasks.md#deploy-to-cloudflare) with three of its values as secrets:',
        `  TASKS_API_TOKEN  is ${envName('TOKEN')}`,
        `  TASKS_CLIENT_ID  is ${envName('CLIENT_ID')}`,
        `  TASKS_SYNC_KEY   is ${envName('SYNC_KEY')}`,
        ...(known ? [] : ['', `Once it's deployed, add its address to that file: ${envName('URL')}=https://…`]),
      ].join('\n'),
    );
  },
};

// ---- repositories ------------------------------------------------------------------------

/** A repository the board doesn't have, and how one gets there (CLD-191). */
function unknownRepo(slug, repos) {
  return `no repository "${String(slug).slice(0, 40)}"; registered: ${repos.map((r) => r.slug).join(', ') || 'none'}. The owner registers one with npx breakaway repos add <slug> <owner/name> --area <project:PREFIX>.`;
}

/**
 * This machine's copy of the other repositories' routines (the install's ROUTINES secret), checked against the
 * board: writing the secret from a copy that lacks one the board has would drop it, so that fails unless
 * --replace. `slug` is the repository being changed; `doing` says what, for the message.
 */
async function heldRoutines(fallback, slug, doing) {
  const held = existsSync(ROUTINES_FILE) ? JSON.parse(readFileSync(ROUTINES_FILE, 'utf8')) : {};
  const connected = ((await call('GET', 'agents')).repos ?? [])
    .filter((r) => r.connected && r.slug !== fallback && r.slug !== slug && !held[r.slug])
    .map((r) => r.slug);
  if (connected.length && !opts.replace)
    fail(
      `the board has routines for ${connected.join(', ')} that ${ROUTINES_FILE} doesn't hold, so ${doing} would drop them. Copy that file from the machine that connected them, or run again with --replace and connect them again afterwards.`,
    );
  return held;
}

/** The name of the branch repos init opens its pull request from, when the repository has commits. */
const INIT_BRANCH = 'tasks-board-init';
/** …and repos init --update's (CLD-193). */
const UPDATE_BRANCH = 'tasks-board-update';

/**
 * This machine's taskrc gets a report and context for each registered repository (CLD-193), so task <slug>
 * works in any checkout without a commit to the shared taskrc. Only where npx breakaway setup has
 * written it: it holds the sync credentials too.
 */
async function refreshMachineTaskrc() {
  if (!existsSync(TASKRC_FILE)) return;
  const registry = await call('GET', 'repos', undefined, { soft: true });
  if (!registry) return;
  const current = readFileSync(TASKRC_FILE, 'utf8');
  const next = machineTaskrc(
    current,
    registry.repos.map((r) => r.slug),
    readFileSync(sharedFile('taskrc'), 'utf8'),
    registry.repos.find((r) => r.isDefault)?.slug,
  );
  if (next === current) return;
  writePrivate(TASKRC_FILE, next);
  if (!opts.json) console.log(`Refreshed the repositories' Taskwarrior reports and contexts in ${TASKRC_FILE}.`);
}

/**
 * repos init (CLD-191): clone the registered repository `slug` (or use the checkout at --dir), add the files
 * the board's agents need (src/init.js says which; nothing that's there is overwritten), and push
 * them: the first commit on the default branch of an empty repository, or a pull request otherwise.
 */
async function initRepo(slug) {
  const registry = await call('GET', 'repos');
  const repo = registry.repos.find((r) => r.slug === String(slug).toLowerCase());
  if (!repo) fail(unknownRepo(slug, registry.repos));
  const flows = Boolean(opts.pipeline || opts.package);
  if (flows && opts.update)
    fail(
      '--pipeline and --package add the deploy and release flows to a repository that has none. To refresh rendered ones, run npx breakaway pipeline init --update in its checkout.',
    );
  const dir = resolve(opts.dir ?? join(dirname(REPO), repo.slug));
  const git = (...a) =>
    execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const tryGit = (...a) => {
    try {
      return git(...a);
    } catch {
      return null;
    }
  };
  if (!existsSync(dir)) {
    console.log(`Cloning ${repo.github} into ${dir}`);
    const cloned = spawnSync('git', ['clone', `https://github.com/${repo.github}.git`, dir], { stdio: 'inherit' });
    if (cloned.status !== 0)
      fail(
        `couldn't clone ${repo.github}. Check you can (git clone https://github.com/${repo.github}.git), or pass --dir <a checkout of it>.`,
      );
  }
  const remote = tryGit('remote', 'get-url', 'origin');
  if (githubFromRemote(remote)?.toLowerCase() !== repo.github.toLowerCase())
    fail(
      `${dir} isn't a checkout of ${repo.github} (its origin is ${remote || 'missing'}). Pass --dir <a checkout of it>, or a folder that doesn't exist yet.`,
    );
  if (tryGit('status', '--porcelain')) fail(`${dir} has uncommitted changes: commit or stash them first.`);
  const branch = repo.defaultBranch || 'main';
  const heads = tryGit('ls-remote', '--heads', 'origin');
  if (heads === null) fail(`couldn't reach ${repo.github} from ${dir} (git ls-remote).`);
  const empty = heads === '';
  const update = Boolean(opts.update);
  const work = update ? UPDATE_BRANCH : INIT_BRANCH;
  if (empty && update)
    fail(`${repo.github} has no commits yet: set it up first with npx breakaway repos init ${repo.slug}.`);
  if (empty) {
    if (tryGit('rev-parse', '--verify', '-q', 'HEAD'))
      fail(`${repo.github} has no commits on GitHub, but ${dir} has some: push them, or use a fresh folder.`);
    git('symbolic-ref', 'HEAD', `refs/heads/${branch}`);
  } else {
    git('fetch', 'origin', branch);
    git('checkout', '-B', work, `origin/${branch}`);
  }

  const readTarget = (path) => {
    const full = join(dir, path);
    try {
      return lstatSync(full).isFile() ? readFileSync(full, 'utf8') : '';
    } catch {
      return null;
    }
  };
  let board = null;
  try {
    board = githubFromRemote(
      execFileSync('git', ['-C', REPO, 'remote', 'get-url', 'origin'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }),
    );
  } catch {
    /* not a git checkout */
  }
  const answers = update || readTarget(promptPathOf(repo)) !== null ? {} : await promptAnswers();
  const plugin = !opts.copies;
  const plan = initPlan({
    plugin,
    pluginReleased: plugin ? pluginReleased() : false,
    repo,
    board: board ?? 'TheAnarchoX/breakaway',
    url: BASE,
    configDir: tildePath(CONFIG_DIR, homedir()),
    read: (path) => readFileSync(join(PKG, path), 'utf8'),
    readTarget,
    update,
    ...promptSections(answers),
  });
  // The deploy flow, the package's release flow, and a minimal CI (BRK-91): new files in the same commit.
  let starter = { files: [] };
  if (flows) {
    const { PipelineError, starterPlan } = await import('./tasks/pipeline.js');
    const workers = opts.pipeline ? await workerNames(repo.slug) : null;
    const at = join(dir, '.github', 'workflows');
    const workflows = existsSync(at)
      ? readdirSync(at)
          .filter((name) => /\.ya?ml$/u.test(name))
          .map((name) => ({ path: `.github/workflows/${name}`, text: readFileSync(join(at, name), 'utf8') }))
      : [];
    // package.json as the commit leaves it: repos init adds one when the repository has none.
    const planned = (path) => plan.files.find((f) => f.path === path && !f.link)?.content ?? readTarget(path);
    try {
      starter = starterPlan({
        branch,
        workers,
        withPackage: Boolean(opts.package),
        readTarget: planned,
        workflows,
        readTemplate: (name) => readFileSync(join(PKG, 'template', 'pipeline', name), 'utf8'),
      });
    } catch (e) {
      if (!(e instanceof PipelineError)) throw e;
      fail(e.message);
    }
    plan.files.push(...starter.files);
    plan.notes.push(...starter.notes);
    plan.todo.push(...starter.todo);
  }
  const report = [
    `${repo.github} ${empty ? 'has no commits yet' : `has commits on ${branch}`}.`,
    ...(plan.files.length
      ? [
          `${opts['dry-run'] ? 'Would add' : 'Adding'} ${plan.files.length} files:`,
          ...plan.files.map(
            (f) => `  ${f.path}${f.append ? ' (the lines it lacks)' : f.changed ? ' (newer than its copy)' : ''}`,
          ),
        ]
      : []),
    ...(plan.removals.length
      ? [
          `${opts['dry-run'] ? 'Would remove' : 'Removing'} ${plan.removals.length} files the board no longer copies here (npx breakaway${plan.plugin ? " and breakaway's plugin replace" : ' replaces'} them):`,
          ...plan.removals.map((p) => `  ${p}`),
        ]
      : []),
    ...(plan.current.length ? [`Already current: ${plan.current.length} copied files.`] : []),
    ...(plan.skipped.length
      ? [
          `${update ? "The repository's own, left as they are" : 'Already there, left as they are'}:`,
          ...plan.skipped.map((p) => `  ${p}`),
        ]
      : []),
    ...plan.notes.map((n) => `Note: ${n}`),
  ];
  console.log(report.join('\n'));
  if (!plan.files.length && !plan.removals.length) {
    console.log(
      update
        ? "Nothing to update: its copies of the board's files are current."
        : 'Nothing to add: it has every file the board needs.',
    );
    return;
  }
  // A repository's .gitignore can match a file init adds (.env* matches .envrc), and git add refuses it (BRK-41).
  const ignoredPaths = plan.files
    .filter((f) => f.path !== '.gitignore' && tryGit('check-ignore', '-q', '--', f.path) !== null)
    .map((f) => f.path);
  if (ignoredPaths.length)
    console.log(
      `Its .gitignore ignores ${ignoredPaths.join(', ')}: ${opts['dry-run'] ? 'init would add' : 'adding'} a ! line for ${ignoredPaths.length === 1 ? 'it' : 'each'} to .gitignore.`,
    );
  if (opts['dry-run']) return;

  for (const path of plan.removals) rmSync(join(dir, path), { force: true });
  for (const f of plan.files) {
    const full = join(dir, f.path);
    mkdirSync(dirname(full), { recursive: true });
    if (f.link) symlinkSync(f.link, full);
    else writeFileSync(full, f.content);
    if (f.mode) chmodSync(full, f.mode);
  }
  const staged = plan.files.map((f) => f.path);
  if (ignoredPaths.length) {
    const ignoreFile = join(dir, '.gitignore');
    const lines = ignoredPaths.map((p) => `!${p}`);
    appendFileSync(
      ignoreFile,
      `${readTarget('.gitignore')?.endsWith('\n') === false ? '\n' : ''}${lines.join('\n')}\n`,
    );
    if (!staged.includes('.gitignore')) staged.push('.gitignore');
  }
  const stillIgnored = staged.filter((p) => tryGit('check-ignore', '-q', '--', p) !== null);
  if (stillIgnored.length)
    fail(
      `${stillIgnored.join(', ')} still ignored by ${repo.github}'s .gitignore, even with a ! line (a parent folder is ignored?). Nothing was committed: un-ignore it there, then run repos init again. The files are written in ${dir}.`,
    );
  try {
    git('add', '--all', '--', ...staged, ...plan.removals);
  } catch (e) {
    fail(
      `git add failed in ${dir}: ${String(e.stderr || e.message).trim()}. Nothing was committed. Fix that, then run repos init again (it leaves what's there alone), or use git checkout ${repo.defaultBranch || 'main'} && git branch -D ${work} to start over.`,
    );
  }
  const first = initCommitMessage(repo.slug, {
    by: `npx breakaway repos init ${repo.slug}${opts.copies ? ' --copies' : ''}${opts.pipeline ? ' --pipeline' : ''}${opts.package ? ' --package' : ''}`,
    plugin: plan.plugin,
  });
  const title = update ? "Update the task board's agent files" : first.title;
  git(
    'commit',
    '-m',
    title,
    '-m',
    update
      ? `The board's core, ${plan.plugin ? '' : 'skill, '}release helpers, and Taskwarrior files as they are in ${board ?? 'breakaway'} now, ${plan.plugin ? "and breakaway's Claude Code plugin in .claude/settings.json instead of the copied tasks skill and session hooks" : 'and the session hooks run through npx'}, so an old copy of the CLI is removed: run it as npx ${CLI_PACKAGE}. This repository's own files are unchanged. Updated by npx ${CLI_PACKAGE} repos init ${repo.slug} --update${opts.copies ? ' --copies' : ''}.`
      : `${first.body}${starter.files.length ? ` It also adds the deploy and release flows, rendered from ${starter.files[0].path}.` : ''}`,
  );
  const pushed = spawnSync('git', ['-C', dir, 'push', '-u', 'origin', empty ? `HEAD:refs/heads/${branch}` : work], {
    stdio: 'inherit',
  });
  if (pushed.status !== 0) fail(`the commit is in ${dir}, but pushing it failed; push it from there.`);

  const next = [];
  if (empty) next.push(`Pushed the first commit to ${branch} on ${repo.github}.`);
  else {
    const pr = spawnSync(
      'gh',
      [
        'pr',
        'create',
        '-R',
        repo.github,
        '--head',
        work,
        '--base',
        branch,
        '--title',
        title,
        '--body',
        update
          ? `The task board's copied files (the core and stub, ${plan.plugin ? '' : 'the tasks skill, '}the release helpers, and the Taskwarrior files) as they are on the board's repository now, updated by \`npx breakaway repos init ${repo.slug} --update${opts.copies ? ' --copies' : ''}\`. ${plan.plugin ? "The tasks skill and the session hooks come from breakaway's Claude Code plugin, which .claude/settings.json turns on, so their copies are removed. " : ''}This repository's own files (its agent prompt, AGENTS.md, .taskrc, .envrc, package.json${plan.plugin ? '' : ', .claude/settings.json'}) are otherwise unchanged.${plan.notes.length ? `\n\nNotes:\n${plan.notes.map((n) => `- ${n}`).join('\n')}` : ''}`
          : `The files the task board's agents need to claim and work a task in this repository, added by \`npx breakaway repos init ${repo.slug}\`. Nothing that was there is changed. If this repository's linter reads plain JavaScript, exclude the copied scripts (tools/tasks/ and the release helpers) from it.${plan.todo.length ? `\n\nStill to do:\n${plan.todo.map((t) => `- ${t}`).join('\n')}` : ''}`,
      ],
      { encoding: 'utf8' },
    );
    next.push(
      pr.status === 0
        ? `Opened ${pr.stdout.trim()}. Merge it to give the board's agents ${update ? 'the current files' : 'their files'}.`
        : `Pushed ${work}. Open its pull request: https://github.com/${repo.github}/compare/${branch}...${work}?expand=1`,
    );
  }
  if (update) return console.log(['', ...next].join('\n'));
  next.push(
    ...plan.todo.map((t) => `To do: ${t}.`),
    `Next: make ${repo.slug}'s routine on claude.ai/code/routines with the stub from the Agents view, then npx breakaway agents-connect --repo ${repo.slug} (docs/tasks.md#adding-a-repository).`,
    `Taskwarrior there: scripts/task, or plain task after direnv allow (direnv isn't needed: scripts/task works without it).`,
  );
  console.log(['', ...next].join('\n'));
}

/**
 * Whether breakaway's plugin is out (BRK-159): its marketplace gives it out from the plugin branch, which a stable
 * release moves, so until that branch is there, repos init copies the skill and hooks instead. Null when GitHub can't
 * be reached, which repos init says, and copies too.
 */
function pluginReleased() {
  try {
    const heads = execFileSync(
      'git',
      ['ls-remote', '--heads', `https://github.com/${PLUGIN_REPO}.git`, `refs/heads/${PLUGIN_BRANCH}`],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 20_000 },
    );
    return heads.trim() !== '';
  } catch {
    return null;
  }
}

/**
 * The staging and production Workers for repos init --pipeline (BRK-91): --staging and --production, else asked in a
 * terminal, else `<slug>-staging` and `<slug>`.
 */
async function workerNames(slug) {
  const names = { staging: opts.staging, production: opts.production };
  const defaults = { staging: `${slug}-staging`, production: slug };
  const ask = !opts.defaults && !opts['dry-run'] && !opts.json && process.stdin.isTTY;
  const { createInterface } = ask ? await import('node:readline') : {};
  for (const env of /** @type {const} */ (['staging', 'production'])) {
    if (names[env] !== undefined) continue;
    if (ask) {
      console.log(`\nThe ${env} Worker's name (Enter for ${defaults[env]}):`);
      names[env] = await askIn('> ', { input: process.stdin, output: process.stdout, createInterface }).catch((error) =>
        fail(error.message),
      );
    }
    names[env] = String(names[env] ?? '').trim() || defaults[env];
  }
  return { staging: String(names.staging), production: String(names.production) };
}

/**
 * The agent prompt's sections for repos init (CLD-196), flag → text: each from its flag (--checks, --never-share, …),
 * and in a terminal, the rest asked one by one, with Enter taking the default. Without a terminal, with --defaults,
 * or with --dry-run, a section without a flag takes its default, so the prompt never goes out with a placeholder.
 */
async function promptAnswers() {
  const answers = Object.fromEntries(
    PROMPT_SECTIONS.filter((s) => opts[s.flag] !== undefined).map((s) => [s.flag, String(opts[s.flag])]),
  );
  const left = PROMPT_SECTIONS.filter((s) => !String(answers[s.flag] ?? '').trim());
  if (!left.length || opts.defaults || opts['dry-run'] || opts.json || !process.stdin.isTTY) return answers;
  const { createInterface } = await import('node:readline');
  console.log(
    "The agent prompt's sections say how agents work in this repository. Answer each in a line, or press Enter for the default (you can change any of them later in the prompt).",
  );
  for (const s of left) {
    console.log(`\n${s.heading}: ${s.ask}\n  Default: ${s.default}`);
    const answer = await askIn('> ', { input: process.stdin, output: process.stdout, createInterface }).catch((error) =>
      fail(error.message),
    );
    if (answer) answers[s.flag] = answer;
  }
  console.log('');
  return answers;
}

/**
 * repos remove (CLD-191): the board takes it off, then its routine leaves the Secrets Store and this machine's copy.
 * It ends with what's left by hand on claude.ai and GitHub (CLI-4).
 */
async function removeRepo(slug, signer) {
  const { default: fallback } = await call('GET', 'repos');
  // Dropping a routine this machine connected rewrites the ROUTINES secret: check before anything changes.
  if (existsSync(ROUTINES_FILE) && JSON.parse(readFileSync(ROUTINES_FILE, 'utf8'))[slug]) {
    ensureSupportedSystem('repos remove');
    await ensureBoardInstall('repos remove');
  }
  const res = await call('DELETE', `repos/${enc(slug)}`, { by: signer, ...(opts.force ? { force: true } : {}) });
  const lines = [
    `Took ${res.removed.slug} (${res.removed.github}) off the board. Its tasks stay, readable, and its slug and prefixes (${res.removed.areas.map((a) => a.prefix).join(', ')}) stay its own.`,
  ];
  if (res.open || res.running)
    lines.push(
      `It still had ${res.open} open task${res.open === 1 ? '' : 's'} and ${res.running} running agent${res.running === 1 ? '' : 's'}; they stay as they are.`,
    );
  if (res.routines.length) lines.push(`Switched off its saved routines: ${res.routines.join(', ')}.`);
  if (res.routine) {
    const held = existsSync(ROUTINES_FILE) ? JSON.parse(readFileSync(ROUTINES_FILE, 'utf8')) : {};
    if (!held[res.removed.slug]) {
      lines.push(
        `Its agent routine is still in ${secretName(installConfig(), 'ROUTINES')}, and ${ROUTINES_FILE} doesn't hold it: run repos remove on the machine that connected it, or connect another repository with --replace. The board doesn't use it any more.`,
      );
    } else {
      const next = await heldRoutines(fallback, res.removed.slug, 'dropping this one');
      delete next[res.removed.slug];
      if (!updateSecretsStore({ ROUTINES: JSON.stringify(next) }))
        lines.push(
          `Couldn't drop its routine from the Secrets Store (the reason is above); the board doesn't use it any more.`,
        );
      else {
        writePrivate(ROUTINES_FILE, `${JSON.stringify(next, null, 2)}\n`);
        lines.push(`Dropped its agent routine from the Secrets Store and ${ROUTINES_FILE}.`);
      }
    }
  }
  // Said whether or not the board had a routine connected: it can't delete one on claude.ai either way (CLI-4).
  const byHand = removedRepoByHand(res.removed.github);
  lines.push('', 'Left to do by hand:', ...byHand.map((step) => `  - ${step}`));
  print({ ...res, byHand }, () => lines.join('\n'));
}

// ---- credentials -------------------------------------------------------------------------

/** A client ID, a secret, and the key the Worker gets (PBKDF2 as Taskwarrior derives it). */
function newSyncCredentials() {
  const clientId = randomUUID();
  const secret = randomBytes(32).toString('base64url');
  const key = pbkdf2Sync(
    Buffer.from(secret, 'utf8'),
    Buffer.from(clientId.replaceAll('-', ''), 'hex'),
    600000,
    32,
    'sha256',
  ).toString('base64');
  return { [envName('CLIENT_ID')]: clientId, [envName('SECRET')]: secret, [envName('SYNC_KEY')]: key };
}

function envFile(values) {
  const lines = [
    `# ${installConfig().name}: the task board. Keep private (and a copy in your password manager); see docs/tasks.md.`,
  ];
  for (const key of ['URL', 'TOKEN', 'CLIENT_ID', 'SECRET'].map(envName)) {
    if (values[key]) lines.push(`${key}=${values[key]}`);
  }
  if (values[envName('SYNC_KEY')])
    lines.push(
      '# The Worker gets this derived key, never the secret itself:',
      `${envName('SYNC_KEY')}=${values[envName('SYNC_KEY')]}`,
    );
  for (const [key, value] of Object.entries(values))
    if (!lines.some((l) => l.startsWith(`${key}=`))) lines.push(`${key}=${value}`);
  return `${lines.join('\n')}\n`;
}

function writePrivate(path, content) {
  mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  writeFileSync(path, content, { mode: 0o600 });
  chmodSync(path, 0o600);
}

/** Moves tasks.env aside as tasks.env.<date>.bak (0600), and says where; null when there's none. */
function backupEnvFile() {
  if (!existsSync(ENV_FILE)) return null;
  const backup = `${ENV_FILE}.${new Date().toISOString().replace(/[:.]/gu, '-')}.bak`;
  renameSync(ENV_FILE, backup);
  chmodSync(backup, 0o600);
  return backup;
}

/** tasks.env.next becomes tasks.env; the old one is kept as tasks.env.<date>.bak. */
function promoteEnvFile() {
  backupEnvFile();
  renameSync(`${ENV_FILE}.next`, ENV_FILE);
}

/**
 * Pipes each value into `wrangler secrets-store secret update` (never on a command line). `values` are keyed by
 * the part of the secret's name after the install's prefix (`API_TOKEN` is BREAKAWAY_API_TOKEN with breakaway's prefix).
 * An install without a Secrets Store (the Deploy to Cloudflare button's, CLD-139) keeps them as Worker secrets.
 */
function updateSecretsStore(values) {
  const install = installConfig();
  if (!install.secretsStore) return updateWorkerSecrets(install, values);
  const list = spawnSync(
    'npx',
    ['wrangler', 'secrets-store', 'secret', 'list', install.secretsStore, '--remote', '--per-page', '100'],
    { cwd: REPO, encoding: 'utf8' },
  );
  if (list.status !== 0) {
    console.error(`tasks: couldn't list the Secrets Store: ${wranglerFailure(list)}`);
    return false;
  }
  const ids = Object.fromEntries(
    [...list.stdout.matchAll(/│\s*([A-Z][A-Z0-9_]*)\s*│\s*([0-9a-f]{32})\s*│/gu)].map((m) => [m[1], m[2]]),
  );
  let ok = true;
  for (const [key, value] of Object.entries(values)) {
    const name = secretName(install, key);
    if (!ids[name]) {
      console.error(`tasks: ${name} isn't in the Secrets Store`);
      ok = false;
      continue;
    }
    const res = spawnSync(
      'npx',
      ['wrangler', 'secrets-store', 'secret', 'update', install.secretsStore, '--secret-id', ids[name], '--remote'],
      { cwd: REPO, encoding: 'utf8', input: value },
    );
    if (res.status !== 0) {
      console.error(`tasks: couldn't update ${name} in the Secrets Store: ${wranglerFailure(res)}`);
      ok = false;
    }
  }
  return ok;
}

/**
 * Pipes each value into `wrangler secret put TASKS_<key>` on the install's Worker (never on a command line). Each
 * put deploys a new version of the Worker with the secret; the bindings are the same names the Secrets Store's are.
 */
function updateWorkerSecrets(install, values) {
  let ok = true;
  for (const [key, value] of Object.entries(values)) {
    const binding = `TASKS_${key}`;
    const res = spawnSync('npx', ['wrangler', 'secret', 'put', binding, '--name', install.worker], {
      cwd: REPO,
      encoding: 'utf8',
      input: value,
    });
    if (res.status !== 0) {
      console.error(`tasks: couldn't set ${binding} on the Worker ${install.worker}: ${wranglerFailure(res)}`);
      ok = false;
    }
  }
  return ok;
}

const { positional, opts } = parse(process.argv.slice(2));
const command = positional[0] === 'note' ? 'comment' : (positional[0] ?? 'list');
const args = positional.slice(1);
if (opts.help || command === 'help') {
  console.log(HELP);
} else if (command === 'install') {
  // An install repository's own steps (BRK-9): they need no board, so they run before the board's address is checked.
  await (await import('./install/cli.js')).run(args, opts);
} else if (command === 'pipeline') {
  // A repository's deploy and release workflows (BRK-90): rendered from its own config, so they need no board either.
  process.exitCode = (await import('./tasks/pipeline.js')).run(args, opts);
} else if (command === 'infra' && (args[0] === 'init' || args[0] === 'runner')) {
  // Architect's apply runner (CLI-12): init renders it from the checkout; runner is its steps, run only inside it.
  process.exitCode = await (await import('./tasks/infra.js')).run(args, opts);
} else if (!commands[command]) {
  fail(`no command "${command}". npx breakaway help lists them.`);
} else if (!BASE && command !== 'init-secrets' && command !== 'hook' && !(command === 'mcp' && opts.headers)) {
  // The hooks stay quiet without a board (a plugin installed but not set up, CLI-8): session-hook.mjs checks for itself.
  // The plugin's headersHelper never fails, and Claude Code tells it the board's address when only the plugin knows it.
  fail(
    `no board address. Set BREAKAWAY_URL (in the environment or ${ENV_FILE}), sync.server.url in this checkout's .taskrc, or the board's address in the breakaway plugin's settings (or run npx breakaway setup): see docs/tasks.md#another-install.`,
  );
} else if (unknownSubcommand(command, args[0])) {
  fail(unknownSubcommand(command, args[0]));
} else {
  if (command !== 'hook') warnHookFailure();
  await commands[command]();
}
