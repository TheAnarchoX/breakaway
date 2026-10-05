# BRK-220 · Make routines with an agent

Task: BRK-220 on the board (a general agent started from the owner's prompt) · Status: approved (5 Oct 2026, by the owner)

## Problem
Making a routine today means filling in the Routines view's form: a slug, a name, the prompt, a done when, a horizon, a schedule as cron text, GitHub events, caps, and whether a trigger starts a run by itself or waits. The owner knows what they want a routine to do, but turning that into the right fields, and deciding whether it's one routine or three, is work they'd rather hand off.

The owner wants a second way in, next to **New routine**: say what you want in your own words, and an agent asks what it needs to know about how the routine should run (what it does, and when: its triggers), then makes the routine and turns it on. When it's clearer as several routines, it makes several.

The owner also asked that whatever stops an agent from making routines be changed for this, since pressing the button is the owner's intent.

## Fit
- **The person who runs the board decides.** Today an agent never creates or changes a routine ([IDEA-4](IDEA-4-routines.md): "Agents never create or edit routines or their triggers"; `AGENTS.md`: no `routines add`). The owner's prompt on BRK-220 changes that for one case only: an agent the owner started from **Make with an agent** may make routines, because the press is the owner asking for them. Every other agent keeps today's rule, and a routine's own runs still never change their routine. The routine it makes starts agents later, but only on triggers the owner agreed to in the interview, and every run still ends in a pull request the owner merges.
- **One claim per task.** The agent holds one task, its own, as a general agent does ([IDEA-30](IDEA-30-new-agent.md)). The permission comes from holding that task, so it ends when the task does.
- **No secrets to agents.** A webhook or Cloudflare alert trigger is a secret the board shows once. An agent never handles one, so the agent never makes those triggers: it names them in its hand-over, and the owner adds them on the routine's page with one press.
- **An install keeps its data.** Nothing new leaves the install: the prompt, the answers, and the routines stay on the board.

## Design

### 1. Where it starts
- **The Routines view**, beside **New routine**, a second button **Make with an agent**, shown when the agent routine of the repository in scope is connected (the same check as **New agent**). On the command line, `npx breakaway routines new "<what you want>" [--repo <slug>] [--force]`.
- **The dialog**, like **New agent**'s: one large field, "What should the routine do, and when?", rough is fine; **Repository** when the board runs more than one (preset to the one in scope; the routines are made there); **Force start**, as on every start; and **Start agent**. On success it opens the new task.
- **States**: an empty prompt ("Say what the routine should do first."), no repository picked, a routine that isn't connected, and Claude's limits, exactly as **New agent** handles them.

### 2. The agent's task
- A general task (IDEA-30 section 1) with one more tag, **`+routine-maker`**, and the prompt as its description, never rewritten. It has no area and needs none: its work is on the board, so it finishes without a pull request (a general task released with no pull request is closed by the board). The area-less name `claude-<short ID>` stays its name.
- Its payload says `Mode: routines` (a new kind, `routines`, in `firePayload` and `TRIGGER_TEXT`: "by “Make with an agent” on the Routines view, from the board"). It queues like a general agent: to the front, ahead of other auto-start tasks.
- **API:** `POST /api/routines/agent` with `{ prompt, repo, force? }`, owner only (the cookie, or the token with no `by`), returns the task and the run, or why it waits.

### 3. The interview
The agent reads the prompt, the repository's `AGENTS.md`, the routines already on the board for that repository (`routines list --json`, so it doesn't make a duplicate), and the board's caps. Then:

- **If it knows enough, it skips the interview** and makes the routines (section 4). A prompt like "every Monday at 9, update the changelog from what merged" needs no questions.
- **Otherwise it asks, once, as a decision on its own task** (`modify <its task> --decision <file.json>`), at most 8 questions in everyday words, with options and its recommendation first, the technical term only in `help`:
  - **What it does**, when the prompt leaves it open: what a run should change, and when a run has nothing to do.
  - **When it runs**: a button only, a schedule ("every weekday at 9:00 UTC", turned into cron by the agent), GitHub events (from the allowlist: a pull request merged, a release published, a workflow run failed), and whether a webhook or alert should start it (made by the owner afterwards, section 5).
  - **Starting by itself**: whether a trigger starts a run at once or waits for the owner's OK on the board (`triggerStart`), recommended **wait** for GitHub events and webhooks, **auto** for schedules.
  - **How often at most**: the daily cap and the gap between runs, with the board's defaults recommended.
  - **One or several**: when the prompt reads like several jobs, the routines it proposes, each in a line, with "one routine that does all of it" as the other option.
  
  Then it `release`s its task and stops, as a kickoff does.
- **Send answers and carry on.** The decision on a `+routine-maker` task gets the kickoff's **Send answers and carry on** (today `submitDecision` refuses `carryOn` on anything but a kickoff's idea). The answers are kept, the task stays open, and the same agent name starts again with `Mode: routines`, queueing when there's no room. One round of questions; if something small is still open, it picks the board's defaults and says which in its hand-over.

