# IDEA-33 · Onboarding someone can finish on their own

Task: IDEA-33 on the board · Status: draft

## Problem

Someone without cloud experience should be able to install breakaway through Claude Code, finish one real task with an agent, and come back later to start another, all without asking the person who wrote breakaway. Today the install prompt ([`prompts/install.md`](../../prompts/install.md)) and the [quickstart](../../site/content/docs/quickstart.md) get a board deployed, but:

- they stop at "a first task added", so nobody sees an agent claim, report, open a pull request, and have its task closed by a merge before they're told they're done;
- an install that stops halfway has no way back in: the prompt starts from step 0 every time, and two of its steps can make a second GitHub App or overwrite the only copy of the sync secret;
- the board says **Working** for things it never tested (a routine that has never started an agent), and says nothing about things that keep failing behind the scenes (auto-start firing a refused token every tick);
- what to keep safe, and what to do when it's lost, is one line: "keep it in your password manager".

The owner wants it opinionated: sensible defaults, few choices, short instructions, and checks that run by themselves.

## Fit

- **Free, self-hosted, an install keeps its data.** Nothing here adds a service, an account, or a hosted step. Every check reads what the install already connected (Cloudflare, GitHub through its App, Claude through its routine).
- **The person who runs the board decides.** The install agent still waits for a yes before anything outside its folder, the owner still signs in, makes tokens, presses Start, and merges. The first real task is the owner's to approve and merge. No check fires a Claude start on its own: a routine is verified by its first real agent run (decision 4).
- **The architecture stays.** The Worker orchestrates; agents run on claude.ai and are started through each repository's authenticated API trigger. No new provider, no configuration framework.
- **Kickoff ([IDEA-26](IDEA-26-kickoff.md)) is the other way in.** Kickoff starts from a working board and gets a new repository going from the board; this spec is the part before that (the install) and the parts both share (the first agent run, recovery). It reuses Kickoff's routine form (`WEB-38`) and kickoff mode (`BRK-134`) rather than repeating them, and assumes neither has shipped.

## What's there today

From reading the code and docs on 4 Oct 2026. **Handled** is behaviour that already works; **gap** is confirmed in the code; **rehearse** can only be settled by a real person on a real account.

| Area | Handled | Gap | Rehearse |
| --- | --- | --- | --- |
| Re-running steps | `install init` and `repos init` never overwrite a file; `init-secrets` refuses when `tasks.env` exists; `repos add` refuses a registered slug; `agents-connect --repo` keeps other repositories' routines; Deploy's `check` refuses a changed `worker` or `store` when it has the running config | `init-secrets --force` overwrites the only sync secret with no backup; `github-connect` overwrites the App's keys and, with a new code, makes a second App; a manual Deploy dispatch or a new `--worker` meets "worker does not exist", counts it as a first deploy, and makes a new, empty board; the prompt never looks for what already exists | How far a real interrupted install gets on its own |
| Platforms | Node 20+ is checked | The secret-writing commands spawn `npx` without a shell, which fails on Windows with "is wrangler logged in?"; the prompt's `v() { sed … }` and `&&` are POSIX-only; `setup` runs a `#!/bin/sh` script | Which of macOS, Linux, WSL, and PowerShell a newcomer actually uses |
| First deploy | Deploy dry-runs, then deploys, then checks `/api/ping` and rolls back on failure | With an address in the config, the first deploy checks before the prompt has put the secrets on, so it likely fails "Failed its check" | Confirm that failure on a custom domain |
| Checks | Connections tests the GitHub App, installation, permissions, auto-merge, webhooks, sync, secret bindings, cron, push, and the agent prompt's placeholders, and lists what it can't check | A routine that has never started anything reads **Working** ("no start recorded yet"); nothing records that a session's environment (allowed host, credential, agent name, stub) actually worked | Whether "Needs attention" fixes are followed without help |
| The first run | The **Add a repository** wizard ticks started, live output, pull request, and merged | Neither the install prompt nor **Set up the board** sends the owner there; **Set up the board** only finishes after a Taskwarrior sync, which is optional; the wizard's agent step has no Start button, and a failed start shows only the Connections row | Whether "done" is understood as "an agent's pull request merged" |
| Run states | Starting, Working, Quiet, Waiting to start (with the reason), Recent starts with the error, chase's Needs you and Stuck, pings | A task whose start failed shows nothing; auto-start and chase re-fire a refused token every tick, spending the hourly budget; a 429's `Retry-After` is only text; a 403 or 404 from Claude gets the generic message and fix; a session that goes silent keeps its slot for 12 hours with no ping; Fix with an agent outside a chase has no attempt cap | Whether the states read clearly to someone new |
| Keeping secrets | "Keep `tasks.env` in your password manager"; rotations keep a `.bak`; `export` and Cloudflare's 30-day recovery for tasks | Nothing says everything to keep (`tasks.env`, `tasks-routines.json`, a fallback `github-app.json`), nor what's lost without each, nor what to do when one is gone | Whether the owner actually saved them |

