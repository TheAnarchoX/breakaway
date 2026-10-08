# IDEA-26 · Kickoff: start a new project from the board

Task: IDEA-26 on the board · Status: built (as of 5 Oct 2026, every task it planned is done)

## Problem

The board is good at work that already has a repository. Starting something new is still a job for someone technical: create a repository on GitHub, install the App, register it, run `repos init` in a terminal, make a routine on claude.ai, run `agents-connect` in a terminal, write `AGENTS.md` and the agent prompt, then write the first tasks. The **Add a repository** wizard (`CLD-194`, [`src/wizard.js`](../../src/wizard.js)) lists those steps and ticks them, but two of them need a terminal and all of them assume you know what a repository, a routine, and a stack are.

The owner wants **Kickoff**: you have an idea, for anything, and the board takes it from there. First it sets up the private plumbing (the repository, the App, the agent routine and its trigger), so the idea never sits anywhere public and agents can start from day one. Then an agent asks you plain questions, the way decisions already work, about what you want, how it should be built, and how it should run. Then it turns your answers into a plan in the new repository: a spec, `AGENTS.md`, the agent prompt, and the first tasks, so agents can start building.

The owner, 3 Oct: Kickoff is for people who aren't technical as much as for those who are. Plain questions, no jargon in the decisions, sensible defaults for how it's built and run, and the board doing the setup they can't.

## Fit

- **Free and self-hosted.** Kickoff runs on the person's own board. It starts from a working install: installing breakaway stays [`prompts/install.md`](../../prompts/install.md) (`DOC-8`).
- **An install keeps its data.** Kickoff talks only to services the install already connected: GitHub through the board's App, and Claude through the new repository's routine. The idea, its images, and the answers stay on the board and in the new repository.
- **The person who runs the board decides.** Every step that creates, registers, writes, or starts something is a button the person presses: creating the repository (on github.com), registering it, adding the board's files, starting each agent run, and merging the plan. No agent registers a repository, connects a routine, or merges; the board's own buttons do what `AGENTS.md` keeps from agents.
- **One claim per task, and pull requests close tasks.** The interview and the plan are an `IDEA-` task in the new repository, worked by one agent and closed by its plan's pull request, like any idea.
- **The Secrets Store stays the owner's** ([IDEA-14](IDEA-14-multi-repo.md), section 4): the Worker reads secrets and never writes one, which is why connecting a routine needed a terminal. The owner chose to change that for routine URLs and tokens only (`BRK-130`): the board keeps them itself, encrypted with a key from the Secrets Store. The Secrets Store's own secrets are still written only by the owner.

## Design

### 1. Start a kickoff

**Kick off a project** sits in the header's **New** menu beside New task, New idea, and New agent, on the **Add a repository** wizard ("Starting from scratch? Kick it off"), and on a fresh install's setup list. It opens `#/kickoff`:

- **What do you want to make?** One box, in your own words, as long as you like, with up to 4 images (the limits ideas have, [IDEA-8](IDEA-8-images-on-ideas.md)).
- **What should it be called?** Suggested from the first line; it becomes the repository's name, the slug (`slugFrom`), and a work-ID prefix suggestion (three letters from the name, checked for clashes the way registering is, `POST /api/repos` with `dryRun: true`). The prefixes are shown, not asked: one area, `app` with the suggested prefix, changeable under **More options**.
- **Kick it off** saves it and opens its page, `#/kickoff/<id>`.

