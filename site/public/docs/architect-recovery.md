# When it goes wrong

> What to do when a change doesn’t go through, a plan fails or rolls back, the board can’t see what runs, or something breaks in production. And how to recover without the board.

Architect is built to fail safe: a run that never had its plan changed nothing, a failed health check rolls back by itself, and a file that doesn’t check keeps the last good copy. This page is what to do when you see each one.

## Production is broken

1. **Freeze production** if you want nothing else to change while you look. On the deploy flow, **Roll back** still works, and is the fastest way back from bad code.
2. **Open the incident.** It’s at the top of the inbox, with the signal and what the board knows about the resource. Start an agent on it, or let your runbook do it: it diagnoses read only and comments what it found.
3. **Approve the fix.** The agent’s pull request ends `Part of <the incident>.`. Merge it, and its plan waits for you. If it can’t wait, change it by hand and [mark it as break-glass](https://leavethepack.dev/docs/architect-drift/#break-glass).
4. **Unfreeze**, and let the incident verify: the signals show health back. The agent writes it up and pings you to close it.

## A change doesn’t go through

| What you see | What to do |
| --- | --- |
| **Can’t merge**, with why | Fix what it names (checks failing, a conflict), then **Propose again**: it replays your edits on the current head |
| GitHub refuses the merge for a required review | Add the board’s GitHub App to the ruleset’s bypass list (the repository’s **Settings**, **Rules**, **Rulesets**, the rule, **Bypass list**). The App merges only on your press. Until then, review the pull request on GitHub |
| **Staging is frozen: unfreeze it to approve.** | **Unfreeze** it, or leave it frozen until you’re ready |
| The plan check failed | A file doesn’t check (it names the line and field), it names an observe-only environment, or the policy refused the plan. Run `npx breakaway infra check` in the checkout |
| The plan check is neutral | Something couldn’t be planned: an environment the board doesn’t have yet, or Cloudflare didn’t answer. Add the environment, or wait for the next sync |
| No plan check at all | The App doesn’t have **Checks: read and write** yet. The board’s pull request page still shows the plan |
| Applying needs `.github/workflows/breakaway-infra.yml` | Give the App **Workflows: write** and **Propose again**, or run `npx breakaway infra init` and merge it |

## A plan doesn’t apply

| What you see | What to do |
| --- | --- |
| It stays **Approved**, with a reason | The run couldn’t start: no apply workflow, a GitHub environment another branch may deploy to, another plan holding the lock, or GitHub refused. Fix what it says; it starts on its own |
| “Waiting for the run to check in” | The run started and hasn’t asked for the plan yet. Open its link on the plan to see why |
| **Failed: nothing applied** | The run stopped before it had the plan (its setup failed, or it was cancelled), so nothing changed. Fix what GitHub’s run says, then **Start the run again** on the plan. GitHub’s own Re-run never applies a plan |
| **Failed** | Read the plan’s steps for what Cloudflare refused, often a write permission the token lacks, or Workers Admin for a new Worker. A change that can’t be undone is never rolled back by itself: put it right with a new change |
| **Rolled back** | It applied, the health check failed, and the board applied the reverse. Read the signals for why, fix the change, and propose it again |
| **Applied**, unverified | Nothing called what changed, so the board couldn’t read its health yet. Call it, and look again after the next refresh |
| A lock nobody holds any more | **Release the lock** under the environment’s status band, once you know its run stopped |

## The board can’t see what runs

| What you see | What to do |
| --- | --- |
| A permission shows as missing on Connections | Add it to the token on Cloudflare, then **Replace the token** with it |
| The board stopped looking, and **Last looked** says Cloudflare refused the token | It expired or was revoked. Make a new one and **Replace the token** |
| A zone is skipped | Zone Read covers it and Workers Routes Read doesn’t. Give both the same zones |
| The map is missing something | It’s outside the target’s reach (nothing in scope binds it), or a permission is missing. Check the target, then Connections |
| A Worker reads **idle** | Nothing called it in the last day. Idle isn’t down |
| An environment shows no map | It has no target yet, and its file declares none or several Workers. Give it a target |
| `infra adopt` says there’s no inventory | Connect the provider, and press **Refresh** on the environment |

## A file doesn’t check

The environment’s page shows the error, with the file’s line and field, and the board keeps planning from the last good copy. Fix it by pull request, with `npx breakaway infra check` passing first. A `policy.json` that doesn’t check falls back to the default, every plan waits for you, until it’s fixed. A `scaling.json` that doesn’t check acts on nothing.

## Recover without the board

The board can run your infrastructure, so the way back never depends on it. [Recover without the board](https://leavethepack.dev/docs/recovery/) is that way, and everything on it runs on your machine:

- **Before you need it**: export your tasks, environments, desired state, inventory, and the audit trail, once a month and after a big change.
- **Redeploy the board by hand**, from the install repository, with `wrangler`. The board’s own install is observe only, so it always comes back this way or through its Deploy, never through a plan.
- **Rebuild an environment by hand** from its `.github/breakaway-infra/<environment>.json`, with `wrangler` alone: data first, then the Worker.

While the board is down nothing applies, since the apply workflow only runs for a plan the board hands it. A change you make by hand meanwhile is break-glass: when the board is back it shows as drift, and [Mark as break-glass](https://leavethepack.dev/docs/architect-drift/#break-glass) records it. Rehearse the page once on a scratch account, so the day you need it isn’t the first time.