### 4. Making the routines
- **It makes them with the CLI**, as itself: `routines add <slug> --name … --prompt-file … [--schedule …] [--github-events …] [--trigger-start …] [--daily …] [--gap …] [--done-when …] --horizon …`, in the task's repository. They are **on** when made (`enabled`), as the owner asked.
- **The prompt it writes** is a routine prompt like any other: what a run does, in plain steps, what it never touches, and when it has nothing to do. It follows the repository's `AGENTS.md` and never asks a run to deploy, touch production, handle secrets, or merge.
- **Several routines** when the jobs are separate (different triggers, different files, or one could fail without the other). At most **5** per task.
- **Hand-over**: one `comment` on its task listing each routine (its slug, name, triggers, and whether triggers start runs by themselves), any webhook or alert trigger the owner still has to add (section 5), and any default it picked. Then `release`, which closes the task.

### 5. What the board lets it do
The permission is the task, checked on the server, not a promise in the prompt:

- **Who.** A routine write signed with an agent's name (`by`) is allowed only while that agent holds an open, claimed task tagged `+routine-maker`, in the routine's repository. Every other agent is refused as today ("only the owner creates or changes routines").
- **What.** Create a routine, and change or turn off a routine **its task made** (to fix a mistake before it hands over). Never another routine, never the routines-wide settings (pause, the daily cap), never a webhook or alert trigger (`createTrigger`, `revokeTrigger`: those are secrets), and never a run (`routines run`): the first run comes from the routine's own triggers, or from the owner's **Run now**.
- **How many.** At most 5 routines per task; the sixth is refused with that reason.
- **Within the caps.** A routine's daily cap and gap are checked against the plan as today; the agent sets them from the interview's "how often at most", or the board's defaults.
- **On the record.** The routine stores who made it: `edited_by` is the agent's name and a new `made_by` is its task's ID, shown on the routine ("Made by claude-1a2b3c4d for <task>"), and Activity records the creation with both. The owner changes or deletes it like any routine.
- **Closing the gaps.** Today the CLI sends no `by` on `routines add`, `modify`, `trigger`, and `revoke`, so the server can't tell an agent from the owner there, and `routines pause`/`resume`/`cap` have no owner check at all. The CLI sends `by` from `--as`/`BREAKAWAY_AGENT` on every routines write, like `features` does, and the settings route gets `ownerOnlyRoutines`. Without that, the rule above couldn't be checked.

### 6. Teaching agents
- **The core** gets "Making routines (`Mode: routines`)": sections 3 and 4 above, the limits in section 5, and the hand-over. Step 3 of "How to work" gets the mode. "Running a routine" keeps **Never change the routine**: a routine's run is not its maker.
- **`AGENTS.md`**: "no `routines add`" gains "unless the board started you with `Mode: routines`", so the copy and the server agree.
- **The `tasks` skill** gets a row for `Mode: routines`; `docs/tasks.md` documents **Make with an agent** and `routines new`. [IDEA-4](IDEA-4-routines.md)'s line "Agents never create or edit routines" links here. The core is a copied file, so other repositories pick it up with `repos init --update`.

## Privacy
The prompt and the answers are the owner's and stay on the board, as a general agent's do. The agent sees the repository's routines (names, prompts, triggers), never a trigger's secret, which the board keeps only as a hash anyway.

## Out of scope
- An agent that makes webhook or Cloudflare alert triggers, or sees their secrets.
- Any other agent making or changing routines, including a routine's own runs.
- Changing or deleting routines the maker didn't make, the routines-wide settings, and starting a run.
- A chat in the dialog: the interview is the board's decision, answered on the task.
- More than one round of questions, or more than 5 routines from one prompt.

## Open questions
None blocking. The owner reviews these choices in this spec's pull request:
1. **Turned on when made.** The routines are on at once, as the prompt asked; their GitHub and webhook triggers still default to **wait** for the owner's OK unless the interview says otherwise.
2. **No webhook secrets for agents.** The owner adds those triggers after the hand-over.

## Done when
One pull request each, tests first, tagged with the feature `routines-with-an-agent`:

1. **The server** (`BRK`): the `routines` kind and payload, `POST /api/routines/agent`, Send answers and carry on on a `+routine-maker` task, the scoped permission and `made_by` (section 5), and the owner check on the routines settings.
2. **The CLI** (`CLI`): `routines new`, and `by` on every routines write.
3. **The web** (`WEB`): **Make with an agent** and its dialog on the Routines view, Send answers and carry on on a routine maker's decision, and "Made by" on a routine.
4. **Prompts and docs** (`DOC`): the core's "Making routines", `AGENTS.md`, the `tasks` skill and plugin copy, `docs/tasks.md`, and IDEA-4's link.

## How to check it
Once it's built and deployed:

1. Open **Routines** and press **Make with an agent**. Write "Every Monday morning, update the changelog from what merged last week" and press **Start agent**.
2. The task opens and its agent starts. Since the prompt says what and when, it makes the routine without asking: the Routines view shows a new routine, **on**, with a Monday schedule and "Made by" its agent.
3. Press **Make with an agent** again and write something vague, like "keep an eye on failing builds and on the docs". The agent asks a few questions on its task. Answer them and press **Send answers and carry on**.
4. It starts again and makes one or two routines that match your answers, then comments a list of them on its task, including any webhook it left for you to add.
5. Try `npx breakaway routines add test --name Test --prompt x --as claude-someone` from a checkout: the board refuses it, because that agent holds no routine maker's task.
