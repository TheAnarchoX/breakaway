# WEB-94 · The environment console

Task: WEB-94 on the board · Status: draft

## Problem
An environment's page (WEB-61, then every Architect piece added a section) was a stack of sections, most of them an empty-state paragraph on a new install: Plans, Incidents, Resources, Nobody owns, Estimated cost, Desired state, Recent changes. The owner wants it to feel like a console where agents run your infrastructure: a topology, streams, almost a living thing, while it still says everything. The brand fits it: "loud and fast where most tools are calm" (`brand/README.md`).

## What it became
One page in three layers, read top to bottom:

1. **The status band**: six tiles in a row: **Health** (the worst resource's, with how many share it), **Freeze** (frozen and since when, observe only, or not frozen), **Live** (a pipeline's version and commit, else the target), **Plan** (a run applying now, or the plan waiting for you, linking to its page), **Budget** (how much of the month's budget the estimate uses, with its state), and **Agents** (who is at work there now: the claimed tasks it's for, its open incidents' tasks, and agents whose open plans wait or apply there, each with the task's red number).
2. **Resources and the stream**, side by side on a wide screen:
   - **Resources** as a **Map** or a **List**. The map draws three columns, **In front** (what something serves: routes, domains), **Runs** (what uses, serves, or feeds anything: Workers, services), and **Holds** (everything else: databases, stores, queues), with a line per relation. Each node shows its name, kind, cost, and a bar in its health's color, and its words carry the same (status colors always come with words). Drift marks the nodes that differ from the repository. The plan applying now, or else the one waiting for you, shows on the same nodes before it applies: **+ adds** (a dashed node that doesn't run yet), **~ changes**, **− removes** (dashed and struck through). Selecting a node opens its detail under the map: its health and what the provider said, its ID, owner and task, cost, drift, what the plan does to it, what it uses and what uses it (each selects that node), its settings, and its recent signals. The list is WEB-61's Resources section, the same cards with the cost, drift, and plan marks added.
   - **The stream**: newest first, signals, incidents, the executor's runs and their steps, and every audit entry (plans, approvals, applies, envelopes, freezes, deploys), each linking to its source: a resource selects its node, a plan opens its page, an incident opens its task. It's worded with WEB-87's `auditWords` and `auditActor`, so it says what the plan page says. **Show older** pages back through the audit trail, so every entry Recent changes showed is still here.
3. **A panel each** for the rest, in a two-column grid: Deploys, Plans, Incidents, Nobody owns, Estimated cost, and Desired state and drift (with Describe it as code). Each keeps what it showed; an empty one is one quiet line ("None yet: a pull request to `.github/breakaway-infra/production.json`, or drift, makes one."), never a paragraph.

### The layout

Since WEB-100, the console fills a wide window 2:8:2, each column scrolling on its own: the status band as its own card on top of the map in the middle (its tiles in one row once they fit), admin on the left (the owner's actions, Plans, Desired state and drift, Estimated cost, and Nobody owns), and ops on the right (the stream, then Incidents, then what's live with Promote and Roll back since WEB-108, then Recent deploys). Every panel shows all it has, wrapped; an empty one says "None yet." and how it fills, and nothing waits behind a hover. Narrower, it stacks: status, map, ops, admin. The lines below are the first version's.

- **Wide** (over 900 px of content): the band in one row (three over three below 1100 px), the map and its detail on the left, the stream on the right (at most 360 px, sticky, scrolling inside itself), then the panels two by two.
- **Phone**: the band two by two, then Resources as the **List** with **Map** a press away (the map scales to the width, which makes its words small), then the stream (its newest 8, then **Show more**), then the panels one under another.

### The map's library: none
Plain SVG drawn by Preact, laid out by a pure module (`web/src/lib/topology.js`, about 200 lines, tested in `test/env-console.test.js`). An inventory's graph is shallow and regular (front → runs → holds), so three columns with each node placed beside its neighbours' average row crosses few lines and is stable: the same inventory always draws the same map, so a poll never moves a node. A general layout library (dagre, ELK, d3-force) would add 40 to 500 KB for layouts this shape doesn't need, and a force layout moves on every load. No new dependency.

### How "live" works: polling
The console reads the routes it already has every **15 seconds** while the page is shown, and at once when it's shown again; a hidden tab doesn't read. One poll is the environment, its inventory, audit trail (first page), desired state, drift, signals (newest 30), runs, incidents, plans, and cost, plus the plan the map shows. A failure in any but the first three leaves its part empty, never the page; the stream's header then says **Not updating**. Plans, Incidents, and Estimated cost read again on the same beat. No new route and no event stream: the board has none, a Durable Object holding sockets open for one page isn't worth it, and 15 seconds is fast enough for signals that providers report every few minutes.

### Motion
What's new since the last poll arrives from the left in 280 ms (`--dur-slow`, `--ease`); the first load doesn't animate. What's live breathes once every 2 seconds (the stream's **Live** dot, and a down resource's health bar), far under three flashes a second. The selected node's lines flow left to right. Reduced motion, the system's or the board's, turns all of it off: every change is instant.

### Limits
The map draws up to **60 resources** one by one. Beyond that, each kind with more than one resource becomes one node (its count, its worst health, its summed cost), relations move to the groups, the legend says so, and the list keeps every resource. The stream keeps the newest 60 entries, plus every older audit page you load.

### Keyboard and screen readers
Every node is a button in the tab order, with a label that says all it shows ("acme-db, d1, down, $4 a month, estimated, drift"); Enter or Space selects it and Escape clears it. The list says everything the map does, in text, and a screen reader hears "2 new in the stream" when a poll adds entries. Apply is never a button: the plan's page is where you approve or reject.

## Out of scope
- An event stream or WebSocket route, and server changes of any kind.
- Dragging, zooming, or panning the map, and remembering Map or List.
- Signals over time as charts on a node (the daily summaries are there to read with `infra signals --days`).
- Buttons for owner actions that have none yet (WEB-95).

## Open questions
- Should the phone show the stream before the resources? The list is long on a big environment; today the order matches the wide layout's reading order.

## Done when
In `pnpm dev` with an environment of 10 or more resources, the page shows the map with health, cost, and drift on its nodes, a stream that updates without a reload, and the status band. Selecting a node shows its detail. A waiting plan shows its changes on the map. Every fact the old page showed is still there. It works at phone width and wide, in carbon and chalk, with reduced motion, and by keyboard.

## How to check it
1. Open **Infrastructure** and pick an environment whose provider is connected.
2. The band at the top says its health, whether it's frozen, what's live, the plan waiting, the budget used, and the agents working on it.
3. Under it, the map shows what's in front, what runs, and what it holds, joined by lines. Press a node: its detail opens under the map. Press **List** to read the same as cards.
4. If a plan waits for you, its changes show on the map (+ adds, ~ changes, − removes) before you approve it on the plan's page.
5. Leave the page open: new signals and changes slide into the stream on the right without a reload.
6. On a phone, the same page shows the list first, with **Map** a press away.
