# BRK-258 · Plan from the board

Task: BRK-258 on the board, in the `architect` feature · Status: draft

## Problem

Today a plan comes from a pull request that changes `.github/breakaway-infra/<environment>.json`, or from drift ([IDEA-19](IDEA-19-architect.md#change)). Somebody has to write that file: an agent, or the owner in an editor. The owner hasn't opened a code editor in weeks and won't start now. Changing an environment has to be a smooth flow on its console ([WEB-94](WEB-94-environment-console.md)): change what you see, watch the plan form as you go, propose it, approve it, done.

What must stay true while it gets easy:

- **Desired state lives in the repository and changes by pull request.** The file on the default branch is still the only source of what should run, and the plan check still runs on every change to it (BRK-185).
- **The board holds no write credentials for a provider.** It plans with the read-only token; only the apply workflow, started for one approved plan, holds a write token.
- **Apply is never a button.** You approve; the board applies.
- **Agents never merge.** Every write here is the owner's press, cookie-only, like Merge.

## What it became

You change an environment on its console. Each edit joins one **change** for that environment, and the board shows the plan it would make beside the map while you edit. **Propose the change** has the board commit the new desired state through its GitHub App, on a branch of its own, and open the pull request; the plan check runs on it as on any other. You never have to open it. When the check is done, the change waits for you on the console. **Approve** merges the pull request as your action and, once the merged file plans to exactly what you approved, queues the apply with the usual checks. One press, the same guarantees as approving a plan today.

### 1. What you can change from the console

**A resource's settings, from its node's detail.** The node detail gets **Change**, which turns its settings into fields. The provider says which settings those are: a new, optional `editable(kind)` in the provider interface (BRK-262) lists, per resource kind, each setting the console may change, with its path, type (text, a number with bounds, yes or no, a choice, a list of names, or a binding to another resource in the environment), and a line of help. The console draws fields from that list and never names a vendor, the same rule the rest of Architect keeps. Cloudflare's list is exactly what its plan manages ([Plan and apply, as built](IDEA-19-architect.md#plan-and-apply-as-built-brk-192)): a Worker's compatibility date and flags, usage model, observability, placement, cron triggers, and bindings to the environment's databases, namespaces, buckets, queues, and Workers; a queue's delivery delay, pause, and retention; R2's CORS and lifecycle; a container's `max_instances` (its scale); a route's pattern and Worker; a custom domain's Worker. Cloudflare Workers have no memory setting, so there's no memory field: the console offers what the provider can change and nothing it can't.

*Why the provider declares it:* the plan already refuses what it doesn't manage, so a field the provider didn't declare would only ever produce an error. Declaring it once keeps the console honest and vendor-free.

**Variables and secrets, by name only.** The detail lists them by name and type, read only, with one line: "Set with the Worker's deploy, never here." The provider refuses any change to a variable, and the board never reads or holds a value; that stays.

**Add from a template.** The templates sit in **Add resource**'s picker (WEB-107), below the kinds the provider can add; it lists the repository's golden paths (CLI-15: `.github/breakaway-infra/templates/<name>/template.json`, read from the default branch) and the one breakaway ships (`queue`), and asks for the template's inputs as a form, with each input's help and default. What `infra add` would write into the file (its `resources` and `extend`) joins the change. A template that also writes code files (`files`) names them under the form, and they go in the same commit; a file the repository already has, or one under `.github/workflows/`, is refused, as `infra add` refuses it. *Why:* templates are the owner's own opinions, already reviewed; the console uses them rather than inventing a second way to add a resource.

**Add a resource (BRK-270).** The provider also says which kinds the console may add: an optional `creatable(kind)` gives each one's label and line of help, its name's rule (a pattern and a length, unique among the kind in the file and what runs; the plan checks the rest of the account), the fields only a new one is given (a route's zone), which of its fields are required, and their defaults; how a Worker binds it, and whether the plan makes one only when something binds it; and, for a kind made by code (a Durable Object class, a container application), `needsCode`: what code must exist, since the plan won't make one and finds it by name once the deploy has. A `create` edit, `{ op: 'create', kind, name, attrs, bindTo?: { worker, binding } }`, writes the resource into the file with an ID the plan and drift treat as new and, with `bindTo`, adds the binding (upper snake case, unique on that Worker) so a new queue is usable in one change. `GET /api/infra/environments/<id>/editable` answers `creatable` beside `kinds`, each kind with one list of fields marked `required` or carrying their `default`. Cloudflare's covers every kind its plan knows: Worker (made with a starter script that answers `/health`, until the deploy puts its code on it), queue, R2 bucket, KV namespace, and D1 database (each bound by a Worker), route and custom domain (on a zone, to one of the environment's Workers), Durable Object, and container.

**Add resource (WEB-107).** One **Add resource** button, on the resources panel's header in the map and the list, and as the call to action of an environment with nothing in it, opens a picker: every kind `creatable` lists, a line each on what it's for (a kind made by code marked "needs code"), then the templates. A kind's form asks for its name, checked against its rule as you type, its fields with their defaults filled in, and **Bind it to**: a Worker of the environment (one the change adds included), with a binding name suggested from the resource's name in capitals; for a kind the plan makes only when bound, a Worker is picked up front. A kind made by code says what code must exist, with **Have an agent write it**, which opens New agent with the class or image and the settings as its prompt; the same line shows under its edit in the change. **Add to the change** joins the create edit; the map draws the new resource dashed as **+ adds**, with a line to what binds or serves it, before the board's preview answers and after.

**Remove a resource.** **Remove** on a node's detail. The preview says at once when the provider would refuse it (the environment's target, something a remaining Worker still binds or calls) and that a delete can't be undone.

**Several edits, one change.** Every edit, removal, and template joins the environment's one change until you propose it or press **Discard**. It's kept in this browser until then (per environment, so a reload keeps it); it's yours alone and nothing on the board until proposed. An edit is an operation, never a copy of the file: set a setting on a resource, add from a template with these inputs, remove a resource. So when the file moves on the default branch while you edit, the board replays your edits onto the new file, and an edit that no longer applies (its resource is gone) is dropped with a line saying so. At most 50 edits in one change, the file at most 256 KB, and the plan at most its 1,000 changes, as today.

### 2. The flow

1. **Edit.** On the console, **Change** on a node, **Add resource**, or **Remove**. Edited nodes carry the plan's marks as you go (**+ adds**, **~ changes**, **− removes**), labelled "your change", so the map reads the same as it does for a waiting plan.
2. **See the plan as you go, at two speeds.** At once, in the browser, the change as words, an edit a line ("~ widgets-api: usage model standard → bundled"). Then the board's own preview: the console sends the edits (`POST /api/infra/environments/<id>/changes` with `{ edits }`, BRK-259), and the board applies them to the file at the default branch's head, checks it (`checkDesiredFile`, the provider's `checkDesired`, the template's inputs), and runs `previewInfraPlan` with the policy at the head. It answers the provider's diff, the cost change, what else it touches, what can't be undone, the policy's verdict a rule a line, any problem on the field it belongs to, the head it planned from, and the plan's digest. Nothing is written.
   *How often:* the console asks 1.5 seconds after your last edit, one request at a time. The board answers the same edits on the same head from a minute-long cache, and plans an environment at most 6 times a minute; past that it says when to ask again, and the console shows **Checking…** until then. *Why:* a provider's plan discovers what runs live (Cloudflare's lists the environment's Workers and their settings every time), and providers limit a token's calls; a preview per keystroke would spend the read token's budget the inventory refresh and drift need.
3. **Propose the change.** One press (cookie-only). The board computes the preview once more and refuses to propose one whose provider refuses it. Then it commits and opens the pull request (point 3). The console swaps the editing panel for the change's card, which follows it without you leaving the page: **Checking** (the plan check is running), **Waiting for you** (with **Approve** and **Reject**), **Merging**, then the plan's own states, **Applying**, **Applied**, **Failed**, or **Rolled back**. Proposing changes nothing that runs, so it asks no confirm.
4. **Approve** (point 4). Or **Reject**, which asks "Reject this change? The board closes its pull request. Nothing changes." and does that.

### 3. How it stays true to "desired state lives in the repository"

**The board writes the pull request itself, through its GitHub App.** No agent: an edit to a JSON file needs no judgment, and an agent's run would cost minutes and a slot for each change. The App already writes contents and pull requests for Merge, and the board already opens pull requests of its own for a spec's status (BRK-215, `src/store-specs.js`), so no new permission and no new pattern. The board never commits to the default branch directly: the branch and pull request keep branch protection, the plan check, the repository's own CI, and the history where they are.

- **The branch** is the board's own, `breakaway/infra/<environment>-<n>` (the change's number), one commit on the default branch's head: the environment's file, written as JSON with two-space indents and a final newline (a hand-formatted file is reformatted once; keys and order the change didn't touch stay), plus a template's code files. The commit's message is "<environment>: <the change in a line>".
- **The pull request** is titled "Change <environment>: <the change in a line>", carries no work ID, and closes no task. Its description says what changes in words, the preview's summary, and "Proposed on the board's console. Approving its plan on the board merges it; nothing applies before." The board schedules a sync at once, so the plan check (BRK-185) posts on it within seconds, exactly as on an agent's.
- **One open change per environment.** Proposing again while it's open replaces its commit on the board's branch (the only branch the board ever moves by force) and resets any approval, and the plan check runs again on the new head.
- **The board keeps each change** (`src/store-infra-changes.js`, table `infra_changes`): environment, repository, the edits, the head it planned from, the commit it wrote, the branch, the pull request, the preview's digest and policy verdict, the approval, its state (`open`, `approved`, `merged`, `rejected`, `closed`, `taken over`), and why it stopped. Every write appends to the audit trail with the environment, under a new kind, `change` (proposed, replaced, approved, merged, couldn't merge, rejected), by `owner` or `board`.
- **A pull request someone else pushes to stops being the board's.** When the head isn't the commit the board wrote, the change is **taken over**: the console shows it as an ordinary pull request with a link, Approve goes away, and after it merges its plan waits for you as any merged change's does. *Why:* an approval binds to what the board wrote and planned, never to a commit nobody looked at.

