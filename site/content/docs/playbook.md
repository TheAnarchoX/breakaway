---
title: The playbook
description: How to get the most out of a board: write tasks agents finish, shape work before you build it, run many agents without collisions, and keep the review load down to one person.
---

This page is advice, not features. It’s what makes the difference between agents that open pull requests you merge and agents that open pull requests you rewrite. Everything here uses features documented elsewhere in these docs.

## Write tasks one pull request can finish

An agent works best on a task that fits one pull request. If you can’t say what done looks like, the agent can’t either.

- **Give every task a brief and a done-when.** The brief says what and why. The done-when says what has to be true to call it done, and the agent checks its pull request against it.
- **One outcome per task.** If the brief has an “and” joining two outcomes, make two tasks and add a `depends` where one waits.
- **Name the files and the behaviour you care about,** not the steps. “The inbox sorts by age; the oldest ping is first” beats “edit `Inbox.jsx`”.
- **Put the checks in the repository,** not in the task. The agent follows the repository’s **Checks** (see below), so a task never has to say “and run the tests”.
- **Tag honestly.** `+agent` for work an agent can do in the repository, `+owner` for production, accounts, and sign-offs, and `+decide` when you have to choose first. An agent never starts a `+decide` task.

```sh
npx breakaway add "Sort the inbox by age" --project web --tag agent --horizon now \
  --brief "The inbox lists pings in the order they arrived. The oldest should be first, so nothing waits unseen." \
  --done-when "The inbox shows the oldest open ping first, in both themes, narrow and wide."
```

## Write down ideas, shape them, then build

When you don’t know the task yet, write an **idea** (`i` on the board, or `npx breakaway idea "…"`). An agent turns it into a spec and a set of filled-in tasks in one pull request. You read one spec instead of ten tasks, and nothing is built until you merge it. [Ideas, decisions, and pings](/docs/ideas-decisions-pings/) has the details.

Use a spec for any change with real choices: a protocol, a data model, a flow people will use. Specs live in `docs/specs/<ID>-<slug>.md` with the problem, what was chosen and why, what’s out of scope, open questions, and done when.

## Ask for decisions as questions

If an agent needs your choice, it asks a structured **decision**: a form with up to 20 questions of seven types, and a recommendation in the help text. You answer them in one sitting, and the answer finishes the task and releases everything waiting on it. Prefer this to prose in a comment, which nobody answers in order.

## Give each repository an agent prompt that says how to build

An agent gets its instructions from two places in the repository it works in: its **agent prompt** and its **`AGENTS.md`**. The prompt starts from the board’s shared core and says, under fixed headings, what each step means in your repository:

| Heading | Say |
| --- | --- |
| **Checks** | The commands that must pass before a pull request: tests, build, lint. |
| **Pull requests** | How titles and descriptions look, and what the description must hold. |
| **Direction** | What the project is and isn’t; what needs your decision first. |
| **Building** | How to build here: where tests go, conventions, which skills to use. |
| **Dependency updates** | What extra to run when an update touches certain packages. |
| **Never share** | What must never leave the repository: secrets, other projects’ work, people’s details. |

`AGENTS.md` holds the project’s rules: what agents never do (deploy, merge, push to the default branch), the code conventions, and a map of where things are. The better these two files are, the less each task has to say. `repos init` writes a starter for both. Fill in every `<…>`: the board won’t start agents in a repository whose prompt still has one.

## Keep agents from colliding

- **Use areas and dependencies, not hope.** “Start the next few” starts at most one task per area, so two agents rarely touch the same part of the code. Put a `depends` between tasks that do.
- **Claim before you build.** If you work a task yourself, claim it first. The claim is what stops an agent from picking it up.
- **Cap the agents.** The board runs a few agents at once (3 on Pro by default, up to 6) and a number of starts an hour. Raise them as your review speed allows, not before.
- **Merge when green, update when behind.** The board’s two pull request settings keep branches up to date and merge pull requests as soon as their required checks pass. Turn them on once you trust your checks.

## Keep the review load low

The point of the board is that you merge and the agents do the rest. Protect your attention:

- **Make CI the first reviewer.** An agent watches its pull request and fixes failing checks, so the better your tests, the less you read. The agent follows the checks you list in **Checks**.
- **Read the task, not the chat.** Agents write what they learn as comments on the task. You see decisions, findings, and hand-overs in one thread.
- **Let pings be the only interruption.** An agent pings when only you can help, when a task can’t be reproduced, or when it looks already done. Anything else waits on the board.
- **Message an agent instead of re-reading its work.** Under a running agent’s live output, send a note. It reads it before its next action.
- **Fix with an agent.** A pull request with a merge conflict, failing checks, or review comments can go back to an agent from its page on the board.

## Use routines for the chores

A **routine** is a saved prompt you run with a button, on a schedule, or on a GitHub event. Good ones: update the changelog from merged pull requests each week; check dependency updates; triage a failing workflow. Every run is a task and ends in a pull request you merge, so chores stay reviewable. See [Routines](/docs/routines/).

## Keep installs boring

Releases don’t deploy themselves. On the `stable` channel, a newer release arrives as a pull request in your install repository; merge it and Deploy runs, then rolls back if the new version doesn’t answer. On `main`, the board starts the Deploy for you. Read [Deploying and updating](/docs/deploying/) once, and pick the channel that matches how much you want to be on the frontier.

## A good first week

1. Run the [guide](/docs/quickstart/) and get every Connections row to **Working**.
2. Fill in the agent prompt and `AGENTS.md`, and make your checks fast.
3. Add five small tasks with briefs and done-whens. Start one agent by hand and watch its live output.
4. Merge the first pull request. Notice what the agent got wrong, and put the lesson in `AGENTS.md`, not in the next task.
5. Turn on Start the next few for a single area, then widen it.
6. Write your first idea, and read the spec it returns.
