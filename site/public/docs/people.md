# People and roles

> Invite the people you work with to your own board. Each signs in with a passkey, holds a role in each repository, starts agents on their own Claude, and every change names who made it. You stay the owner.

One board can be a whole group’s. You invite the people you work with by a link you share by hand. Each one signs in with a passkey, holds a role in each repository you give them, and starts agents on their own Claude. Every change names who made it. It all stays in your install: there’s no sign-up, no hosted account, no email, and nothing new leaves your board. Until you invite someone, nothing changes, and **Settings, People** says it’s just you.

## You stay the owner

The owner is the person behind the board’s token: you. The token always signs you in, from any sign-in page, whatever anyone else does. Nobody can demote, remove, Reset, or replace you, and there’s no second owner. Only `npx breakaway rotate-token` changes the token, and it needs your Cloudflare login.

Under **Settings, You** you can add passkeys of your own, to sign in with a fingerprint, face, or device PIN instead of pasting the token, and a display name, which people see beside “(owner)”, like “Ana (owner)”. Your handle stays `owner`. A new board offers **Add a passkey for yourself** in **Set up the board**; a board that’s already set up doesn’t ask.

Want someone else to have every right you can give? Make them a maintainer of every repository.

## Invite someone

1. Open **Settings, People** and press **Invite**.
2. Pick a role, the repositories it’s for, and how long the link works (7 days, or 1 to 30).
3. Copy the link and send it to them yourself, however you like.

Opening the link shows who invited them and the role. They pick a name and a handle and make a passkey, and they’re in. A link works once; you can revoke it under **Open invites**, and an old or used one says so and tells them to ask you for another.

A handle is lowercase, up to 32 characters, and fixed: it’s the name Activity shows. It can’t be `owner` or look like an agent’s name.

## Roles

A person holds one role in each repository you give them, and sees only those repositories: their tasks, Activity, pings, pull requests, peloton, Infrastructure, and specs. A task that waits on one they can’t see says it waits on “a task you can’t see”.

| Role | What they can do in a repository |
| --- | --- |
| **viewer** | Read everything, Infrastructure and its costs included. Change nothing. |
| **member** | A viewer, plus: add, edit, claim, comment on, and hand over tasks; add ideas; start agents on their own Claude; message and answer the pings of agents they started; post on the peloton; propose changes, which wait for a maintainer. |
| **maintainer** | A member, plus: merge, promote, and roll back; run workflows; approve plans and changes; envelopes outside production; freeze; answer decisions; resolve any ping; routines, chases, and Force start; releases; and manage the people in their repositories. |

**Every repository** covers the ones you add later too. A button someone’s role can’t use stays on the page, locked, with who can use it.

**Always yours**, whatever anyone’s role: the token; making maintainers and giving every repository; connections and secrets (the GitHub App, providers’ tokens, each repository’s own Claude routine, push); adding and removing repositories; the install itself and the board’s settings; loosening a policy or an approval rule; and envelopes on production.

**Who manages whom.** You manage everyone. A maintainer invites members and viewers to the repositories they maintain, and can change, Reset, or remove someone only when every role that person holds is in those repositories and they aren’t a maintainer.

## Signing in

| Who | The web board | The CLI and MCP | Their agents |
| --- | --- | --- | --- |
| You | The token, or your passkey | The board’s token | The board’s token, in the repository’s cloud environment |
| A person | Their passkey | Their personal token | Their personal token in their own cloud environment, or a run key on a routine you lend |

- **Passkeys.** Add one on each device under **Settings, You**. The board checks them itself and keeps only each one’s public key. **Sign in with a passkey** shows on the sign-in page once anyone has one.
- **Personal tokens.** Made under **Settings, You**, one per place (“laptop”, “cloud environment”). It starts `bkp_`, shows once, and goes wherever the board’s token goes for the [CLI](https://leavethepack.dev/docs/cli/) and [MCP](https://leavethepack.dev/docs/mcp/), with that person’s role. It can’t sign in to the web board, so a token in an agent’s environment can never press Merge or Approve.
- **Sessions** last 30 days, renewed as they’re used. **Sign out everywhere** ends them all.
- **Taskwarrior sync stays yours.** It copies every task, so it isn’t a way in for anyone else.

## Reset and remove

Lost passkey? Whoever manages that person presses **Reset** in People. It stops their passkeys, personal tokens, and sessions at once, and gives a new link, with the same roles, to send them. There’s no self-service reset and no recovery codes. You recover with the token, and a lost token with `rotate-token` ([When something’s lost](https://leavethepack.dev/docs/operations/#when-somethings-lost)).

**Remove** stops all of that and forgets their own routines. Their name stays on what they did, shown as removed.

## Profiles

Under **Settings, You, Profile**, anyone, you included, can say what **work** they do (Engineering, Design, Product, Writing, Operations, Research, Organising, or their own words) and give **notes for agents**: one line like “new to Git, explain the steps”. Agents started for them read it and pitch their answers to it. It never changes what anyone may do. Each person’s avatar is a pattern from their handle; **Shuffle** picks another.

## Their own Claude

A person’s agents run on their own Claude, not on your plan. Under **Settings, You, Your Claude**, they pick a repository, make a routine on claude.ai with the steps it shows, and paste its URL and token. Their cloud environment gets their personal token for the board, never the board’s token.

- **Their caps** come from the routine’s Claude plan (Pro, Max 5x, or Max 20x), which they pick as they connect it. You can lower anyone’s caps from People. The board’s own limits still count everyone’s agents together, so nobody crowds out the rest.
- **What runs where.** Agents a person starts, chases they start, and routines they made run on their routine. Start when ready, and agents you start, run on the repository’s routine, as before.
- **The Agents view** shows running agents and the queue for each person.

### Lend a routine

Someone without a routine of their own can’t start agents in a repository until you lend one. On the repository’s page, **Lend a routine** takes a second routine of yours, on your plan, in a cloud environment **without** the board’s token. Each person starts at most 1 agent at once and 5 an hour on it.

Each agent on a lent routine gets a **run key**: its only way in, with exactly its person’s rights, ending with its claim (and after a day at most). If a lent agent ever arrives with the board’s token too, the page warns you that its environment adds it, and says how to take it out. **Stop lending** forgets the routine.

## Who did it

Every change records the person who made it, and when an agent made it, who it worked for: “claude-brk-12 for Ana”. Activity, comments, the inbox, decisions, the peloton, the infrastructure audit, and the comment the board leaves on a pull request it merges (“Merged on the board by Ana”) all say so.

An agent can do no more than the person it works for, and never what only a person can press: it never merges, deploys, approves, answers a decision, or resolves a ping, whoever started it.

## Two people to approve

Each environment has an approval rule, under **Who approves its plans** on its repository’s page: **One maintainer** (the default, and you always count as one), **Two different maintainers**, **The owner**, or **The owner and one other person**. With two, neither may be the person who proposed the change. A plan that waits shows who has approved and who else can. Making it stricter is a maintainer’s; loosening it is yours. The rule lives on the board, so a pull request can’t lower the bar for its own plans.

If nobody else can give the second approval, you can **Approve alone**, after a second confirm, and the [audit trail](https://leavethepack.dev/docs/architect-plans/) says so. While you’re the only person on the board, there’s no rule to pick at all. A plan inside an [envelope](https://leavethepack.dev/docs/architect-envelopes/) still applies without a press.
