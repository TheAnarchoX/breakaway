# BRK-100 · Prepare the next minor or major version from the board

Task: BRK-100 on the board · Status: built (as of 5 Oct 2026, every task it planned is done)

## Problem
Pre-releases count patches by themselves: every merge to `main` publishes `vX.Y.Z-main.N`, where X.Y.Z is `package.json`'s version, or the next patch once that stable is out (`nextPrerelease` in `scripts/release/lib.js`). Moving to the next minor or major takes a pull request that sets `package.json`, and on 4 Oct you made two of them by hand (LCH-20 to 1.1.0, BRK-99 to 1.2.0). A button on the board should start the agent that makes it.

## Fit
- **You decide.** Only you can press it (an agent's name is refused). It starts an agent that opens a pull request. You merge it, and nothing is released until you do.
- **One start path.** It starts a general agent, as Refine from the answers does ([IDEA-30](IDEA-30-new-agent.md), section 8): the same task, queue, limits, and Force start. Nothing new to start agents with.
- **An install keeps its data.** The board reads the release tags its GitHub sync already keeps. It makes no new calls.

## Design
**Which repositories.** Any repository whose release tags on the board include a main-channel pre-release `vX.Y.Z-main.N`: its pre-release versions come from `package.json`, as breakaway's own do. The board reads the version they work toward from the tags its last sync kept (the 10 newest releases and tags): the newest pre-release's X.Y.Z, moved to the next patch for each stable at or above it, the same arithmetic as `nextPrerelease`. A repository with no such tag shows nothing, and a request for it is refused (409: sync GitHub, or set `package.json` by hand).

**The choices.** The next minor and the next major after that version: from 1.1.2, 1.2.0 or 2.0.0; from 1.3.6, 1.4.0 or 2.0.0. Patches stay automatic, so there's no patch choice.

**Where.** The GitHub view's **Next version** section, in the right-hand column, for each repository that has one (named when the view shows several): the version the pre-releases count toward, the latest pre-release, and **Prepare 1.4.0** and **Prepare 2.0.0**. With one being prepared it says who has it and links to the task, with no buttons. When the repository's routine isn't connected it says to connect it on the Agents view. The Releases flow shows only for a repository with a deploy pipeline, so it isn't the place.

**The dialog** is Refine from the answers': the prompt the board will write (a dry run), an optional note under it, Force start, and Start agent. If the version moved since the view loaded (a new pre-release came in), the dialog shows the new one and starts that.

**The API.** `POST /api/agents/general` with `{ next: "minor" | "major", repo?, version?, note?, force?, dryRun? }`; `repo` is required when the board runs more than one repository. `version` is the version you saw: the board refuses (409) if the choice is something else now. A request with a prompt of its own, or with `decision` as well, is refused (400). Owner only: a request signed with an agent's name is refused (403), as for every general agent.

**The task** is a general agent's ([IDEA-30](IDEA-30-new-agent.md)): no area and no work ID until its agent picks one, horizon now, `+agent +general +version`, Start by itself when ready, `Mode: general` in the payload. Its title is "Set widgets’s version to 1.4.0 for the next minor release". `+version` marks it: while one is open in a repository, another press links to it instead of starting a second, whichever step it asks for. `+version` isn't a feature tag.

**The prompt** the board writes:

> The owner wants widgets’s next minor release: set its version to 1.4.0.
>
> Pre-releases count patches by themselves from package.json’s version. The latest is v1.3.6-main.4, so the work is toward 1.3.6; moving to 1.4.0 takes a pull request that sets it.
>
> What to do
> - Set "version" in package.json to 1.4.0. Change it anywhere else the repository keeps the same version in step (its AGENTS.md and release docs say where), and nothing else.
> - Open one pull request that closes your own task, titled with its work ID and "Set the version to 1.4.0". Say in it that once it merges, the next pre-release is v1.4.0-main.1.
> - If package.json already says 1.4.0 or later, change nothing: comment what you found on your task and release it.

Your note, if any, goes under it as "Note from the owner:".

**The CLI.** `npx breakaway agents new --next minor|major ["<note>"] [--repo <slug>] [--force]`, in the checkout's repository unless `--repo` names another. Owner only, like every `agents new`.

## Privacy
Nothing new is stored beyond the task. The prompt holds the repository's name and versions only.

## Out of scope
- Patches: they stay automatic.
- Setting the version at the moment a stable is promoted: BRK-118 adds that to the Release workflow. Both stay: the workflow input moves the version as part of a stable release, and this button moves it any time, for any repository on the board whose pre-releases count this way.
- Repositories whose versions come from somewhere other than `package.json` with `-main.N` pre-releases.
- Release notes, manual steps, and `release.json`: the agent follows the repository's own release docs.

## Open questions
None.

## Done when
You pick the next minor or major on the board, an agent's pull request sets `package.json` to it, and after the merge the next pre-release is that version's. Tests cover the choices offered, the general agent it starts, and refusing anyone but you (`test/next-version.test.js`).
