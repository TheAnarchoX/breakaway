# Change an environment

> Two ways to change what runs, both ending in a plan you approve. From the console, where you edit the map, watch the plan form, and the board opens the pull request; or by pull request, from an agent or from you.

Every change to an environment is a pull request that changes its file, and every pull request ends in a plan you approve. There are two ways to get there:

| | From the console | By pull request |
| --- | --- | --- |
| Who | You, on an environment’s page | An agent, or you, in a checkout |
| What you edit | The map: settings, new resources, removals | The file in `.github/breakaway-infra/`, and code with it |
| The pull request | The board opens it, on its own branch | Whoever made the change opens it |
| The plan | Forms beside the map as you edit, and shows as a check | Shows as a check on the pull request |
| Approve | **Approve** on the change’s card merges it and applies the plan | You merge it; then its plan waits for you, and **Approve** applies it |

Use the console for what you can see and set: a setting, a new queue, a removal. Use a pull request for what needs code with it, or many files, or an agent’s judgment.

## From the console

Open an environment’s page. Its map is where you change it.

1. **Change it.**
   - **Change**, on a resource’s detail, turns the settings the console may change into fields ([What’s supported](https://leavethepack.dev/docs/architect-supported/#kinds-of-resource)). Variables and secrets show by name only: “Set with the Worker’s deploy, never here.”
   - **Add resource**, above the map, lists every kind Cloudflare can add, a line each on what it’s for, then your golden paths and breakaway’s `queue`. A kind asks for its name, checked as you type, its settings with Cloudflare’s defaults filled in, and **Bind it to**: the Worker whose code uses it, with a binding name suggested from its name. **Add to the change**, and it shows dashed on the map, marked **+ adds**.
   - **Remove**, on a resource’s detail, takes it out.
2. **Watch the plan form.** Your change shows beside the map at once, an edit a line, and each resource you edited is marked “your change”. About a second and a half after your last edit, the board previews the plan: what changes, what it costs, what else it touches, what can’t be undone, and the policy’s answer. Nothing is written yet, and the change is kept only in this browser. **Discard** drops it.
3. **Propose the change.** One press, and no confirm, since nothing that runs changes. The board checks the plan once more, commits the file on its own branch, `breakaway/infra/<environment>-<n>`, and opens the pull request, “Change staging: …”. It closes no task.
4. **Approve.** The change’s card reads **Checking** while the plan check runs, then **Waiting for you**. **Approve** asks: “Approve this plan for staging? The board merges its pull request, applies the plan, and rolls back if the health check fails.” When merging also deploys, it says so.
5. **Follow it.** The card reads **Merging**, then the plan’s own status: **Approved**, **Applying**, then **Applied** once the health check passes ([Plans and approvals](https://leavethepack.dev/docs/architect-plans/#after-you-approve)).

**Reject** asks “Reject this change? The board closes its pull request. Nothing changes.”

### What the board checks before it merges

Approve merges the pull request as your press, the way **Merge** does, and only when:

- the pull request is still at the head you saw, and still the board’s;
- the environment isn’t frozen or observe only;
- the plan at that head is the one you saw, and the policy doesn’t refuse it.

Then it merges with that head commit, so a push in between refuses. While checks run, it turns on auto-merge, or merges at the first sync after they pass. After the merge, the board plans from the default branch and applies only when that plan is the one you approved; otherwise it waits for you with a push. An approval waits at most 24 hours for its merge, then asks again.

### One change per environment

Every edit joins the environment’s one change, up to 50 edits. Edits are kept as steps (set a setting, add from a template, remove), so when the file moves on the default branch, the board replays them on the new one and drops, with a line, any whose resource is gone. **Propose again** replays your edits on the current head, and replaces the board’s commit on its branch.

If someone else pushes to the board’s branch, the change is **taken over**: it’s an ordinary pull request from then on, Approve goes away, and its plan waits for you after you merge it.

### What the console can’t change

Code, the policy, `scaling.json`, your templates, and any setting Cloudflare doesn’t let the console change stay a pull request. **Have an agent do it** starts a general agent with what you were changing, for you to read and edit first. A Durable Object or a container needs code first: **Have an agent write it** starts an agent on that code.

## By pull request

An agent changes infrastructure the way it changes code. In a checkout:

```sh
npx breakaway infra adopt staging                 # the first file, from what runs
npx breakaway infra add queue staging name=jobs worker=widgets-api-staging
npx breakaway infra check staging                 # the plan it would make
git switch -c wgt-12-jobs-queue && git add -A && git commit -m "WGT-12: Add the jobs queue"
```

Then an ordinary pull request. On it:

- **The plan check.** Each sync, a pull request that changes an environment’s file or `policy.json` gets one check, **breakaway: infrastructure plan**, on its head commit, and the board’s pull request page shows the same under **Infrastructure plan**: for each environment it changes, up to 5, the plan it would make and the policy’s answer. It fails when a file doesn’t check, names an observe-only environment, or the policy refuses the plan. It’s neutral when something couldn’t be planned. It passes otherwise, even when the plan will wait for you, which is the default.
- **Merging applies nothing.** The check is a preview. Once it merges, the board compares the environment with the new file, and that plan waits for you with one push: “A plan waits for you in staging.” Open it, read it, press **Approve**.

This is how every agent’s change reaches you, and every incident’s fix.

## When it doesn’t merge

| What you see | What to do |
| --- | --- |
| **Can’t merge**, with why | Fix what it names (checks failing, a conflict), then **Propose again** |
| GitHub refuses the merge for a required review | Add the board’s GitHub App to the ruleset’s bypass list: the repository’s **Settings**, **Rules**, **Rulesets**, the rule, **Bypass list**. The App merges only on your press. Until then, review the pull request on GitHub |
| **Staging is frozen: unfreeze it to approve.** | **Unfreeze** staging, or leave it frozen until you’re ready. You can still edit and propose |
| “What runs changed since you looked. Here’s the plan now.” | Read the new plan before you approve it |
| “The plan changed between your approval and the merge.” | It waits for you again, with a push. Read it and approve it, or reject it |
| A note that applying needs `.github/workflows/breakaway-infra.yml` | Give the App **Workflows: write** and **Propose again**, or run `npx breakaway infra init` in the repository and merge it ([Tokens, GitHub, and the apply workflow](https://leavethepack.dev/docs/architect-connections/#the-apply-workflow)) |
