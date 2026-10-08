# Updating to 2.0.0

> What updating a board from 1.5 to 2.0.0 changes by itself, what stays off until you connect a provider, what your repositories get, the GitHub permissions to accept, and how to go back.

2.0.0 brings **Architect**: the board can run what your repositories run on too, as environments, plans you approve, and incidents. It’s a major version because it’s a big change to what the board can do, not because updating is hard. **Updating needs nothing by hand**: no new binding, Durable Object class, migration, route, or cron, so Deploy updates the board the way it updated 1.5. **Architect stays off until you connect a provider**, and until then the board makes no call for it.

This page is for a board on 1.5.3, or on any 1.5 release. A board on a 2.0.0 pre-release has had all of this already; see [If you ran a pre-release](#if-you-ran-a-pre-release).

## Update

Update the way you always do ([Updating](https://leavethepack.dev/docs/deploying/#updating)):

- **`stable`:** merge the pull request the Update workflow opens for 2.0.0. Deploy runs.
- **`main`:** do nothing. The board starts Deploy by itself.

2.0.0 updates from any 1.5 release. Deploy checks it answers as 2.0.0 and goes back by itself if it doesn’t.

## What changes by itself

Once the board runs 2.0.0:

- **The board’s storage grows, and keeps what it had.** Architect’s tables are added when the board starts, the way every release adds what it needs. Nothing you stored changes.
- **Infrastructure** is a new view (`g` then `n`), and each repository’s page and settings get an Infrastructure section. With no provider connected, it says what to connect first.
- **A repository on the deploy flow shows up as two environments**, staging and production, on the next GitHub sync, and each deploy, Promote, and Roll back is recorded on them. Deploy, Promote, Roll back, and Release work as before.
- **Freezing production is the deploy pause.** Freezing a pipeline’s production on the board sets the repository variable `DEPLOYS_PAUSED`, and setting it on GitHub freezes production on the board. Until you accept the Variables permission ([below](#accept-the-github-apps-new-permissions)), a freeze holds on the board only.
- **The CLI and the MCP server can read infrastructure.** `npx breakaway infra` and its reads (`infra show`, `plans`, `plan`, `signals`, `incidents`), and six MCP tools that only read. Approving, rejecting, and freezing stay yours, on the board.
- **Routines can start on signals, on infrastructure events, and on new issues**, once you set those triggers on a routine: a plan waiting, applied, or failed, drift found, a budget passed, an incident opened, and the rest [Routines](https://leavethepack.dev/docs/routines/#ways-to-start-one) lists.
- **Costs show in US dollars** until you pick a currency in Settings. **Fetch today’s rate** there asks Frankfurter’s public rates for one exchange rate, only when you press it, sending only the two currencies.
- **Nothing pushes more.** Architect pushes only for a plan that waits for you and for a production incident, and neither can happen until a provider is connected.

## What stays off until you connect a provider

A board with no provider connected makes no call to any provider. Discovery, drift, signals, cost, and the cron’s comparisons run only for environments that have a provider and a desired state, and plans need both. Envelopes start empty, so every scale and restart waits for you until you set one.

To turn it on, connect Cloudflare’s read-only token on **Connections** (the permissions are in the manual’s [Providers and Connections](https://github.com/TheAnarchoX/breakaway/blob/main/docs/tasks.md#providers-and-connections)). The board only reads with it. Applying a plan in a repository takes more, all on GitHub and none of it on the board. Each repository’s card on Connections has a checklist, **Infrastructure tokens**, that walks you through it and checks each step:

1. In that repository, a **GitHub environment** for each environment that applies (named for it, like `staging`), limited to the default branch, holding that environment’s write token as `CLOUDFLARE_API_TOKEN`. The board refuses to start an apply while the GitHub environment lets another branch deploy. **Make it on GitHub**, on the checklist, makes a missing one with only the default branch allowed when the App has Administration: write ([below](#permissions-you-can-add)); the write token is always yours to add.
2. The repository variable **`BREAKAWAY_URL`**, the board’s address.
3. **The apply workflow**, `.github/workflows/breakaway-infra.yml`, on the default branch. A change you propose from an environment’s console brings it when the App has Workflows: write; otherwise run **`npx breakaway infra init`** in the repository and merge what it writes.
4. The board’s GitHub App with **Actions: read and write** on the repository.

[Get started with Architect](https://leavethepack.dev/docs/get-started-with-architect/) walks through all of it, from the token to your first approved plan. Short-lived environments share one GitHub environment, `short-lived`, with its own token. The manual’s [Architect](https://github.com/TheAnarchoX/breakaway/blob/main/docs/tasks.md#architect) section has the rest.

The board’s own install is always observe only: Architect watches it and never changes it.

## Accept the GitHub App’s new permissions

2.0.0’s App asks for three more permissions: Checks goes from read to read and write, and Variables and Issues are new. An App made before it keeps what it had until you accept them, and the board works without them, as the table says.

| Permission | What it’s for | Until you accept it |
| --- | --- | --- |
| **Checks**: read and write | An infrastructure change’s plan, posted as a check on its pull request | The pull request’s page on the board still shows the plan and says why there’s no check |
| **Variables**: read and write | Freezing production sets `DEPLOYS_PAUSED`, and the sync reads it | A freeze holds on the board only, and Connections shows **Deploy pause** with the fix |
| **Issues**: read, and the **Issues** event | Routines that start when an issue is opened or reopened | Those triggers never fire |

On GitHub, open your App’s settings, then **Permissions & events**: set the three permissions, tick the **Issues** event, and save. Then accept the new permissions on the App’s installation, once, for every repository it’s installed on.

### Permissions you can add

Three more are optional, and the App’s manifest doesn’t ask for them. Add one only for what it’s for:

| Permission | What it’s for | Without it |
| --- | --- | --- |
| **Workflows**: read and write | A change you propose from the board commits the apply workflow with it, when the repository needs it | The change comes without it and says so before you approve: run `npx breakaway infra init` instead |
| **Administration**: read and write | **Make it on GitHub** makes a missing GitHub environment with only the default branch allowed. Nothing else on the board uses it | The checklist gives the steps to make it by hand |
| **Environments**: read | The checklist reads a GitHub environment’s secrets by name, to see the write token is there, never its value | That step says it can’t check |

## What your repositories get

The files `repos init` copies into each repository (the core of the agent prompt, the stub, the `tasks` skill, and the shared `taskrc`) change in 2.0.0. A repository gets them when you run `npx breakaway repos init <slug> --update` in it and merge the result, as with any release:

- **The core** gains infrastructure work: agents read infrastructure wide and change it only by pull request, work an incident (diagnose, propose, write it up), and never apply, approve, or hold a write token. A kickoff’s plan can carry staging’s and production’s desired state and the apply workflow, when you answer Kickoff’s **Run it** step.
- **The `tasks` skill** says the same in its table.
- **The CLI**, which repositories run from npm as `npx breakaway` rather than as a copy, has the `infra` commands: the reads, `infra check` and `infra add` for a change, `infra adopt` to describe an environment that already runs, and `infra init` for the apply workflow.
- **The session hooks** move to the new major. A repository that runs them from `.claude/settings.json` (set up with `--copies`, or before the plugin) runs `npx --yes breakaway@1`, which never reaches a 2.x CLI; `--update` rewrites those hooks to `npx --yes breakaway@2`.

Claude Code’s plugin carries the new skill, and runs the 2.0.0 CLI, once the stable release moves it.

## What breaks or moves

- **Nothing breaks.** No setting, file, or command was removed or renamed.
- **The infrastructure sections of the manual moved** under [Architect](https://github.com/TheAnarchoX/breakaway/blob/main/docs/tasks.md#architect). Their links still work.

## If you ran a pre-release

If you ran `npx breakaway infra init` in a repository on a 2.0.0 pre-release, run `npx breakaway infra init --update` there and merge the result: the apply workflow has changed since (short-lived environments got their own GitHub environment, the runner now installs once, before any step holds the write token, and a run that applied nothing can be started again from the board). Check each GitHub environment that holds a write token is limited to the default branch.

## Going back

You can go back to 1.5.3 the way you go back from any release ([Rolling back](https://leavethepack.dev/docs/deploying/#rolling-back)): revert the update’s pull request on `stable`, or `wrangler rollback` on either channel. 2.0.0 adds no Durable Object class, so Cloudflare’s rollback works, and its data was only added to, so 1.5.3 reads the board as it was. Before you go back:

- **Let an apply finish.** 1.5.3 has no Architect, so a run that’s still applying can’t report back. Once you’re on 1.5.3, plans, environments, and the audit trail are kept, unused, until you update again.
- **Unfreeze production if you mean to deploy.** `DEPLOYS_PAUSED` stays as the board last set it, and 1.5.3’s Promote and Release still stop on it. Set it to `false` on GitHub to lift it.
- **The permissions you accepted** stay accepted, and 1.5.3 doesn’t use them.
- **Repositories you updated** keep the 2.0.0 core and skill, and `npx breakaway` stays 2.0.0’s CLI. Its `infra` commands say the board has no route for them, and everything else works.
