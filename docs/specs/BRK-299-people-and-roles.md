# BRK-299 · People and roles: one install for a group

Task: BRK-299 on the board, in the `people` feature · Status: draft

## Problem

An install has one person in it: whoever holds the board's token. A group that wants to share an install (a co-op, a digital rights group, two friends on one codebase) has two bad choices today. One is to share the token, and then everyone is the owner and Activity can't say who did what. The other is to keep it to one person, and then everyone else waits on them to merge, approve, and start agents.

There's a second problem: "owner" isn't an identity in the code today. It's one of two tests:

- **The web cookie.** About 45 routes in `src/worker.js` refuse anything but the signed-in browser (`via !== 'cookie'` → 403): merge, promote, roll back, approve and reject plans and changes, envelopes, policy, connections, and more.
- **An empty `by`.** Around 30 store files check that the request's self-declared `by` is empty or `'owner'` (`ownerOnly` in `store.js`, `owners` in six `store-infra-*.js` files, `isOwner`, `ownerOnlyRepos`, `ownerOnlyKickoffs`, `ownerOnlyFeatures`, and inline copies). Any bearer call that leaves out `by` passes as the owner, and Activity records it as `owner`.

The MCP server is the exception: every write there names an agent, so it can never act as the owner (`src/mcp.js`, `RESERVED`).

This spec decides who can be in an install, how they sign in, what each role may do, how agents act for the person who started them, how each person brings their own Claude, and how all of it is recorded. It doesn't build anything. The build tasks already exist on the board and are listed in order under **Done when**.

## Fit

- **Free and self-hosted.** People are added inside one person's install, on that person's Cloudflare account. There's no sign-up, no hosted account, no tenant, no organization object, and no price: an install still has exactly one owner, who invites the rest. "No accounts, teams, tenants" in `AGENTS.md` becomes "no hosted accounts, sign-up, tenants, or teams you pay for", with people and roles inside your own install (DOC-46 changes the words; point 8 below).
- **An install keeps its data.** No email, no third-party identity provider, no OAuth with GitHub or Google for sign-in. Passkeys are checked by the Worker itself with Web Crypto. Nothing new leaves the install. A person's own Claude routine is a connection that person makes, just as the owner's is now.
- **The person who runs the board decides,** and now that can be "the people you trust": maintainers merge, deploy, and approve in the repositories the owner gives them. Agents still never merge, deploy, or approve on their own word, whoever started them. The press-only rule, where only a signed-in browser can do these things and never a bearer token, stays exactly as it is.
- **One claim per task, and pull requests close tasks.** Unchanged. A person who claims a task by hand holds it like an agent does.
- **Taskwarrior stays a first-class way in,** for the owner. Sync replicates the whole task set under one client ID and sync key, so it stays the owner's (point 2).
- **The owner's direction (8 Oct, on this task):** the owner is, and stays, the account behind the board's token. It's not a separate login the token opens, and nothing anyone else does changes who the owner is. There's no email anywhere, not even optional. People join through an invite link shared by hand. A person who loses their passkey or token is Reset by someone who manages people, and the owner recovers with the token. No self-service reset.

## Words

The board's words (ID-5 owns them; DOC-46 adds these to the brand guide):

| Say | Meaning | Don't say |
| --- | --- | --- |
| **person**, **people** | Someone signed in to the board: you, or someone you invited | user, member (as a noun for everyone), account, seat |
| **invite** | A one-time link you make and share by hand, which lets one person in with the role you picked | invitation code, sign-up link |
| **role** | What a person may do in one repository: **maintainer**, **member**, or **viewer** | permission level, access tier, group |
| **the owner** | The person behind the board's token. In the board's own words it's still "you" when the owner is the reader, and "the owner" only where someone else reads it ("Only the owner can connect a provider.") | admin, superuser, root |
| **passkey** | How people sign in on the web | password (there are none), WebAuthn (fine in code) |
| **personal token** | A person's own token for their CLI and MCP | API key, PAT |
| **Reset** | Revoke someone's passkeys, tokens, and sessions, and make them a new invite | recover |

"admin" in the owner's 8 Oct note means whoever manages people. In this spec that's the owner, and a maintainer for the people inside their own repositories (point 3).

## Design

### 1. Who: the owner, and the people the owner invites

