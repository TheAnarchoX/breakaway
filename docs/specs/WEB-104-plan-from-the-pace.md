# WEB-104 · Plan features from the board's pace

Task: WEB-104 on the board · Status: draft

## Problem
The roadmap's timeline ([WEB-102](../../web/src/components/RoadmapTimeline.jsx)) draws each feature from its first work to when the board's pace says it's likely done. That pace is a fair calculation: what each area finished in the last 28 days, the feature's longest chain of open tasks, and the owner's own steps. But on its own it isn't a plan. Bars move every time a task closes or a new one lands, a feature with no history says "no estimate yet", and the Months zoom stretches a few weeks of agent work into a thin strip that says little. The owner wants to plan with it: say when a feature should start and end, see whether the pace agrees, and order the work by that, without the timeline turning into a matrix of dates.

## Fit
- **The person who runs the board decides.** Planned dates are the owner's, like a feature's release: set on the board with the owner's cookie, never by an agent or the CLI's token. Agents read them.
- **An install keeps its data.** Two dates on a feature, in the Durable Object. Nothing leaves the install.
- **Taskwarrior stays a first-class way in.** Features aren't tasks, and tasks gain no field, so sync and the replica don't change.
- The pace stays. It becomes the suggestion every plan starts from and the check every plan is held against.

## Design

### Data
A feature gains two optional fields, `plannedStart` and `plannedEnd`: whole days (`YYYY-MM-DD`, UTC), as columns `planned_start` and `planned_end` on `features`. `plannedEnd` alone is fine ("done by"); a start after its end is refused. `PATCH /api/features/<slug>` takes them, owner only, like `release`; an empty string clears one. `GET /api/features` returns them, `tasks features` and `features show` print them, and Activity records a change like a change of release.

### The pace suggests, the owner plans
The projection in `web/src/lib/roadmap-timeline.js` doesn't change. Each feature now has two things to draw:

- **The pace**, as today: the likely end, the range it could run to, and the owner's steps.
- **The plan**, when it has one: a frame from the planned start to the planned end, drawn around the pace's bar on the same row.

A feature without a plan shows the pace's bar and, on hover or focus, **Plan it: 12 Oct to 19 Oct**, the pace's start and likely end. One press sets those as the plan; the owner can then drag either end of the frame (or use Alt+← and Alt+→ on it, with Shift for the start) to move it a day at a time. Planning a whole release at once is **Plan from the pace** on the lane's head, next to the Pull into buttons: it fills in every unplanned feature in that lane from its suggestion, with an Undo, like moving a feature.

How the pace compares to the plan is said in words on the bar and in its explanation:

- **On plan**: the likely end is on or before the planned end.
- **Could slip**: the planned end is inside the range the pace could run to.
- **Behind by 4 days**: the likely end is after the planned end. The frame's end is marked, and the feature card says it too.
- **Not started**: the planned start has passed and no task in it has been claimed.

A feature the pace can't estimate yet ("no estimate yet") draws only its plan, so a new feature can be planned before it has history.

### The axis
Calendar days stay, because a plan is dates. The Months zoom goes; in its place, **Fit** scales the axis so today and the last planned or likely end in view fit the screen. Weeks stays the default. A lane's head shows its release's planned end (the latest in it) beside the pace's "Likely by".

### Ordering
Features in a lane sort by planned start, then by the pace's start, so planning a feature also places it. The projection keeps queuing features in each area in the roadmap's order (release, then title), so the suggestions don't move when the owner plans; using the plan's order in the projection is an open question.

### Edge states
- **No features, one repository in the switcher, a phone:** as today. On a phone the cards show the plan as a line ("Planned 12 to 19 Oct · behind by 2 days") and plan from the feature's page.
- **A shipped feature** keeps its plan for the record; the past lane shows how it went against it.
- **A feature moved to another release** keeps its plan.
- **Signed in with the CLI's token** (an agent): reads the dates, can't set them; the API answers 403 with what to do.

## Privacy
Two dates per feature, set by the owner. Nothing about people, and nothing leaves the install.

## Out of scope
- Dates on tasks, or scheduling tasks or agents by date.
- Pings or pushes when a feature falls behind (a follow-up if the owner wants one).
- Capacity planning per agent, or a matrix of features against weeks.
- Changing how the pace is calculated.

## Open questions
The spec's answer stands unless the owner says otherwise in review.

- Should the projection queue features by their planned start, so planning one changes where the others' suggestions fall? This spec says no, so the pace stays a plain measure.
- Is Fit the right replacement for Months, or should the timeline drop the zoom entirely?

## Done when
- The owner can plan a feature from its suggestion in one press, move either end, and clear it; agents can't set a plan.
- The timeline shows plan and pace together, with On plan, Could slip, Behind by n days, or Not started in words.
- Months is replaced by Fit; Weeks is the default.
- Follow-ups, in the feature `feature-plans`: BRK-268 (the dates on a feature: store, API, CLI), then WEB-106 (the timeline). Both wait for this spec.

## How to check it
1. Open the Roadmap with the timeline showing, on a wide screen.
2. Point at a feature's bar: it offers **Plan it** with two dates. Press it: a frame appears around the bar with those dates.
3. Drag the frame's end a few days earlier than the bar's likely end: the bar now says **Behind by** that many days.
4. Press **Plan from the pace** on a release: every feature in it without a plan gets one, and Undo takes them back.
5. Press **Fit**: everything from today to the last planned end fits the screen.
