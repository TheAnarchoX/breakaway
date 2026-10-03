# IDEA-6 · Decisions as questions and answers

Task: IDEA-6 on the board · Status: draft

## Problem
A `+decide` task is a title and notes. To decide, the owner has to write a comment, and then someone (the owner, or an agent) has to remove the tag, finish the task, and notice what it unblocks. Nothing says what exactly is being asked, so agents write the question in prose and read the answer back out of prose.

The idea: a decision becomes data. It carries questions of different kinds, the owner answers them on the task and presses submit, and that finishes the task and releases whatever waited for it.

## Fit
Nothing in the [decision log](../decisions.md) is touched. Deciding stays the owner's: agents ask, the owner answers. The board holds no personal data, and answers are project decisions, so the rule against personal data and secrets in a task covers them too. Storage follows [IDEA-5](IDEA-5-task-structure.md): plain properties Taskwarrior can carry, no D1 migration, and `task sync` keeps working.

## Design

### The decision
A task may carry a **decision**: an ordered list of questions, written by whoever makes the task (an agent shaping an idea, the owner, a refine run). A task with a decision is a decision task: it gets `+decide` when the decision is attached, exactly as today.

Each question has:
| Field | Meaning |
| --- | --- |
| `id` | Short and stable within the task (`q1`, `keeper`), so answers survive edits to the wording. |
| `type` | One of the types below. |
| `prompt` | The question, small Markdown. |
| `help` | Optional context: the trade-off, a link to the spec section. |
| `options` | For choice types: `{ id, label, note? }`. `note` says what picking it means. |
| `required` | Default true. |
| `other` | For `choice` and `multi`: allow "Something else" with a text box. |

Types, kept to what the owner's real questions need:
- `open`: free text (Markdown).
- `yesno`: polar. Yes, no, and an optional comment.
- `choice`: pick one of the options.
- `multi`: pick any of the options, with optional `min` and `max`.
- `rank`: put the options in order (for "which first").
- `scale`: a whole number from `min` to `max` with labelled ends.
- `date`: a day (for "by when").

Every question can also take a short **comment** next to its answer ("yes, but only after OPS-8"). Adding more types later means one more value in `type`; unknown types show as `open` so older clients don't break.

### Answering
- **The owner answers on the task**, in the board's task view (sidebar and modal): the questions as a form, in order, with the description above. A **Submit** button is enabled when every required question has an answer. Drafts are kept in that browser until submitted.
- **Submit** is one atomic call. It checks the answers against the questions (right shape for the type, options that exist, required ones present, length caps), then in one step: stores the answers, removes `+decide`, marks the task done, and adds a `board` comment that reads as a plain summary (`Decided by the owner: storage = Durable Object; second region = not now`). Tasks that depended on it are no longer blocked, and the ones that are ready show as ready as usual.
- **Only the owner submits.** The route uses the owner's identity, as *Close now* does; an agent's claim name is refused with a clear message. Agents can read answers (`show`, the API) and read the summary comment, and that is how they carry on.
- **Reopen.** The owner can reopen a submitted decision to change an answer: the task comes back as pending with `+decide`, answers kept and editable, and the dependents block again if they haven't started. A change is logged in Activity ("decision reopened", "decision answered").
- **No decision structure?** A `+decide` task made before this (there are about a dozen) still works. The task view offers **Decide…**, a single note box: the text becomes a comment by the owner, `+decide` is removed, and the task is done. That is the missing "resolve" button, and it needs no data.

### Storage
- `decision`: a JSON string property (Taskwarrior UDA `decision`, declared in [`taskrc`](../../taskrc)), the questions. Capped at 20 questions and 20 KB.
- `decision_answers`: a JSON string with `{ by, at, answers: { <id>: { value, comment? } } }`. `value` is a string, an id or list of ids, a number, or a date string, by type.
- The submit-time summary is an ordinary comment; nothing depends on parsing it.
- Both properties are plain strings, so `task sync`, Activity, and the interop test are unchanged in shape. Editing `decision` after answers exist keeps answers for ids that still exist and drops the rest with a note.

### API and CLI
- `POST /api/tasks` and `PATCH` accept `decision`. `POST /api/tasks/:id/decision/answers` submits (owner only); `DELETE …/answers` reopens. The task JSON gains `decision` and `decisionAnswers`.
- CLI: `add … --decision <file.json>` (or `modify`), `show` prints questions and answers, and `decision <ID> --template` prints an example file. There is no CLI command to answer, on purpose.
- Agents who need a decision: create or update the task with a decision, tag it `+decide`, and depend on it. The agent prompt and the `tasks` skill say so, replacing "add a `--tag decide` task that asks the owner" with the structured form.

### Edge states
Empty questions list: rejected. Unknown option id: rejected. A required question left blank: Submit stays disabled and names the question. Two submits at once: the second is refused (already decided). The task deleted or claimed while answering: the form reloads. Offline: the draft stays; Submit needs the board. A phone: the form is one column with large targets, and every control is reachable by keyboard and labelled, as the accessibility checks ask (radio groups and checkbox groups for choices, a labelled list with move buttons for `rank`, no drag-only interaction).

## Privacy
No personal data. The board only holds project decisions, and the owner's identity is the name `owner`.

## Out of scope
Anyone but the owner answering (a second decider would need its own decision, see `MOD-10`), branching questions (answer X shows question Y), voting or polls, notifications, decisions that aren't tied to a task, editing answers of other people, and turning the existing `+decide` tasks into structured ones (agents can do that per task with a refine run when the owner asks).

## Done when
One pull request each, all `horizon-now` as the idea says, all waiting for this spec to be merged:
1. **Decision model and API**: storage, validation, submit and reopen, Activity events, the `taskrc` UDAs; tests first, `pnpm interop` passes.
2. **CLI**: `--decision`, `show`, `decision --template`.
3. **Web board**: the answer form for every type, Submit, Reopen, the plain **Decide…** resolve for tasks without a structure, and the summary in the task view and on cards.
4. **Prompts and docs**: the agent prompt, the `tasks` skill, and `docs/tasks.md`. The owner pastes the updated routine prompt once (`CLD-65` covers it).