A kickoff is a row in a new `kickoffs` table in the Durable Object: its id, the pitch, its images, the name, the slug and areas it will register with, the GitHub `owner/name` once known, its IDEA's UUID once made, the time it started, and the step it's on. It belongs to no repository until it has one, so nothing about it is written to any repository but its own. The **Kickoff** list shows the ones in progress; each can be picked up later or stopped (**Stop this kickoff** deletes the row and its images; once it's registered, the page also points to **Changed your mind?** on the wizard, which takes a repository off the board).

Owner-only, cookie-signed like registering: a request with an agent's name is refused, and the bearer token gets read-only `GET /api/kickoffs`. Once the repository is registered, its own settings (areas, prefixes, caps) live on its settings page from IDEA-29 (`#/settings/<slug>`), and the kickoff page links there rather than repeating them.

### 2. Set it up, privately

The page shows the steps in plain words, one at a time, each saying what happens, why, and what you'll see. It reuses the wizard's facts and step ticks (`wizardFacts`, `wizardSteps`), so a kickoff and the wizard always agree, and a stuck step shows Connections' own row and fix. Step names in Kickoff's words (the wizard's id in brackets):

1. **Make a private home for it on GitHub** (`create`). The board can't create a repository through its App on a personal account, so it gives a link that opens github.com's own form already filled in: `https://github.com/new?name=<name>&visibility=private&description=<first line>`. You press Create there. Private is the default and the page says why (your idea isn't public until you choose).
2. **Let the board see it** (`install`): the link to the App's installation settings for that repository, and to the repository's Allow auto-merge setting. Ticks from the live check, as in the wizard.
3. **Add it to the board** (`register`): one press, with the slug and areas from step 1. This is when the kickoff's IDEA is made (section 3).
4. **Add the board's files** (`init`, `prompt`). On an empty repository, one press: the board writes the first commit through its App (Contents write, which it already has), with the same files `repos init` adds, the prompt's sections at their defaults, and a starter `AGENTS.md` (`BRK-130`, decision 2). One renderer makes the files for both, so they never drift. The interview's plan fills them in later. A repository that already has commits gets the `repos init` command instead, as today, since that path opens a pull request and the board doesn't.
5. **Make its agent routine on claude.ai** (`routine`). claude.ai has no way for the board to make a routine, so this is guided: the routine's name, the repository to pick, the stub to paste, the host to allow in its cloud environment, and where to add the API trigger, each with a **Copy** button and a line on what you should see.
6. **Connect the routine** (`connect`): **a form on this page** (`BRK-130`, decision 1). Paste the routine's URL and token; the board checks them the way `agents-connect` does, keeps them encrypted at rest with a key from the Secrets Store, never shows them again, and never returns them from any API. Under the form, **Prefer a terminal?** shows `npx breakaway agents-connect --repo <slug>`, which keeps working and wins when both exist. It ticks when the board can start agents there. The same form connects or replaces a routine on the wizard's connect step and on Connections (`WEB-38`), so a routine whose token changes never needs a terminal either.

The steps the board can tick itself never ask you to confirm. Nothing here starts an agent.

### 3. Tell it what you want: the interview

When the repository is registered, the board makes the kickoff's IDEA in it: the pitch as its description (your words, never rewritten), its images as attachments, tags `+agent +idea +kickoff-project`, horizon `next`. The kickoff page links to it.

Once the routine is connected, **Start the interview** starts an agent on that IDEA with `Mode: kickoff` in its payload. The core gets a section, **Kicking off a project**, that the mode follows (the core is copied into every repository unchanged, and this is a board rule, not breakaway's):

1. **Read the pitch and the images.** Look at the repository: it's empty apart from the board's files.
2. **Ask, as a decision on the IDEA** (`modify <IDEA> --decision`, the [IDEA-6](IDEA-6-decisions-with-questions.md) types): the fewest questions that settle the first version, at most 12 in the first round, in three groups:
   - **What it is:** who it's for, what they do with it first, what the first version must have and can leave out, and how it should look and feel (images welcome).
   - **How it's built:** the kind of thing (a website, an app on phones, a tool, a game, something else), with **Pick for me** as the first option. For a website or an app, Pick for me means a Cloudflare Worker with static assets (`BRK-130`, decision 4): one default the docs and the deploy flow can count on, on the account the board already runs on. That covers anything that runs in a browser, an app on phones included, as a web app you add to the home screen. Only for what can't run there (an app from the phone's store, a tool for the terminal) does the agent recommend a stack, and **In short** says which and why.
   - **How it runs:** where it lives (on your own Cloudflare account, the default, since your board already runs there), who can use it (just you, people you invite, everyone), and whether the repository stays private.

   The rules for the words: everyday language in every `prompt`, one idea per question, options instead of open text where they work, the recommendation first and marked, and any technical term only in `help`, explained in a line. A question you can answer from the pitch isn't asked.
3. **Release and stop.** The board shows the decision on the kickoff page.

Answering works as every decision does. A kickoff's decision also has **Send answers and carry on** (`BRK-130`, decision 3), which sends them and starts the next `Mode: kickoff` run on the IDEA in one owner-signed press (the person's press starts it, so no agent starts by itself; at the agent limit it queues like any start). **Send answers** alone stays beside it, for answering now and starting later. The next run reads the answers:

- **Something important is still open?** One more round, at most 6 questions, about only that. Two rounds at most: after that the agent picks sensible defaults and writes down which.
- **Enough to plan?** It shapes the idea ("Shaping an idea" in the core) with three additions, in one pull request in the new repository: `AGENTS.md` says how to build, test, and check the chosen stack; the agent prompt's sections replace their defaults; and the spec opens with **In short**, a few plain sentences a non-technical reader can check against what they asked for, which the pull request's description starts with too, under `## In short`, for the kickoff page to quote. The first tasks get a feature named for the first version (`<slug>-v1`), depend on the IDEA, and the first of them sets up the stack, so building stays tasks. The pull request closes the IDEA.

### 4. Get going

The kickoff page ends with what's next, in order: **Read the plan** (the pull request, with its **In short** quoted on the page), **Merge** it (the board's own Merge, the person's press), then **Start building**, which opens the first-version feature with its **Chase** button. Kickoff never starts the chase. Last, **Run it** (`WEB-126`, which took over `WEB-36`'s optional **Put it online**): a required step that asks whether the project runs anywhere. **Not needed** finishes it; **Set it up now** and **Have an agent do it** show each part of the setup (a provider, the write tokens, staging and production, the first plan waiting, and the wizard's **Deploys** step, `WEB-14`) and what's left, and finish it once every part is in place. Run it can be answered as soon as the repository is on the board, and the kickoff's agent reads the answer (`BRK-305`): its payload says `Run it: now`, `agent`, `not-needed`, or `not answered yet`. With **Set it up now** or **Have an agent do it**, the plan's pull request also writes staging's and production's desired state (`.github/breakaway-infra/<environment>.json`, from the owner's templates where they fit, under the board's environments' names when it has them), with `infra check`'s output; merging it makes a first plan that waits for the owner once the environments are on the board. With **Not needed**, or no answer yet, the plan writes none and its **In short** says so.

A kickoff is finished when its plan merges and **Run it** is done (answered **Not needed**, or every part set up): until then it stays in the Kickoff list, marked "Plan merged, Run it left" (`WEB-126`), and then it leaves, and the repository carries on like any other.

### Edge states

- **No GitHub App on the board yet:** Kickoff says so and links to Connections first. It can still save the pitch.
- **The name is taken on GitHub, or the repository has files:** github.com's form says so; a repository with commits takes the `repos init` path in step 4.
- **A clash in the slug or prefix:** shown as you type, with the next free suggestion.
- **The routine's URL or token is refused:** the form says which check failed and what to do, and stores nothing.
- **The routine fails to start:** Connections' row and its fix, as in the wizard; the interview stays unstarted.
- **Agents are at the limit:** the interview queues for room like any start, and says so.
- **You close the page:** everything is saved; the Kickoff list picks it up where it was.
- **Narrow screens:** one step at a time, copy buttons full width.

## Privacy

The board stores the pitch, its images, the name, and the step in the `kickoffs` row, and the rest as ordinary tasks, attachments, and decisions. A routine connected from the form has its URL and token stored encrypted at rest (AES-256-GCM, each record bound to its repository) with a key derived by HKDF from the sync key the install already has, so updating needs no owner step; `rotate-sync` re-encrypts them with the new one, and one that can't be decrypted (the sync key changed by hand) shows as Needs attention until it's connected again (`BRK-133`, [`src/routine-keep.js`](../../src/routine-keep.js)). One connected with `agents-connect` stays in the Secrets Store as before. Removing the repository drops its stored routine. The idea leaves the install only to the new repository (on GitHub, private by default) and to the agent sessions in that repository's routine. It never goes into breakaway's repository or any other.

## Out of scope

- Installing breakaway: Kickoff starts from a working board ([`prompts/install.md`](../../prompts/install.md)).
- Creating a repository through the API, or any GitHub permission beyond what the App has. The person presses Create on github.com.
- Making the claude.ai routine for the person: claude.ai offers no way to.
- An idea for a repository that already exists: that's **New idea**.
- Building the project: Kickoff ends with the plan merged and the first tasks waiting.
- Deploying it: the deploy flow's work (`deploy-flow` feature), which Kickoff only links to.
- Several people, accounts, or sharing a kickoff.

## Decided

The owner answered `BRK-130` on 4 Oct 2026, all as recommended:

1. **How a routine gets connected:** a form on the board, which keeps the URL and token encrypted (`BRK-133`, and `WEB-38` beyond Kickoff). This changes "the Worker never writes a secret" for routine tokens only.
2. **The first commit:** the board writes it to an empty repository through its App (`BRK-132`). A repository with commits still gets `repos init`.
3. **Send answers and carry on:** yes (`BRK-134` on the server, `WEB-35` on the page).
4. **Pick for me:** a Cloudflare Worker with static assets for a website or an app (`BRK-134`, in the core's section).

Nothing else was raised.

## Done when

- A person with a working board and no terminal goes from a pitch to a private registered repository with its routine connected, answers plain questions, and merges a plan with the first tasks waiting, all from the board.
- The pitch is never written anywhere but the board and the new repository.
- `docs/tasks.md`, the core, and the decision log describe it.

Follow-up tasks, all in the `kickoff` feature and all waiting for this spec (IDEA-26) to merge:

| Task | What | Waits for |
| --- | --- | --- |
| `BRK-130` | Decide the four questions above (owner, answered) | IDEA-26 |
| `BRK-131` | Kickoffs on the server: the table, API, steps, and the IDEA once registered | IDEA-26, `BRK-130` |
| `BRK-132` | The board adds its files to an empty repository through its GitHub App | IDEA-26, `BRK-130` |
| `BRK-133` | Connect a repository's routine from the board, kept encrypted | IDEA-26, `BRK-130` |
| `BRK-134` | The kickoff mode: the core's section, the payload, and Send answers and carry on | IDEA-26, `BRK-131` |
| `WEB-35` | The Kickoff view: start, set up, interview, and get going | IDEA-26, `BRK-131`, `BRK-132`, `BRK-133`, `BRK-134` |
| `DOC-20` | Docs: Kickoff in the manual, the README, and the decision log | IDEA-26, `WEB-35` |
| `BRK-135` | Rehearse a kickoff end to end with a made-up idea (owner) | IDEA-26, `WEB-35`, `DOC-20` |
| `WEB-36` | Put it online: Kickoff's last step offers the wizard's Deploys step | IDEA-26, `WEB-35`, `WEB-14` |
| `WEB-38` | Connect or replace any repository's routine from the board's form, on Connections and the wizard | `BRK-133` |
