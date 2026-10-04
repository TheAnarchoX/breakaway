---
title: Ideas, decisions, and pings
description: The three ways work and people meet: write an idea and let an agent shape it, answer an agent’s questions in a form, and get a ping when only you can help.
---

## Ideas

When you’d rather write down an idea than fill in a task, use **New idea** (`i` on the board, or the Idea tab in the New task dialog; `npx breakaway idea "…"` on the command line). It takes your words as they are and makes a task in the Ideas area (`IDEA-12`) with them as its description.

- **You choose whether an agent starts on it by itself.** *Start its agent as soon as there’s room* sets the idea’s `autostart` when you save it. Off, the idea waits until you start its agent from the task or the Agents view. Agents never change this setting, for the idea or for any task they make.
- **You choose the horizon too:** Now, Next, Later, or Auto. The choice is kept on the idea as a tag (`horizon-now`, …) and every task the agent makes gets exactly that horizon. With Auto, the agent picks one for each task from what’s already on the board.
- **The agent shapes it, it doesn’t build it.** It checks the idea against the repository’s settled decisions, looks at the board for overlaps and blockers, writes a spec in `docs/specs/IDEA-12-<slug>.md`, and adds the real tasks with area, horizon, tags, dependencies, description, and done when filled in. Every one of them waits for the idea’s own ID, so nothing is built before you’ve read the spec.
- **One pull request, yours to merge.** It holds the spec and closes the idea. Merging it releases the tasks. A task that needs a decision from you is tagged `+decide` and carries its questions.

If an idea breaks a settled decision or something the repository isn’t doing, the agent doesn’t turn it into agent work: the spec says so plainly and asks you a question.

Ideas take images too: the New idea form takes them by button, drag and drop, or paste, and `idea "…" --image shot.png` on the command line. PNG, JPEG, WebP, and GIF, up to 1 MB each and 4 per task. They stay on the board, never public, and the agent fetches and reads them before it starts.

## Decisions

A **decision** is how an agent asks you for a choice. A task can carry an ordered list of questions of seven types:

| Type | You answer with |
| --- | --- |
| `open` | Free text |
| `yesno` | Yes or no |
| `choice` | Pick one option |
| `multi` | Pick any, with optional `min` and `max` |
| `rank` | Put the options in order |
| `scale` | A whole number between two labelled ends |
| `date` | A date |

Each question has a stable `id`, a prompt, optional help, and, for choices, options that say what picking them means. Every answer can take a short comment. A task with questions gets `+decide`.

- **Asking.** `npx breakaway decision --template` prints an example file. Attach it with `add … --decision <file.json>` or `modify <ID> --decision <file.json>`. Up to 20 questions and 20 KB; no personal data and no secrets. Work that waits for the answer depends on the task.
- **Answering (you only).** In the task’s view on the board the questions are a form. **Send answers** turns on when every required question has an answer, and a draft stays in your browser. Sending stores the answers, removes `+decide`, marks the task done, and adds a comment that summarises them, so whatever waited for it is released. The CLI has no command to answer: an agent can’t decide for you.
- **Reopening.** Reopen a submitted decision on the board to change an answer.

Settled decisions that every change must respect go in the repository’s decision log (`docs/decisions.md`). If a task would break one, the agent stops and asks you instead of working around it.

## Pings

An agent that can’t finish a task because only you can help, or whose task turns out to be done or not reproducible, **pings** you instead of leaving a comment nobody sees. `ping <ID> --kind <kind> "<message>"` (the agent must hold the task) writes a comment and an entry in your inbox.

| Kind | Means | Push |
| --- | --- | --- |
| `blocked` | It can’t finish because only you can give it something: a dashboard change, a production step, an account, a secret. | Yes |
| `question` | It needs an answer that isn’t worth a full decision. | Yes |
| `stale` | The task can’t be reproduced or already behaves as expected, so it should be closed instead of built. | Yes |
| `done` | The work looks finished already, so you should confirm. | Yes |
| `fyi` | Something you should know now that needs no action. Inbox only. | No |

The message is up to 500 characters and is refused if it looks like a token. There are at most 3 pings per task and 10 per agent a day, and a repeat of the same kind and message is dropped. A ping stays open until you resolve it or the task is finished.

### Proposals

A ping can carry a **proposal**: up to 10 changes and 20 KB you can apply in one press. `ping --template` prints an example.

- `add` tasks, with local `ref`s so they can depend on each other.
- `depend`: add or remove dependencies between existing tasks.
- `modify`: horizon, tags, brief, or done when.
- `done`, with a note; and `release`.

The server checks it when it’s proposed, refusing cycles, dependencies another path already implies, `autostart`, changes to `horizon-*` tags, and finishing a task in review. Agents propose; only you apply, dismiss, or mark a ping handled, in the signed-in browser. Apply checks every change again against the board as it is then and, if any no longer holds, changes nothing and tells you why.

### Push notifications

The push goes to the installed board app, with Web Push. It’s off until you turn on **Notifications** under Settings, This browser, and it needs the VAPID key pair. Until then pings show in the inbox only. When a connection has needed attention for 10 minutes, the inbox also gets a note, with no push.