## Design

### The journey

The install agent works through the same steps as today, with four changes:

1. **Start by looking.** Before asking anything, it checks what's there, in this order, and says what it found in one short list: `tasks.env`, an install repository (a `breakaway.config.json` in this folder or the one they name), the Worker (`wrangler deployments list --name <worker>`), `health`, `repos`, and `connections --json`. It carries on from the first step that isn't done and never repeats one that is. When something exists but doesn't match (a Worker with another name, a `tasks.env` for another address), it stops and asks; it never makes a second one.
2. **Each outside step names the place, the action, and what they should see.** For Cloudflare, GitHub, and claude.ai: the exact page (a link where one exists), what to press or type, and what the page shows when it worked. The routine step is a checklist with one line each for the repository, the instructions (the stub), the allowed host, the API credential, `BREAKAWAY_AGENT`, and the API trigger, since Connections can't read claude.ai.
3. **Every check reads one of three ways.** **Verified** (the board or a command tested it), **Not verified yet** (set up, but nothing has used it; says what will verify it), or **Failed** (says what failed and the fix). The agent never says a step is done when it's only Not verified yet.
4. **It ends with one real task, not a deployed Worker.** The agent proposes one small, useful task from the repository (it reads the README and the open issues), with a done when the owner can check in a few minutes, and adds it only after a yes. With routines, the owner presses Start on the board and watches the **Add a repository** wizard's agent step tick: started, live output, pull request, then merged after the owner reviews and merges it, and the task closes. Without routines, the prompt says plainly what they give up (starting agents from the board, live output, auto-start, chase), and the same task is claimed and finished from a local Claude Code session through the CLI. Either way, the install is done when that task is closed by its merged pull request.

Before it stops, the agent asks the owner to confirm they've saved what's listed under "Keeping secrets" below, and says how to get back in: open Claude Code in the same folder and paste the same line; it will look first.

### On the board

- **Set up the board** counts the CLI (any authenticated call, not only a Taskwarrior sync), keeps Taskwarrior as an optional line, and ends with **A first agent's pull request merged** (with routines) or **A first task closed** (without), using the wizard's facts so the two always agree. Its last step opens the wizard's agent step.
- **The wizard's agent step** gets a **Start** button for the task it found, and when the start fails it says why in the step, with the fix and **Try again**, instead of only pointing to Connections. The empty board on a fresh install points to **Set up the board**.
- **Connections** uses the three readings above. A routine that has never started anything reads **Not verified yet: start an agent on a task to verify it**. A session's first `claim` reports what it can see about its own environment (it reached the board, whether the token came from the credential or a variable, whether `BREAKAWAY_AGENT` is set, and whether its stub matches the board's), never the token itself, and the routine's row then reads **Verified by <task>, <time>**.

### When an agent run goes wrong

A task's Agent section and the Agents view say, for every run, which of these it is, what happens next, and what the owner does, if anything:

| State | When | Says | Next |
| --- | --- | --- | --- |
| Starting | Fired, not yet claimed | Starting | Nothing to do; over 10 minutes, open the session |
| Working / Quiet | Claimed, output in the last 2 minutes / not | As today | Nothing to do |
| Silent | Claimed, nothing for 30 minutes (decision 2) | Silent since <time>; the claim and its slot are kept | Open the session and decide; one ping |
| Waiting to start | Queued | The reason, as today | Starts by itself when the reason clears |
| Retrying | A start refused with 429 | Claude's limit; tries again at <time> from `Retry-After` | Nothing to do |
| Paused | A start refused with 401, 403, or 404 | The routine's token was refused / the routine is gone / no access | Reconnect the routine; starts resume once it's verified |
| Couldn't start | Any other failure | The error, in plain words | **Try again** |
| Needs you | Two fix agents on one pull request didn't get it green (decision 3), or a ping | What was tried; no third fix starts | The owner's call; one ping |

Auto-start and chase stop firing a repository's routine while it's Paused, so a refused token no longer spends the hourly budget, and wait for `Retry-After` after a 429. Claude's 403 and 404 get their own message and fix. Fix with an agent counts earlier fix runs on the same pull request, the way chase already does.

### Checking the first result

The first task's done when is written to be checked by the owner in a few minutes. The same goes further: an idea's spec and the first tasks a kickoff writes each end with **How to check it**, a few steps someone non-technical can follow, and an agent's pull request description says how to check it in the same words. That's a line in the core's "Shaping an idea" and "Kicking off a project" sections, reusing what's there.

### Keeping secrets

One list, in the install prompt, the quickstart, and the operations docs, of what to keep in a password manager and what each one costs to lose:

