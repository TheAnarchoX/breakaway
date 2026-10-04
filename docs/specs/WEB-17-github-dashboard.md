# WEB-17 · The GitHub view as a dashboard, with its lists in tabs

Task: WEB-17 on the board · Status: draft (built in the same pull request)

## Problem
The GitHub view stacked every section in one long column: Connect, the release flow, alerts, open pull requests, recently merged and closed, deploys with releases and tags, CI runs, and commits. Finding what's live, or whether main is green, meant scrolling past lists you rarely need. The owner wants an overview at the top with what's live now, and the long lists in tabs under it.

## Fit
- It only changes how the web app lays out what `/api/github` already returns. No new data, request, or write; nothing leaves the install.
- Every action stays: Update branch, Merge, and Merge when green on pull requests (the rows and the pull request page), Promote and Roll back (in the Releases tab), Fix with an agent on alerts, Sync now, and the repository switcher (`s`), which still scopes the whole view.

## Design

### The dashboard
Shown whenever GitHub is connected, above the tabs. Visible headings never say "dashboard" (the brand's word list keeps it out of the board's copy); each tile has its own name.

- **Open pull requests**: the full list, as before, with its count and every row action.
- **Live now**: for each repository in view with a pipeline, one line per environment: Staging and Production, with the card's state (Live, Deploying with its step, Failed, Rolled back, Nothing deployed yet), the version, the commit, and when it went live. It reads the release flow's cards, so it agrees with the Releases tab. Under All with several repositories, each pair carries its repository chip. **Promote or roll back** opens the Releases tab and moves focus to it. A polite live region announces state changes, as the release flow does. No pipeline in view: the tile isn't shown.
- **Checks on main**: each workflow's latest run on its repository's default branch (the branch's real name in the heading; "each default branch" under All when they differ), failures first, then running, then passing, with a summary ("1 failing, 1 running, 2 passing") that carries an icon as well as color. No runs yet: "No runs on main yet."
- **Security alerts**: as before. Any open alert shows the list with Fix with an agent; none shows the one-line "No open Dependabot alerts."
- **Packages** (WEB-18): the latest package pre-release and release go here as one more tile, once packages exist.

### The tabs
In order, each with its count: **Releases** (the staging and production cards with Promote and Roll back; only with a pipeline), **Deploys** (only with a pipeline; releases and tags under it, as before), **Recently completed** (merged and closed pull requests), **CI runs**, and **Commits on main** (the branch's name, or "Commits" under All when branches differ). **Packages** (WEB-18) goes after Deploys when a repository has them.

- A WAI-ARIA tablist: `role="tablist"`, `tab`, and `tabpanel`, `aria-selected`, `aria-controls`, and a roving tab index. Left and Right move and wrap, Home and End jump, and a tab selects as it gets focus. Tab moves into the panel.
- Only the selected panel is rendered. The choice is remembered in this browser (`localStorage`, `tasks.githubTab`), and a tab that isn't there for the repository in view (Releases without a pipeline) falls back to the first.
- The tab's label and count replace the old section headings inside the panel; the Releases tab keeps its per-repository headings, which name the repository under All.

### Widths
Wide (1100 px and up), two columns, the pull requests on the left:

```
GitHub                                              [Sync now]
acme/widgets · synced 2 min ago
┌ Open pull requests 3 ───────────┐ ┌ Live now ──────────────────┐
│ #41 WEB-3: …  Ready to merge    │ │ Staging    Live  1a2b abc1 │
│ #40 BRK-9: …  Checks failing    │ │ Production Live  9f8e def5 │
│ #39 DOC-2: …  Behind main       │ │ [Promote or roll back]     │
└─────────────────────────────────┘ ├ Checks on main  1 failing ─┤
                                    │ ⊗ CodeQL            1 h ago │
                                    │ ✓ CI               10 m ago │
                                    └────────────────────────────┘
                                    ✓ No open Dependabot alerts.
 Releases | Deploys 2 | Recently completed 12 | CI runs 5 | Commits on main 6
┌───────────────────────────────────────────────────────────────┐
│ the selected tab's list                                       │
└───────────────────────────────────────────────────────────────┘
```

Narrow, one column: Live now, Checks on main, alerts, then Open pull requests, then the tabs, which scroll sideways when they don't fit.

```
GitHub
[Sync now]
┌ Live now ───────────┐
│ Staging  Live …     │
│ Production Live …   │
└─────────────────────┘
┌ Checks on main ─────┐
└─────────────────────┘
✓ No open Dependabot alerts.
┌ Open pull requests ─┐
└─────────────────────┘
 Releases | Deploys | Rec…  →
┌ the selected list ──┐
└─────────────────────┘
```

### Code
`web/src/lib/github-scope.js` gains the pure parts, tested in `test/github-scope.test.js`: `runState`, `checksOnMain` (latest run per repository and workflow on the default branch), `checksSummary`, `githubTabs` (which tabs, in order, with counts), and `pickTab`. `Tabs` in `web/src/components/ui.jsx` is the reusable tablist.

## Privacy
Nothing new is stored or sent. The remembered tab is a preference in this browser.

## Out of scope
- Packages: the tile and the tab are WEB-18's.
- New GitHub data (environments other than staging and production, check suites per commit).
- Moving the pull request page or its actions.

## Open questions
None.

## Done when
The GitHub view opens on the dashboard of what's live and keeps its lists in tabs, with every existing action still there, checked in both themes at both widths and with the keyboard; this spec is merged.