- **The owner** is a fixed person, `owner`, who exists in every install from day one and has no row anyone can edit. The board's token is the owner's credential: a request with it is the owner. A cookie made from it is the owner's session, as today. The owner isn't a role on a repository. It sits above every role, everywhere, including repositories added later.
- **The owner's name** (BRK-328, the owner's 9 Oct question). The handle stays `owner`, fixed and reserved, so old records and agents' rules still read right. The owner may set a display name, and only the owner can: people see it as "<name> (owner)", in their own settings and on an invite's page. It's empty by default, and then the board says "the owner" (and "you" to the owner). It's kept with the board's own settings, not in `people`.
- **Nobody can demote, remove, Reset, or replace the owner.** That includes a maintainer, an agent, and a person holding a stolen personal token. The only way to change the owner's credential is `npx breakaway rotate-token`, which needs the owner's Cloudflare login (`wrangler`). It signs every owner session out, as now, and leaves people's sessions alone. There's no second owner and no "make owner" button. **Why:** the owner pays for and controls the Cloudflare account. A board that could hand that away would contradict the account it runs on. A group that wants a second person with full rights gives them maintainer on every repository (the `*` grant, below).
- **People** are rows the owner (or a maintainer, within their repositories) adds by invite. Each has a display name, a handle, grants, when they were added and by whom, and when they were last seen. The handle is lowercase and unique, at most 32 characters. It's never `owner`, `board`, or `routine:*`, and never starts with an agent prefix (`claude-`, `codex-`, or a BRK-176 provider's prefix), so a handle can't pass for an agent. It's what Activity shows. A person can change their display name. Their handle is fixed.
- **No sign-up, and no hosted accounts.** The only way in is an invite. A person exists in one install only. The same human on two installs is two unrelated people, and installs never talk to each other about them.
- **Removing a person** revokes their passkeys, personal tokens, sessions, MCP sign-ins, and their own routine connections, and releases their claims with a comment. Their name stays on everything they did: Activity, comments, and the audit keep the handle, shown as "(removed)".

### 2. Signing in, with nothing the owner didn't connect

| Who | Web board | CLI, MCP, scripts | Agents |
| --- | --- | --- | --- |
| The owner | Paste the board's token, as today, from any sign-in page, always. Optionally a passkey of their own too (below). | The board's token, as today | The board's token, from the owner's cloud environment, as today |
| A person | Their passkey | Their personal token | Their personal token, from their own cloud environment (point 5) |

