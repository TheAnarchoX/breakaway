# IDEA-3 · Close a horizon, and drop the date estimates

Task: IDEA-3 on the board · Status: draft

## Problem
The owner finished everything in `now` in under a day. Today there's no way to say "this horizon is done": tasks stay in `now`, and moving `next` and `later` up means editing each task by hand. The horizons in the repository's direction doc (samewave's `WORK.md`, on the install this was written for) also carry date ranges ("Until mid-November 2026", "November 2026 to March 2027") and named themes (H1, H2, H3). Agents finish work far faster than those dates guessed, so the dates are wrong, and names like H1 read like sprints or epics. The owner wants plain `now`, `next`, `later`, and no dates.

## Fit
Fits the principles: one person runs it, and the board stays the one place for work. Nothing here touches personal data or production. It changes only the board's Worker, its CLI, and docs.

## Design
**Closing a horizon** is one action, "close now", in one transaction (the store already has `transaction()` for this), in this order so no task is ever in two places:

1. `now` → `archive`: every finished task (done or deleted) in `now`.
2. `next` → `now`.
3. `later` → `next`. `later` is left empty for new ideas.

Open tasks in `now` (not done) are not archived: hiding unfinished work would lose it. They stay in `now` and join the tasks moved up from `next`, so the result is "the new now" (see the open question). The action reports the counts (archived, carried over, moved up).

- **The archive** is a fourth horizon value, `archive`, added to `HORIZONS` in `src/model.js`, the `horizon` UDA values in `taskrc`, and the sort order (last). Archived tasks keep their work ID, notes, PR, and history; nothing is deleted, and IDs are never reused. The horizon is one field, so Taskwarrior and `task sync` see it like any other value. A replica that doesn't know `archive` yet keeps the string; only `taskrc` needs the new value.
- **Where it shows.** The board and list hide `archive` by default and get an "archived" filter value alongside now, next, later. The Agents view's "start the next N" ignores it (it already only picks open tasks).
- **API and CLI.** `POST /api/horizons/close` (same auth as other writes) and `node scripts/tasks.mjs horizon close [--dry-run]`. The dry run prints what would move. On the web board, a "Close now" button in the horizon row's header opens a confirm dialog with the same counts, then runs it. It's logged in Activity as one event ("now closed: 7 archived, 2 carried over, 5 moved up").
- **Idempotent and safe to retry.** Running it twice archives the (new) `now`'s finished tasks only; it's never automatic, only the owner triggers it, and agents never close a horizon.
- **Tags.** A `horizon-now|next|later` tag on an idea is the owner's choice of horizon for the tasks an agent makes. Closing a horizon moves task horizons, not those tags, so an idea that says `horizon-next` keeps saying it. Agents read the tag as "the horizon named at the time the idea was written"; the idea's tasks are made when it's shaped, which is usually before the next close. Flagged in the notes, no change planned.

**Dates and names out of the docs.** The horizons table loses its "When (roughly)" column, the H1/H2/H3 headings become plain "Now", "Next", "Later", and each keeps only its theme. "Horizon review (owner, mid-November 2026)" becomes "Close a horizon when it's done", pointing at this action. Anywhere else that gives a date for a horizon (search for `mid-November`) is reworded the same way. Dated facts about things that happened (deploy dates, decisions) stay.

## Privacy
None. No personal data.

## Out of scope
- Automatic closing, or closing on a schedule.
- Renaming horizons, sprints, or epics; the names stay `now`, `next`, `later`.
- A separate archive page or export. Archived tasks are found with the horizon filter and search.
- Restoring a whole horizon at once (one task at a time can be moved back by editing its horizon).

## Open questions for the owner
1. **Unfinished tasks in `now` when you close it.** Proposed: they stay in `now` (merged with the tasks from `next`). The alternatives are refusing to close until none are left, or archiving them too. You said "shifts all tasks in now to an archive"; archiving open work seemed like losing it, so the default keeps it. Say if you want it the other way.

## Done when
- Closing runs in the order now → archive, next → now, later → next, in one transaction, with a dry run, and tests for the order, open tasks, and an empty horizon.
- `archive` works in the model, `taskrc`, the CLI, the API, the board, and `pnpm interop`.
- The direction doc and `docs/tasks.md` have no horizon dates or H1/H2/H3 names, and document the new action.
- Follow-up tasks: `CLD-63` (build the close action) and `OPS-23` (drop horizon dates and H-numbers from the docs), both waiting on this idea.
