# WEB-80 · What's new after an update

Task: WEB-80 on the board · Status: approved (6 Oct 2026, by the owner)

## Problem
A board updates itself on the `main` channel with every merge, and on `stable` when you merge the Update workflow's pull request. Either way, nothing on the board says what changed, so new things go unnoticed until someone reads the release notes on GitHub. The owner wants the board to say what's new by itself: a dialog after a stable release, and something smaller and less in the way on the `main` channel, where releases come often.

## Fit
- **An install keeps its data.** The notes come with the release, in the web app's own files (`dist/whats-new.json`), so the board makes no call to learn them, and an install without an install repository or self-update still shows them. The only link out is **Read the release notes**, which you press.
- **Nothing changes on the server.** The Worker serves the file as one of its static assets; the web app reads the release the board runs from `/api/health`, as it already does.
- Which release this browser last saw is kept in the browser (`localStorage`), as other per-browser choices are. Two browsers each show it once.

## Design

### The file
The release workflow's pre-release job already writes the pre-release's notes. Before it packs the bundle, it now also writes the notes since the last stable tag, the same notes the stable job writes when it promotes this pre-release, and puts both in `dist/whats-new.json` (`scripts/release/plan.mjs whats-new`, built by `whatsNewOf` in `scripts/release/lib.js`):

```json
{
  "version": "1.5.0-main.38",
  "repository": "owner/name",
  "main": { "notes": "### Web\n\n- …", "changes": 1 },
  "stable": { "version": "1.5.0", "from": "1.4.0", "notes": "### Board\n\n- …", "changes": 12 }
}
```

A stable is the pre-release's bundle unchanged, so its notes have to be in the pre-release's file. The notes lose their `## breakaway v…` heading (the dialog has its own), and `changes` counts their list items. The stable's own words from `docs/releases/` aren't known when the pre-release is built, so they stay on GitHub, behind **Read the release notes**.

### When it shows
`web/src/lib/whats-new.js` decides, from the release the board runs, the release this browser last saw, and the file:

- **A newer stable** (`1.5.0` after `1.4.0` or `1.5.0-main.37`): a dialog, "What's new in breakaway 1.5.0", "12 changes since 1.4.0", the notes grouped by area, **Read the release notes** and **Done**.
- **A newer pre-release** (`1.5.0-main.38` after `1.5.0-main.37`): a note in the bottom corner, clear of the toasts and the sidebar: "Updated to 1.5.0-main.38", "2 changes", **See what's new** (opens the same dialog with the pre-release's notes) and **Dismiss**. It stays until it's dismissed or the page is reloaded; it never takes focus.
- **First run:** a browser that has never seen a release shows nothing and remembers the one it sees.
- **Nothing to say:** no file (a local build, or a release from before this one), a file for another build, a file that isn't JSON (the dev server's page), notes with no changes, or a roll back to an older release: nothing shows, and the release is remembered.
- **Offline:** when the file can't be fetched, nothing is remembered, and the next health check tries again.
- A board left open while it updates notices on the next health check (every 30 seconds) and shows it then.

**See what's new** in Settings' foot opens the dialog again whenever the board's files have notes for the release it runs.

## Out of scope
- Keeping what's been seen on the server, per person. The board has one owner and per-browser is enough; it can move to the board's settings if that changes.
- Notes for releases skipped in between (a board that goes from `main.30` to `main.38` shows `main.38`'s notes only). **Read the release notes** reaches the rest.
- Release notes written for people rather than lists of pull requests.

## Open questions
- Should the `main` channel's note fold several pre-releases into one when a board updates many times between visits? It would need the notes of every pre-release since the one last seen, which a single bundle doesn't have.

## Done when
- After a stable update, opening the board shows the dialog once; after a pre-release update, the corner note shows once.
- A first visit, a roll back, and a build without the file show nothing.
- `test/whats-new.test.js` and `scripts/release/lib.test.js` cover the decisions and the file.

## How to check it
1. Once this merges, open a board on the `main` channel after its update, so the browser remembers that release (the first visit shows nothing). After the next merge deploys, open it again: a small note in the bottom-right corner says "Updated to …" with how many changes. Press **See what's new** to read them, or close it.
2. Reload: the note doesn't come back.
3. When the owner promotes a stable release and a board on the `stable` channel updates to it, opening the board shows "What's new in breakaway …" with the list since the last stable.
4. In Settings, **See what's new** opens the list again.
