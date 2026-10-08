---
title: Drift, break-glass, and clean up
nav: Drift and break-glass
description: When what runs no longer matches its file. Where drift comes from and what the board does with it, how to change something by hand on purpose and put it back in code, and what happens to resources nobody owns.
---

## Drift

**Drift** is what runs no longer matching what the repository says should. The board compares each environment that has a provider and a file at most once an hour, and as soon as its file moves to a new commit. What differs shows on the environment, resource by resource, with what a plan would do to it. One drift makes one plan. The board never forces it back.

**Where it came from decides what the plan does:**

| Where it came from | The plan |
| --- | --- |
| **A change by hand**, or a deploy that set something the file says otherwise: the file didn’t move | A **draft**, with no push. Put it in front of yourself, reject it, or turn it into a task |
| **A merged change**: the file moved | The merge’s plan, which waits for you with one push |

A comparison that finds an open plan with the same changes makes none. A frozen environment’s drift is shown, and planned once you unfreeze it. **Compare now**, under the environment’s status band, compares it now.

Don’t approve a draft that would undo something you meant. Either put the change into code, or mark it as break-glass.

## Break-glass

**Break-glass** is a change you make by hand outside a plan, on purpose: an emergency the apply workflow can’t wait for, or a fix while the board itself is down. The board records it, adds a task to put it into code, and never undoes it.

### Change something by hand, the safe way

1. **Freeze the environment**, if the board answers, so nothing else changes it while you work ([Freeze, gates, and locks](/docs/architect-freeze/)).
2. **Make the change** on Cloudflare, with the dashboard or `wrangler`. [Recover without the board](/docs/recovery/#rebuild-an-environment-by-hand) has the commands for each kind.
3. **Check it’s healthy.** Open the Worker’s address, or your health address.
4. **Compare now** on the environment’s page. What you changed shows as drift.
5. **Mark as break-glass**, under the status band while the environment has drift, with a note saying why. The board compares again, so the mark covers what differs now, then records it in the audit trail, rejects the open drift plans that would undo it, and adds a task tagged `+break-glass` that says, change by change, what to write into the environment’s file.
6. **Unfreeze**, once you’re done.
7. **Put it in code.** An agent on the `+break-glass` task, or you, opens the pull request. Once the file says what runs, or the change is gone, the mark is settled and drift is planned as usual again.

While a mark stands, the board makes no drift plan that would undo it. It refuses a mark while an approved drift plan is about to apply: reject that plan first.

## Nobody owns

Something that runs in an environment’s scope, isn’t in its file, and nothing else owns (not the environment’s target, not a short-lived environment’s, not a break-glass mark’s) is one **nobody owns**. The board flags it on the environment’s page, with an audit entry.

A week later, the board makes one removal plan for everything that’s due. It always waits for you, since a delete trips the destructive guard.

- **Approve** it, and they’re removed.
- **Reject** it, and the board keeps them and proposes them no more.
- **Put them in the file**, by pull request, and the flag drops.

A frozen environment’s flags wait. An observe-only environment, and the board’s own install, are never flagged.