- **Invites.** Whoever manages people presses **Invite**, picks a role and repositories (point 3), and gets a link `https://<board>/#/join/<code>` to copy and share by hand. The code is 32 random bytes, kept only as its SHA-256. It's used once and lasts 7 days by default (1 to 30, the inviter's choice), and the inviter can revoke it. Opening it shows who invited you and the role, asks for a display name and a handle, and makes your first passkey. The invite is used up only when that passkey is saved. An expired, used, or revoked link says which, and that you should ask whoever invited you for a new one. **Why invites and not sign-up:** the owner decides who's in, and a link shared by hand needs no email (the owner's decision).
- **Passkeys (WebAuthn).** The Worker checks registration and sign-in itself with Web Crypto. The relying party ID is the board's host, from the install's config (`src/install.js`), never hard-coded. User verification is required. Signatures are ES256, RS256, or EdDSA, which Workers' Web Crypto verifies (ECDSA, RSASSA-PKCS1-v1_5, Ed25519). The board asks for no attestation (`attestation: "none"`): it trusts the passkey, not the device maker. It keeps the credential ID, the public key, the sign count, a name the person gives it, and when it was last used. A person can have several passkeys and remove any but their last. **Why passkeys:** no password to store, phish, or reset, and nothing to send. There's no library and no outside service.
- **The owner's passkeys** (BRK-328). The owner can add passkeys of their own, name them, and remove any of them, the last one too, on the signed-in board only (a press, with the owner's cookie). They're checked like a person's, and they're kept under the handle `owner`, which no person can have, so a person can't see, rename, or remove them. Signing in with one gives the owner's own cookie, the one the token makes, so it's the owner's session in every way, and `rotate-token` still signs it out. The token always signs in, whatever passkeys there are, so no passkey change can lock the owner out or change who the owner is. The owner has no personal tokens or sessions to manage: the token is theirs.
- **Personal tokens.** A person makes them in their settings. Each is named ("laptop", "cloud environment"), shown once, and stored only as its SHA-256. It starts `bkp_`, so `/mcp` and the API tell it apart from the board's token without trying both. A person can revoke any of them, and each shows when it was last used. Tokens don't expire, the same as the board's token. **A personal token can't sign in to the web board.** That keeps a token in an agent's environment from becoming a press (below).
- **MCP sign-in from apps** (BRK-157's OAuth flow) stays. The consent page signs in whoever is on the board, so the connection acts as that person. The `bka_` and `bkr_` tokens it makes carry the person. Each person sees and revokes their own MCP sign-ins. The owner sees everyone's.
- **Sessions.** People's cookies are `<session id>.<HMAC>`, with the session kept in the Durable Object: when it was made, last seen, the device's name from the user agent, and its expiry (30 days, renewed on use). That lets Reset and **Sign out everywhere** end them. The owner's cookie stays today's (HMAC with the token, 180 days), so an install where nobody is invited behaves exactly as now.
- **Reset** (the owner's 8 Oct decision). In People, whoever may manage that person presses **Reset**. It revokes all of the person's passkeys, personal tokens, sessions, and MCP sign-ins, and makes a new one-time invite with the same grants to share by hand. The person makes a new passkey from it. There's no self-service reset and no recovery codes. **The owner recovers with the board's token**, from any sign-in page. If the token itself is lost, recovery is `rotate-token` (the manual's "Lost the token" section).
- **Taskwarrior sync stays the owner's.** The sync protocol replicates every task under one client ID and one sync key, so a second person's replica would hold every repository's tasks, including private ones they have no grant for. Sync stays a way in for the owner only. People use the web board, the CLI, and MCP. Per-person sync is out of scope.
- **Signed out, and the first run.** A fresh install shows the token form, as today. The sign-in page gains **Sign in with a passkey** above it, but only once someone has a passkey, the owner included. Until then it looks exactly as it does now. **Set up the board** on a fresh install gains an optional step, **Add a passkey for yourself**, after Connect the CLI, done once the owner has one (BRK-328, the owner's 9 Oct message). An existing install shows no prompt: the owner adds one from their settings whenever they like.

### 3. Roles: few, per repository

A person holds at most one role per repository. A grant is `{ repository, role }`. The repository `*` means every repository, including ones added later.

| Role | In a repository they're given |
| --- | --- |
| **viewer** | Read everything about the repository: its tasks, specs, Activity, pull requests, routines, peloton, and Infrastructure (environments, plans, signals, costs). Changes nothing. |
| **member** | A viewer, plus: add, edit, claim, comment on, and hand over tasks; add ideas; start agents within their caps (on their own Claude, point 5); message, quote, and answer the pings of agents they started; post on the peloton; propose changes (a change on an environment's console, a policy change, a feature's title, brief, and release), which wait for a maintainer. |
| **maintainer** | A member, plus: merge, publish, and update pull requests; promote and roll back; run workflows; approve and reject plans and changes (under the environment's approval rule, point 7); set and revoke envelopes outside production; freeze and unfreeze; answer decisions; resolve any ping; make, change, and run routines; start general, review, and routine-making agents, Force start, and start a chase; mark specs approved or built; a feature's dates, state, and shape; pre-releases and releases; manage the people in their repositories (below). |
| **the owner** | Everything, everywhere, and the always-owner list below. |

**Why these four:** they're the steps the board already has. Read is a viewer. Do the work and start agents is a member. Press what agents can never press is a maintainer. Run the install is the owner. Each one adds a whole kind of action, so nobody has to read a matrix to know what a role means. **Why per repository:** an install already tracks private repositories next to public ones, and a person helping on one shouldn't see another. Infrastructure is per repository already, so an environment's role is its repository's role.

**What a person sees.** The board shows a person only the repositories they have a grant in: their tasks, Activity, pings, routines, pull requests, peloton, environments, and specs. A `+chase` feature or a peloton spanning repositories shows only the parts in theirs. `IDEA-` and `RUN-` tasks belong to a repository, so they follow its grant. An idea with no repository is the owner's. Settings show only what the person may change.

**Managing people.**

- The owner invites anyone with any grant, changes and removes grants, Resets, and removes anyone.
- A maintainer invites people as **member** or **viewer** on the repositories they maintain. They can also change those grants, Reset a person, or remove them, but only when every grant that person holds is on repositories the maintainer maintains, and the person isn't a maintainer.
- Making someone a maintainer, giving the `*` grant, and Resetting or removing a maintainer are the owner's.
- **Why:** a maintainer can grow their own repository's group without waiting on the owner. A maintainer can't take over another repository's people, or lock out a peer.

**Always the owner's, whatever the grants:**

- the board's token and `rotate-token`;
- making maintainers and the `*` grant;
- connections and secrets: the GitHub App, providers' read-only tokens, the repository's own Claude routine, push's keys, and the Secrets Store;
- adding, removing, and kicking off repositories;
- the install itself: self-update, import, rebuild, rekey, and install-wide settings (agent caps, routines' daily cap and pause, the currency and its rate, the Claude plan of the owner's routines);
- loosening a policy;
- envelopes on production;
- the licence's exceptions. These aren't on the board at all: `LICENSING.md` keeps them the owner's (the person who holds the copyright), and nothing here changes that.

**Why these:** each one either holds a secret, changes the Worker or its account, or widens what applies to production without a press. Those are the actions that would let someone take the install from its owner.

#### Every owner-only check today, and who may do it after

The press column says whether the action stays **press-only**: a signed-in browser, which is never a bearer token, so never an agent. Every row that is press-only today stays press-only. "Today" names the gate the build replaces: **cookie** is `via !== 'cookie'` in `src/worker.js`, and **by** is a store check that `by` is empty or `'owner'`.

| Area | Action | Today | After | Press-only |
| --- | --- | --- | --- | --- |
| Pull requests | Merge, auto-merge, update branch, publish (`github/pulls/:n/*`) | cookie | maintainer | yes |
| Deploys | Promote, roll back (`github/promote`, `rollback`) | cookie | maintainer | yes |
| Workflows | Run a workflow by hand (`github/workflows/run`) | cookie | maintainer | yes |
| Releases | Pre-release (`github/prerelease`) | cookie + by | maintainer | yes |
| Releases | Release a package (`github/release`) | cookie, or token with no by | maintainer | no (the owner's CLI) |
| Releases | Pull a release in (`releases/:r/pull`) | open | member | no |
| Specs | Mark approved or built (`specs/*`) | cookie | maintainer | yes |
| Plans | Approve, reject (`infra/plans/:id/*`, `store-infra-approvals.js`) | cookie + by | the environment's approval rule; maintainer by default (point 7) | yes |
| Plans | Start a plan's run again | cookie + by | maintainer | yes |
| Plans | Put a plan in front of you (`PATCH infra/plans/:id`) | cookie + by | member | yes |
| Plans | A target plan (`store-infra-approvals.js:119`) | by | as Approve | yes |
| Changes | Propose a change on an environment's console | cookie + by | member | yes |
| Changes | Approve (merges its pull request), reject | cookie + by | maintainer, under the approval rule | yes |
| Policy | Propose a policy change | cookie + by | member | yes |
| Policy | Approve a change that only tightens | cookie + by | maintainer | yes |
| Policy | Approve a change that loosens | cookie + by | **the owner** | yes |
| Envelopes | Set or widen, outside production | cookie + by | maintainer | yes |
| Envelopes | Set or widen on production | cookie + by | **the owner** | yes |
| Envelopes | Revoke or narrow, anywhere | cookie + by | maintainer | yes |
| Environments | Add, change, remove; observe-only; gates (`infra/environments`) | cookie + by | maintainer (the board's own install stays observe only, whoever asks) | yes |
| Environments | Freeze, unfreeze | cookie + by | maintainer | yes |
| Environments | Describe as code (start the adopt agent) | cookie + by | maintainer | yes |
| Infrastructure | Refresh the inventory, compare drift now | cookie + by | member | yes |
| Infrastructure | Force-release a lock | cookie | maintainer | yes |
| Infrastructure | Mark drift as break-glass | cookie + by | maintainer | yes |
| Infrastructure | Make a GitHub environment | cookie + by | maintainer | yes |
| Infrastructure | Ask for a short-lived environment | cookie + by | member | yes |
| Infrastructure | Runbooks: a routine's signal trigger | cookie + by | maintainer | yes |
| Infrastructure | Currency, fetch a rate | cookie + by | **the owner** (install-wide) | yes |
| Infrastructure | Connect or forget a provider's token | cookie + by | **the owner** | yes |
| Infrastructure | Envelope act (`infra act`) | a runbook run's agent with its act key | unchanged: never a person | — |
| Decisions | Answer, reopen (`store.js` `submitDecision`, `reopenDecision`) | by | maintainer; a kickoff's or a repository-less idea's: the owner | no |
| Decisions | Send answers and carry on | cookie | as Answer, and the starter's caps apply | yes |
| Pings | Apply a proposal | cookie | maintainer | yes |
| Pings | Dismiss, mark handled | cookie | maintainer, or the member who started the agent | yes |
| Agents | Start (`agents/start`), fix a pull request, fix an alert | open | member, within their caps | no |
| Agents | Force start, Force on fix | by | maintainer | no |
| Agents | Start the next N (`agents/next`) | open | maintainer | no |
| Agents | General agent, review a pull request, make routines with an agent | by | maintainer | no |
| Agents | Message an agent (`tasks/:id/messages`) | cookie | the person who started it, or a maintainer | yes |
| Agents | Agent settings: at once, an hour, autostart, alerts, per area | open | **the owner** (install-wide) | no |
| Agents | The Claude plan of the owner's routines | by | **the owner**; each person sets their own (point 5) | no |
| Tasks | Quote someone's words (`tasks/:id/said`) | cookie | member on tasks whose agent they started; maintainer on any. The quote names who said it | yes |
| Tasks | Remove a quote | cookie | whoever made it, or a maintainer | yes |
| Tasks | Undo an agent's planning change | cookie + by | maintainer | yes |
| Tasks | Answer a risky-path finding as a person | cookie | maintainer | yes |
| Tasks | Claim paths as a person | cookie, or no agent | member | no |
| Tasks | Add, edit, comment, claim, release, done | open | member (a viewer can't) | no |
| Tasks | Force-release another's claim, autostart, `horizon-*` tags, close a horizon | open | maintainer (closing a horizon: the owner, it's install-wide) | no |
| Features | Title, brief, release | open | member | no |
| Features | State (shipped), planned dates, shape, make from tasks, delete | by (dates: cookie) | maintainer in every repository the feature's tasks are in | dates: yes |
| Chase | Start, stop (`features/:slug/chase`) | by | maintainer, as features | no |
| Peloton | Post as a person, revise the plan | cookie | member posts; maintainer revises the plan | yes |
| Routines | Make, change, revoke a trigger, run now | by (or a `+routine-maker` agent) | maintainer (a routine-making agent unchanged) | no |
| Routines | Pause all, daily cap (`routines/settings`) | by | **the owner** | no |
| Routines | A routine's infrastructure events | by | maintainer | no |
| Repositories | Add, remove, release a slug (`store-repos.js`) | by | **the owner** | no |
| Repositories | Change a repository's settings (`repos modify`) | by | maintainer of it | no |
| Repositories | Add the board's files (`repos/:slug/init`) | cookie + by | maintainer | yes |
| Repositories | Connect or forget the repository's routine | cookie + by | **the owner** | yes |
| Repositories | Turn on deploys, move to the deploy flow | cookie + by | maintainer | yes |
| Kickoffs | Make, change, delete, register, run, images | cookie + by | **the owner** | yes |
| Connections | Check now | cookie | member | yes |
| Connections | Override GitHub's status, dismiss a note, GitHub App setup | cookie (setup: open) | **the owner** | yes |
| Install | Self-update: on, off, start, roll back, check | cookie | **the owner** | yes |
| Install | Import, rebuild, backfill | by / open | **the owner** | no |
| Install | Rekey (`admin/rekey`) | token only | **the owner**'s token only | no |
| Sign-ins | MCP sign-ins: approve, deny, revoke | cookie | each person their own; the owner anyone's | yes |
| Push | Subscriptions and notification settings | cookie | each person their own | yes |
| People | Invite, grants, Reset, remove | new | as "Managing people" above | yes |

Reads (`GET`) need viewer in the repository they're about. Install-wide reads (Connections, Settings, the audit of every environment) need the owner or the `*` grant. Two rows tighten what a token with no `by` may do today: agent settings, and closing a horizon. Both are install-wide, and the owner's token keeps them, so nothing changes for an install with nobody invited.

### 4. Agents act for the person who started them

- **Every run records who it's for.** `agent_runs` gains `for_person`. It's the person who pressed Start, the person whose routine fired (a routine run is for whoever made the routine, or the owner for routines made before this), or `owner` for autostart and the chase when the owner started them. A chase is for whoever started it.
- **An agent's rights are the least of three:**
  1. the person behind its credential (the board's token is the owner, a personal token is that person);
  2. the person its run is for, when the request names an agent the board started;
  3. the agent ceiling, which is today's agent rules: claim, comment, add tasks, ping, post on the peloton, open pull requests, and the chase's and refining limits.

  An agent is never a press. So it never merges, deploys, approves, answers a decision, or resolves a ping, whoever started it and whatever role that person has. The board's agent prompt says the same (`prompts/core.md`, "never merge"), and the press-only gates enforce it.
- **How sure each is.** On a person's own routine (point 5), the agent's environment holds that person's personal token, so its rights are capped by the credential: it can't do more than its person even if it leaves out its name. On the repository's routine, the environment holds the board's token, as today. The run's starter caps it only while it names itself, which agents do through `BREAKAWAY_AGENT` and the MCP headers. That's today's trust in the token, and it's why lending the repository's routine to members is off by default (point 5). Run keys (BRK-324, "Decided" below) close that gap: on a lent routine, the run's own key caps the agent by credential.
- **Requests that name an agent the board didn't start** (a local Claude Code session with `--as`) act as the person behind the credential, under the agent ceiling. That's today's behaviour, with the person filled in.

### 5. Bring your own Claude

**What Claude routines allow today.** A routine belongs to the claude.ai account that made it. It runs in that account's cloud environment, on that account's plan, and it starts from its API trigger's `/fire` URL and token. Claude limits starts to 30 an hour per routine and 100 an hour per account. Over either, it answers `429` with a `Retry-After` (the manual's cloud agents section, from [routines: usage and limits](https://code.claude.com/docs/en/routines#usage-and-limits)). Nothing in claude.ai lets one account's routine run on another's plan, so "bring your own Claude" means each person makes their own routine and connects it, just as the owner does now.

- **Connecting.** In their settings, a member or maintainer picks a repository they're a member of, gets the same copy-paste steps the owner's wizard gives today (the routine's name, the repository, the stub, the board's host to allow), and pastes the routine's URL and token into a form. The board checks and seals them the same way as kept routines (AES-GCM with the sync key's derived key, never shown again or returned by any API). Their cloud environment gets their **personal token** as its API credential for the board's host, never the board's token. The page says this in so many words.
- **Starting.** An agent a person starts runs on their routine for that repository. A chase they start does too. Autostart, and agents the owner starts, run on the repository's routine, as now. **Routines on the board** (saved prompts) run on the connection of whoever made them, and the ones made before this stay on the owner's.
- **Without their own.** A person with no routine for a repository can't start agents there, unless the owner turns on **Lend the repository's routine** for that repository (`PUT /api/repos/<slug>/routine/lend`). Then their starts use the owner's routine (and the owner's plan), within the lent caps below. The owner's routine environment holds the board's token, so the start dialog says "runs on the owner's Claude, with the board's token" before the press. **Why off by default:** it spends the owner's subscription, and its agents hold the board's token (point 4).
- **Caps, per person and in total.** The board's caps (agents at once, starts an hour, per repository, per area) stay install-wide and count every person's agents, so one person can't crowd out the rest. Each person also has their own agents at once and starts an hour, from the Claude plan of their own routine. The owner, in their words (9 Oct): "for BRK-302, when people set up their routine, lets ask them for their plan so we can base it on that instead of statically saying 1/5, use what we use now for the different plans". So connecting a routine asks for its plan (Pro, Max 5x, Max 20x: `src/plans.js`), and the person's caps come from it the way the owner's do: agents at once and starts an hour default to the plan's defaults, and the person may change them up to its ceilings (the plan's most agents at once, and Claude's 30 starts an hour for each of their routines, 100 in all). They change when the person changes their plan, which sets them back to its defaults. The flat **1 at once and 5 an hour** is only for starts on a routine the owner lends, since those spend the owner's plan. The owner can lower any person's caps, on their own routines and lent ones alike (`PATCH /api/people/<handle>/claude`). An existing install's caps aren't overridden, and the owner's own limits stay today's install settings ("Decided" below). Claude's own limits count per routine and per account, so the board holds and counts a person's routine apart from the repository's (`routineHold`, `agent_runs.routine_of`). Force start skips the board's caps, never a person's.
- **How this relates to BRK-176.** BRK-176's `agent_connections` are per repository and provider. This adds one column, `person`, which is null for the repository's connection (the owner's, today's) and a handle for a person's own. The pool for a start for person P is P's connections for that repository in P's order, then the repository's connections if the owner lends them. Everything else in BRK-176 (holds per connection, the provider interface, `startAgent()` as the one seam) stays as it is. If BRK-302 lands before BRK-176's build, it adds `person` to `kept_routines` instead, and BRK-176's migration carries it over. A person could later connect another provider the same way: that's BRK-176's build, not this one.
- **Runs show per person.** The Agents view groups running agents and the queue by person ("Ana: 1 of 1 at once"). The queue says when a start waits on a person's own cap. Runs and their starts are counted per person in Stats. The board counts starts, not money, as CLD-35 decided.

### 6. Attribution: every write names who did it

- **Who** is resolved from the credential, never from `by`. Every write records the person (`owner` or a handle). When an agent does it, it also records the agent (its name) and who that agent is for. `by` keeps meaning "the agent's name" and nothing else. An empty `by` no longer means the owner: it means "the person behind the credential, not an agent".
- **Where it shows:** Activity, task history and comments ("Ana", "claude-brk-12 for Ana"), the inbox (who resolved a ping), decisions (who answered), the peloton (a person's posts under their name, with the owner's still marked as the owner's), pull request pages and the comment the board leaves when it merges ("Merged on the board by Ana"), the infrastructure audit (`infra_audit` gains `person` beside `by` and `agent`), routines' `edited_by`, and features' history.
- **Old records stay as they are.** `owner` in a row written before this means the owner, which is true: there was nobody else.
- The audit trail stays append-only.

### 7. Policy: who must approve a plan

- **An approval rule per environment,** kept on the board like envelopes, not in the repository's `policy.json`. A pull request could otherwise lower the bar for its own plans, and maintainers can merge pull requests. A rule is `{ role: "maintainer" | "owner", people: 1 | 2 }`. The default is one maintainer (the owner always counts as one), which is exactly today's behaviour in an install where the owner is the only person.
- **The two-person rule** is `people: 2`: two different people approve, and neither may be the person who proposed the change (the console's change, or the policy change). The owner offers it as an option, recommended for production. A plan that waits shows who has approved and who else may. The push for a waiting plan goes to everyone who can approve it.
- **The owner can't be locked out.** When no second person can approve (nobody else holds the role), the owner may **Approve alone** with a second confirm. It's recorded in the audit as approved alone, with the rule it overrode. **Why:** an incident at night shouldn't wait on a person who isn't there. The audit makes the override visible.
- **Who changes the rule:** tightening (a higher role, or two people) is a maintainer's. Loosening is the owner's, like a policy that loosens.
- Envelopes, freezes, and the guards are unchanged. A plan inside an envelope still applies without a press, because the envelope was the approval.

### 8. What changes in the brand guide and `AGENTS.md`

DOC-46 makes these edits, in the pull request that ships the last of the build:

- **The claim "You decide"** becomes: "**You, and the people you trust, decide.** Agents claim, build, and open pull requests. You and the maintainers you choose merge, deploy, and start agents. Nothing merges or deploys on an agent's word." It stays true for a person alone.
- **"Agents start from the board"** gains "on your Claude, or each person's own".
- **The words table's "you":** "The person who runs the board, or anyone signed in to it." And the new words above.
- **`AGENTS.md`, "Free, and self-hosted":** "No hosted version, sign-up, hosted accounts, tenants, pricing, paid features, or ads. People sign in to an install only by the owner's invite."
- **`AGENTS.md`, "The person who runs the board decides":** "the owner, and the maintainers they choose in each repository". The rest stands.
- **`AGENTS.md`, "What agents never do":** unchanged, plus "never sign in to the web board, and never use a personal token that isn't your environment's".
- **The decision log** gets the owner's 8 Oct decisions and this spec's choices once it's approved.
- `prompts/core.md` gains one line under "Never deploy, never touch production": an agent acts for the person who started it, with no more rights than them. It stays about the board.

### 9. Migration: nothing changes until the owner invites someone

- The new tables (`people`, `grants`, `invites`, `passkeys`, `person_tokens`, `sessions`, `approval_rules`) start empty. The owner's name and passkeys start empty too: the owner signs in with the token, as now, and is "the owner" until they name themselves. An existing install's Set up the board doesn't come back for the passkey step. `CREATE TABLE IF NOT EXISTS` and the store's `PRAGMA` upgrades add the new columns (`agent_runs.for_person`, `infra_audit.person`, the connection's `person`).
- **Refused by default until roles are enforced.** The owner can cut a pre-release from `main` between any two of the build's pull requests, so each one must be safe on its own. Until BRK-301 and BRK-323 have both merged, a person's session or personal token is refused everything except signing in and out and managing their own passkeys, tokens, and sessions. A person's cookie never passes the owner's cookie-only gates. BRK-300 ships this way; BRK-301 and BRK-323 open up what each role may do. (The chase captain's call.)
  - **What BRK-301 opens, and what still waits.** A person's writes go through the routes, each gated by role. Every read is still refused until BRK-323, and a write's answer is cut to `{ ok, id, wid }` and the error text, so nothing from another repository shows. Some writes the role allows still wait:
    - a start, which runs on the starter's own Claude, waits for BRK-302;
    - a press that writes the infrastructure audit (approve, reject, envelopes, freeze, policy, break-glass, environments, plans) waits for BRK-303, because the audit is append-only and can't name a person yet;
    - a press that agents or the inbox would read as the owner's (answering a decision, messages, quotes, peloton posts and the chase's plan, applying a ping) also waits for BRK-303.

    Each of these refusals says what it waits for. (The chase captain's calls, on BRK-301.)
  - **What BRK-323 opens.** A person's reads go through the routes too (`src/reads.js`). A read about one thing (a task, a plan, an environment, a change, a feature, a peloton, an image) in a repository they have no grant in answers 404, as if it weren't there; one that names a repository in `?repo=` does the same. The install's own reads (health, Connections, self-update, kickoffs, MCP sign-ins, notifications, the providers' account-wide alerts, the inventory's refresh, and anything that adds up every repository: Stats, costs, and the audit, unless they name a repository or an environment) need the owner or the `*` grant. Every answer, a write's too, comes back with what's in other repositories taken out: list items, map keys, task links, and a hidden task's work ID in the board's words ("a task you can't see"). A feature counts only the tasks they can see; a chase's room, its plan, the road captain's log, and its digests are free text about every repository it spans, so they're only for someone who sees them all. What people and agents write in a repository they can see (descriptions, comments, ping messages) shows as written: a hidden task's work ID in it becomes "a task you can't see", but a bare name or a file path from another repository stays. The write answers' cut is gone. `/mcp` still refuses a personal token: opening it by grant is a follow-up.
- With no people, every check resolves to the owner, as now: the board's token and the owner's cookie pass everything they pass today. Every existing owner test keeps passing unchanged (the chase's rule).
- The two install-wide rows that tighten (agent settings, closing a horizon) need the owner. The owner's CLI and cookie are the owner, so nothing visible changes.
- The web board shows **People** in Settings with an empty state: "Just you. Invite someone to work on a repository with you." The sign-in page is unchanged until someone, the owner included, has a passkey.
- Old records keep `owner`. Nothing is backfilled.
- No new secret and no new connection. People's data lives in the Durable Object with the rest of the board. Import stays the owner's.

### 10. Groups whose work isn't code

Campaigns, research, and organising need more than this: an area with no repository (tasks, specs, decisions, and agents that research and draft, with their output somewhere other than a pull request), roles on that area, and an agent mode that works without a checkout. That's IDEA-66's ground, not this feature's. This spec leaves room for it: a grant names a repository today, and could name a board-only area later with the same four roles. When it's shaped, IDEA-66 should decide: what "merge" becomes for a document; where an agent's output lives; whether a board-only area gets a peloton and chases; and what such groups must never get (tracking, third-party services they didn't connect).

## Privacy

- **What's stored:** each person's display name, handle, grants, who invited them, when they were added and last seen, their passkeys' public keys and IDs (no biometric, no private key, no device serial), hashes of their personal tokens and invite codes, their sessions (made, last seen, a device name from the user agent, expiry), their sealed routine credentials, and their push subscriptions; for the owner, a display name if they set one, and their passkeys' public keys and IDs. There's no email address, no IP address, and no password.
- **What leaves the install:** nothing new. A person's routine is fired only on their press, or on routines they made, with today's payload.
- **What an agent sees:** a payload that names the task, the agent, and who it's for, by handle. It sees nothing about other people. A person's handle and display name are what Activity shows to everyone who can see that repository. Each person chooses theirs.
- **The repository is public.** Fixtures use made-up people (`ana`, `ben`) and repositories (`acme/widgets`).

## Out of scope

- Building any of it: this is the spec. The build tasks are below.
- Email of any kind, password sign-in, self-service reset, recovery codes, and third-party identity (GitHub, Google, SAML, SCIM).
- More than one owner, transferring ownership, and people across installs.
- Per-person Taskwarrior sync.
- Custom roles, per-action permissions, and roles per area or per environment. An environment takes its repository's role, with its approval rule on top.
- Board-only areas for work that isn't code (IDEA-66).
- Billing, seats, or anything that counts people for a price.
- Agents choosing whose routine they run on, or starting agents.

## Decided

The owner answered these on BRK-322 (9 Oct). They're no longer open:

- **Run keys for lent routines: yes**, built as BRK-324 after BRK-302. An agent on a lent routine gets a short-lived key in its payload, like a runbook's act key. The key carries exactly the rights of the person the run is for, so the credential caps the agent, not its name. The CLI uses the key in place of the environment's credential. Unverified: whether the cloud proxy's credential injection overrides an `Authorization` header the CLI sets. BRK-324 checks this first and says how it handles it.
- **The owner may approve alone**, with a second confirm, recorded in the audit (point 7).
- **Maintainers make only members and viewers** (point 3, "Managing people").
- **Viewers see Infrastructure costs.**
- **Default caps: from the person's plan; 1 agent at once and 5 starts an hour on a lent routine.** The owner added, in their words: "use the current default caps and dont override on installs, when an existing users creates an account, take over their settings". The reading (the chase captain's, which BRK-302 builds to): an existing install's caps stay as they are, and the owner's own limits are today's install settings, never the per-person defaults. A person's settings carry over to their account. Then, for BRK-302 (9 Oct): "for BRK-302, when people set up their routine, lets ask them for their plan so we can base it on that instead of statically saying 1/5, use what we use now for the different plans". So a person with a routine of their own gets their plan's caps (point 5), and 1 and 5 stay only for a routine the owner lends.

## Done when

- This spec is merged with status draft, answers each of the brief's ten points with a choice and why, maps every owner-only check today to a role (the table in point 3), and `pnpm lint` passes.
- The build, in order. The tasks are on the board already, and the chase's captain matches their briefs to this spec once it merges:

| Order | Task | What | Waits for |
| --- | --- | --- | --- |
| 1 | BRK-300 | People sign in: the people, invites, passkeys, personal tokens, sessions, and Reset tables and routes; the credential resolves to a person; the board's token always the owner; `bkp_` tokens in the CLI and MCP | this spec |
| 2 | BRK-301 | Roles enforced: one permissions module (`can(person, action, repository)`), every row of the table in point 3, the agent ceiling and `for_person`, and a table-driven test of every gated route and role | BRK-300 |
| 2b | BRK-323 | People see only their repositories: every read (tasks, Activity, pings, routines, pull requests, the peloton, Infrastructure, specs, search, MCP resources) filtered by the person's grants, as "What a person sees" in point 3 says | BRK-301 |
| 3a | BRK-302 | Bring your own Claude: a person's routine connections, lending the repository's routine, starts on the starter's routine, caps per person and in total, a person's plan | BRK-301 |
| 3b | BRK-303 | Who did it: the person on every write, in Activity, the audit, the inbox, and pull requests; approval rules and the two-person rule | BRK-301 |
| 3c | WEB-124 | People on the web: the sign-in page, People, invites, grants, Reset, each person's settings (passkeys, tokens, their routine, push), the owner's passkeys and name and the passkey step in Set up the board, the person in the header, and controls a role can't use shown with who can | BRK-301, BRK-323, BRK-328 |
| 3d | BRK-324 | Run keys: a short-lived key in a lent routine's payload that carries the rights of the person the run is for, and the CLI preferring it over the environment's credential | BRK-302 |
| 3e | BRK-328 | The owner's own sign-in: the owner's passkeys, the owner's display name with the handle still `owner`, and the optional passkey step in Set up the board (points 1, 2, and 9) | BRK-301 |
| 4 | DOC-46 | The manual, the site, the README, and point 8's changes to the brand guide, `AGENTS.md`, the decision log, and `prompts/core.md` | BRK-302, BRK-303, WEB-124, BRK-324, BRK-328 |

2b follows BRK-301 because both change every store file's reads and writes. 3a, 3b, and 3c can run in parallel, and 3d follows 3a. They share only the settings page, which WEB-124 owns.

## How to check it

Once it's built:

1. Sign in to your board with your token, as always. Nothing looks different, apart from **People** in Settings, which says it's just you.
2. In People, press **Invite**, pick **member** on one repository, and copy the link. Open it in a private window, pick a name, and make a passkey. You're in, and you see only that repository.
3. As that person, open a task and look at **Merge** on its pull request. It's shown as not yours, with "a maintainer of this repository can merge it". Start an agent on a task (after connecting your own routine in your settings). The running agent says it's for you.
4. Back as yourself, open Activity. Each change names who made it, and the agent's work says who it was for.
5. In People, press **Reset** on that person. Their passkey stops working, and you get a new link to give them.
6. Sign out and sign in again with your token. You're the owner, whatever anyone else changed.