### 4. One press to approve

**Approve** is on the change's card and on the board's pull request page for that pull request. It's the owner's: `POST /api/infra/changes/<n>/approve` with `{ sha, digest }` (the head and the plan you saw), cookie-only in `worker.js`, the `by` check second. The confirm asks and says what follows:

- "Approve this plan for staging? The board merges its pull request, applies the plan, and rolls back if the health check fails."
- For production, the same with "production". When the repository's pipeline deploys on merge, it adds "Merging also deploys staging." (Merge's dialog says the same.)

On the press, before anything merges, the board (BRK-260):

1. reads the pull request: still open, its head the commit the board wrote and the `sha` you saw (else: "#12 changed since you looked. Read it again."), and the change still the board's;
2. checks the environment: not observe only, not frozen ("Staging is frozen: unfreeze it to approve.");
3. computes the preview again at that head: its digest must be the `digest` you sent and the one the change kept, and the policy must not refuse it. Otherwise nothing merges and the console shows the new plan: "What runs changed since you looked. Here's the plan now.";
4. keeps the approval on the change (the digest, the policy's rules, when), with an `approve` audit entry, by `owner`;
5. merges, as the owner's action, the same way Merge and Merge when green do (CLD-57, `githubWrite`): with the head sha, so a push in between refuses; squash when the repository allows it, else a merge commit. Ready → it merges now. Checks still running → it turns on GitHub's auto-merge for that head (Merge when green), or, where the repository doesn't allow auto-merge, merges at the first sync after the checks pass. Behind the default branch, where protection requires it to be current → it updates the board's own branch from the default branch (a merge commit) and goes on as above.

**After the merge,** the board reads the desired state and compares the environment at once (what **Compare now** does), and drift makes the plan from the merge, as it does for any merged change (BRK-246: source `pull-request`, `#<n>`). Drift leaves deletes to clean up, so for a merged change of the board's the plan also keeps the removals that change asked for, and nothing else. When that plan's digest is the approved one, and its policy names no rule the preview didn't, the board approves it on your recorded press (summary "approved on the console before #12 merged; digest …") and queues the run: the executor's checks are unchanged (still approved, digest, not frozen, not observe only, the runner's workflow there, the lock). When it differs (something changed by hand, or another merge moved what runs between your press and the merge), the plan waits for you with the usual push, saying why: "The plan changed between your approval and the merge." *Why approve before the merge:* you already saw the exact plan, and the digest binds your press to exactly that diff, the guarantee approving a plan gives today. Asking again after the merge would be the second press the owner asked not to make; merging without asking would be the board acting alone.

**When the merge can't happen,** nothing merges and nothing applies; the change stays approved and its card says why, with GitHub's own words:

- **Checks failing** or **has conflicts**: "Can't merge #12: checks failing." with **Propose again** (the board replays your edits on the current head and replaces the commit; the new plan needs a new approval) and **Reject**. Conflicts happen when someone else changed the same file; replaying the edits resolves most of them without anyone reading JSON.
- **GitHub refused** (a required review, a ruleset): its message, and a link to the pull request on GitHub, since a review there is a person's and not the board's to give.
- **The board's App can't write**: the permission line Merge already shows, and Connections.
- **An approval waits at most 24 hours** for its merge; after that it lapses and the card asks again. *Why:* an approval should mean "now", not "whenever GitHub gets to it".

**Lock and freeze after the merge** work as for any approved plan: another plan holding the lock makes this one wait its turn; freezing the environment after the merge stops it before it applies.

**Agents can't do any of it.** Propose, Approve, Reject, and Propose again are cookie-only; the bearer token agents, the CLI, and cloud sessions hold gets a 403. An agent's pull request still merges only when you merge it, and its plan still waits for you after.

### 5. What stays a pull request anyway

- **`policy.json`, `scaling.json`, `short-lived.json`, and the templates.** They're the rules your approvals rest on: what waits for you, what scales by itself, what a template adds. Changing them on the same screen where you approve would let one tired press widen what passes without a second look. They change rarely; an agent's pull request is fine for them.
- **Code**: a Worker's code, migrations, Durable Object classes, container applications, and anything the provider doesn't declare editable or doesn't make. The console can add a Durable Object or a container to the file, but its code comes by a pull request, and the plan waits for it.
- **Values of variables and secrets**: never on the board.

Where the console can't express what you want, its line says so and offers **Have an agent do it**: it starts a general agent in the environment's repository (the board's existing start from a prompt), with the prompt filled in with the environment and what you were changing, and you edit the words before you start it. The plan from its pull request waits for you after the merge, as now.

**Describe it as code (WEB-92)** becomes the first change. An environment with no file starts the console from the board's draft (BRK-240): **Propose it** opens the board's pull request with the draft as the file, with or without your edits on top. The draft matches what runs, so a draft with no edits plans nothing, and its card shows **Merge** (the owner's, as on the pull request page) instead of Approve; with edits, it's Approve as above. **Have an agent open the pull request** stays beside it, for when you want an agent to do it.

### 6. The words

From the brand guide's Infrastructure words (DOC-42 adds what's new):

- **change**: what you edit on an environment's console before it becomes a plan; the board opens its pull request. Don't say proposal (the guide rules it out for a plan), draft (a plan's status), or edit set.
- **Buttons**: **Change** (a node's detail), **Add resource** (with **Add to the change**, **Pick another**, and **Have an agent write it** in its forms), **Remove**, **Discard**, **Propose the change**, **Propose it** (an environment with no file), **Approve**, **Reject**, **Propose again**, **Merge** (a change that plans nothing), **Have an agent do it**. Never Apply.
- **The change's card** reads **Checking**, **Waiting for you**, **Merging**, **Can't merge**, then the plan's **Approved**, **Applying**, **Applied**, **Failed**, or **Rolled back**.
- **Lines**: "Set with the Worker's deploy, never here." "What runs changed since you looked. Here's the plan now." "The plan changed between your approval and the merge." "Can't merge #12: checks failing." "Staging is frozen: unfreeze it to approve."
- **No new push.** Proposing doesn't push (you just pressed it); a plan that waits after a mismatch pushes as any waiting plan does.
- **The claims stay true.** "Nothing merges or deploys on an agent's word": Approve is your press. "Nothing changes without your approval, or inside bounds you approved once": the digest binds the apply to what you approved. docs/tasks.md's list of what the board writes to GitHub gains the change's branch and pull request, and Approve merging it.

### First run, empty, and errors

- **No provider connected, or no inventory yet**: no Change; the console's existing line says what to connect.
- **Observe only**: no Change, and one line: "Observe only: the board watches it and never changes it."
- **Frozen**: you can edit and propose (it changes nothing that runs); the preview's policy says it's refused, and Approve waits for Unfreeze.
- **No templates in the repository**: Add resource lists breakaway's `queue` and says templates go in `.github/breakaway-infra/templates/`, with **Have an agent do it**.
- **GitHub down** (BRK-217): Propose and Approve say so and wait; your edits stay in the browser.
- **Phone**: Change opens the detail full width, its fields one under another, and the preview under them; Propose sits at the bottom of the screen.

## Out of scope

- Editing the policy, scaling rules, short-lived template, or golden paths on the board (point 5).
- Editing code, or any value of a variable or secret.
- Approving the plan of an agent's or a hand-written pull request before its merge. The same digest binding would work; it waits until this has run on staging.
- More than one open change per environment, or one change across environments (carrying staging's change to production is a later idea).
- The board writing to the default branch directly, or approving a GitHub review.
- A preview that doesn't ask the provider (a plan from the inventory alone): the provider's plan is what applies, so it's what the preview shows.

## Open questions

- **A ruleset that requires an approving review on the default branch** refuses the App's merge, and the owner would review the board's pull request on GitHub. Is that acceptable, or should the board's branch get a bypass in the repository's ruleset? That's the owner's setting either way; the card says GitHub's reason until then.
- **Squash or merge commit**: the board squashes when the repository allows it. If the owner prefers this browser's merge method (what Merge uses), the console can send it.

## Build tasks, in order

| Order | Task | What | Waits for |
| --- | --- | --- | --- |
| 1 | BRK-259 | The changes route: edits → file → preview (`src/infra-changes.js` pure, `src/store-infra-changes.js`, table `infra_changes`); Propose commits and opens the pull request; replace, reject, take over; the `change` audit kind | BRK-258 |
| 1 | BRK-262 | Providers say which settings the console can change (`editable(kind)`, Cloudflare's and the fake's, `GET /api/infra/environments/<id>/editable`) | BRK-258 |
| 2 | BRK-260 | Approve merges the board's pull request and, once the merged plan's digest matches, queues the apply; can't merge, lapse, the removals drift keeps | BRK-259 |
| 3 | WEB-99 | The console: Change, Add from a template, Remove, the live preview, Propose, the change's card with Approve and Reject, Describe it as code as the first change | BRK-260, BRK-262, WEB-100 |
| 4 | DOC-42 | The words in the brand guide, docs/tasks.md, and IDEA-19's spec as built | WEB-99 |

Then BRK-207, the owner's first staging plan, is made from the console.

## Done when

- From an environment's console, the owner changes a setting, adds a resource from a template, and removes one, sees the plan update as they edit, and proposes it, without opening GitHub or a file.
- The board opens the pull request on its own branch; the plan check runs on it; Approve merges it and, when the merged plan is the one approved, the board applies it, with every check it makes today.
- A plan that changed between the approval and the merge waits for the owner with a push; a change that can't merge says why and applies nothing.
- No agent token can propose, approve, or merge; the board holds no provider write credentials; apply is never a button.

## How to check it

1. Open **Infrastructure**, then your staging environment.
2. Select a Worker on the map and press **Change**. Change one setting (its usage model, say). Within a few seconds the plan beside the map should say what will change, what it costs, and whether it can be undone.
3. Press **Add resource**, pick **Queue**, give it a name, and pick the Worker under **Bind it to**. The map should show a dashed new queue with a line from the Worker, and the plan should list both.
4. Press **Propose the change**. The card should say **Checking**, then **Waiting for you**. You don't need to open GitHub; if you do, the pull request is there, opened by the board.
5. Press **Approve** and confirm. The card should go **Merging**, then **Applying**, then **Applied**, and the environment's stream should show the merge, the approval, and the apply.
6. Freeze staging, make another change, and propose it. Approve should say staging is frozen, and nothing should merge.