- `~/.config/breakaway/tasks.env`: the token, the sync client ID and secret. The secret is the only copy.
- `tasks-routines.json`, when there is one: the only copy of other repositories' routines.
- `github-app.json`, if `github-connect` fell back to it.

And what to do when one is lost, as steps, worked out from what the code allows (a new token with `rotate-token`; a lost sync secret, which the Worker holds but can't give back; a lost routine token, which is regenerated on claude.ai and connected again). `init-secrets --force` keeps the old file as a `.bak` the way rotations do.

### Platforms

The install supports macOS, Linux, and Windows through WSL (decision 1): one set of POSIX shell commands, nothing in PowerShell. The prompt checks the system at step 0; on native Windows it says so plainly, points to installing WSL, and carries on inside it. The CLI's secret-writing commands and `setup` stop up front on native Windows with the same advice, and on a supported system report the real error when wrangler can't run.

## Privacy

Nothing new leaves the install. A session's environment report holds yes/no facts and the stub's version, never a token or a value; it's stored on the board like a connection's state. The install agent reads `tasks.env` only to check it exists and which address it's for, and never prints a value, as today.

## Out of scope

- A hosted installer, an account, or anything that runs outside the owner's Cloudflare, GitHub, and Claude.
- Making the claude.ai routine for the owner: claude.ai offers no way to.
- A new configuration format or wizard framework; the install prompt, Connections, and the existing wizard carry it.
- A backup service, or the board storing secrets beyond what `BRK-133` already keeps.
- New agent providers.
- Kickoff itself (IDEA-26).

## Decisions

The owner answered these on the board, as `BRK-140`, on 4 Oct 2026:

1. **Systems.** macOS, Linux, and Windows through WSL. Native PowerShell is not supported; Windows users install WSL first.
2. **A silent session.** After 30 minutes with nothing, the board marks it Silent and pings the owner once. It keeps the claim and the slot; the owner opens the session and decides.
3. **Repeated fixes.** Yes: after two fix agents on one pull request haven't got it green, the board marks it Needs you and pings once instead of starting a third, the way chase does.
4. **Verifying a routine.** By the first real agent run. No **Test the routine** button: a routine reads Not verified yet until an agent claims a task, then Verified.

## Done when

- Someone who has never seen breakaway installs it from the one line, on their own, finishes one real task end to end (start, claim, live output, pull request, checks, their merge, the task closed), stops halfway through a second install attempt and resumes it without duplicates, and comes back another day to start another task. The rehearsal records where they needed help or thought they were done too early.
- Nothing above is claimed from mocks alone: the rehearsal is on a real account.

Tasks, in the `onboarding-hardening` feature, all waiting for this spec (IDEA-33) to merge:

| Task | What | Waits for |
| --- | --- | --- |
| `BRK-140` | Decide the four questions above (owner; answered) | IDEA-33 |
| `CLI-2` | Install commands never overwrite what's there: `init-secrets --force` keeps a backup, `github-connect` refuses a second App | IDEA-33, `BRK-95` |
| `CLI-3` | Secret-writing commands work on the systems the install supports | IDEA-33, `BRK-140`, `CLI-2` |
| `BRK-141` | Deploy never makes a second, empty board, and a first deploy on a custom domain passes its check | IDEA-33 |
| `BRK-142` | Connections says Verified, Not verified yet, or Failed, and a session's first claim verifies its routine | IDEA-33, `BRK-140` |
| `BRK-143` | Set up the board counts the CLI, keeps Taskwarrior optional, and ends with a first closed task | IDEA-33 |
| `WEB-40` | Set up the board, the empty board, and the wizard's agent step lead to a first merged pull request | IDEA-33, `BRK-143`, `WEB-38` |
| `BRK-144` | Auto-start and chase pause a routine Claude refuses, and wait out Claude's limit | IDEA-33, `BRK-139` |
| `BRK-145` | Silent sessions and repeated fix attempts reach the owner | IDEA-33, `BRK-140`, `BRK-139`, `BRK-144` |
| `WEB-41` | A task and the Agents view say what a run is doing, what happens next, and what to do | IDEA-33, `BRK-144`, `BRK-145` |
| `BRK-146` | Specs and first tasks say how to check the result | IDEA-33, `BRK-134` |
| `DOC-22` | What to keep, and what to do when it's lost | IDEA-33, `CLI-2` |
| `DOC-23` | The install prompt looks first, guides each outside step, and ends with a closed task | IDEA-33, `BRK-140`, `CLI-2`, `CLI-3`, `BRK-141`, `BRK-142`, `WEB-40` |
| `DOC-24` | The quickstart, self-hosting, operations, and agents docs match | IDEA-33, `BRK-143`, `DOC-22`, `DOC-23`, `WEB-41` |
| `BRK-147` | Rehearse onboarding with someone new, without coaching (owner) | IDEA-33, `DOC-23`, `DOC-24`, `WEB-40`, `WEB-41`, `BRK-145`, `BRK-146` |
