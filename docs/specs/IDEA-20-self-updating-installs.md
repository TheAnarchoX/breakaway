# IDEA-20 · Self-updating installs

Task: `IDEA-20` on the board · Status: built (as of 5 Oct 2026, every task it planned is done)

## Problem

Every install is deployed from its own repository (`BRK-9`): the install template's workflows read the release feed and either bump a pull request (stable) or deploy (main). An install made with a button, with no repository of its own, has no workflow to do that. Without a way to update, it stays on the release it started on.

Decided on 3 Oct 2026 to come **after launch**: until then the template's bump pull requests carry updates to every install, and the Deploy to Cloudflare button waits for this. So nothing here is built before launch, and every task below is `later`.

## Fit

- **Reads** the feed from `BRK-8` ([the feed](../../site/README.md)) at `leavethepack.dev/releases.json`: per channel, the version, bundle, manifest, and checksum URLs, `manual`, `manualSteps`, and `updatesFrom`.
- **Reuses** what the install template's deploy does (`BRK-9`): upload a Worker version, deploy it, check `/api/ping` reports the new version, roll back if not. The difference is who runs it: the install's own Worker, not a workflow.
- **Rides on** the board's version and channel (`BRK-10`): Connections' Version row is where the Update button lives.
- **Settled rules it keeps** (`AGENTS.md`): the person who runs the board decides (an update only starts when the owner presses Update, never by itself, and never on an agent's word); an install keeps its data (the one call it makes that the owner didn't connect is the feed, and it is the owner who turns self-update on, so it's a connection like GitHub or push); free and self-hosted (the feed is a static file, with no account and no tracking: the install sends nothing about itself); breakaway still holds no Cloudflare credentials.
- **Doesn't change** an install that has an install repository: it keeps the workflows, and self-update stays off for it.

## Design

### 1. Releases are signed

A deploy by the install's own Worker can't lean on "the workflow ran in my private repository". It has to decide for itself that a bundle came from breakaway. So:

- The **Release** workflow signs each release's `manifest.json` with an Ed25519 key. The manifest already holds the bundle's checksum, so one signature covers the bundle. The signature is a release asset `manifest.json.sig`, and the feed gives its URL.
- The **public key** ships with the install, in the Worker's code (`src/release-key.js`), so a bundle can only be installed if it was signed by the key the running version already trusts. Replacing the key is itself a release signed by the old key, so a key can rotate and never be swapped by whoever controls the feed.
- A feed or a download that fails the check is refused with a plain message. The feed host being compromised can then hide an update but never push one.
- The private key is an Actions secret of this repository, which breakaway's release workflow reads. Never in a file. Generating and storing it is the owner's ([a task below](#tasks)).
- A release from before signing can't be self-installed: `updatesFrom` says so, and the install is told to update by hand once.

### 2. The owner turns it on, once

Self-update is off until the owner turns it on in Connections, on an install that has no `installRepository`. It needs a Cloudflare API token with the narrowest scope that can upload and deploy this one Worker (Workers Scripts: edit, on this account), which the owner creates and pastes into Connections. The token is stored as a Worker secret that only this install holds, is never shown again, and is never sent anywhere but Cloudflare's API.

- **Why the install holds a token that can deploy itself:** the install has to be able to change its own code. The choice of where the token lives is [question 1](#questions-for-the-owner).
- **Turning it off** removes the token's use from the Worker and tells the owner to delete the token on Cloudflare, since breakaway can't.

### 3. The Update button

On Connections' Version row, when the feed has a newer release in the install's channel, and it can be installed:

- **Shows** what's running, what's available, and the notes. For `main`, "latest pre-release" and for `stable`, "latest stable". No automatic update on either: the button is the only start.
- **Pressing Update** (cookie-only and same-origin, like Merge: owner only, never an agent's token) runs these steps in the Worker, as steps with a state the page polls:
  1. Fetch the manifest, its signature, and the bundle. Check the signature against the shipped key, then the checksums, then that the running version is at or above `updatesFrom`.
  2. Upload the bundle as a **Worker version** through the Cloudflare API, with the bindings the running version has (the Worker reads them from its own settings, so a binding the owner added by hand stays).
  3. Deploy that version to 100%, and note the previous version's ID.
  4. **Health check:** the new version answers `/api/ping` and reports the new `release`, within a minute. The Durable Object is the same one, so the data stays.
  5. **Roll back** if the check fails: deploy the previous version, and say what failed. Worker versions make this one call. Data the Durable Object stores changes forward-only and additively, so the previous version can still read it ([the README's releases](../../README.md#releases)).
- **Nothing changes until the deploy:** a failure in steps 1 or 2 leaves the running version untouched, and the board says which step failed and what to do.
- A **Roll back** button stays on the Version row for the last update, as long as the previous version is still one Cloudflare keeps.
- **One at a time:** an update in progress disables the button, and the Worker refuses a second one.

### 4. A release that needs hands

A release is `manual` when it changes Durable Object classes or migrations, routes, crons, or bindings the Worker's own API call can't set. The self-update refuses these: no Update button, only the release's **Manual steps** from `manualSteps`, and a link to its notes. How such an install updates by hand is [question 3](#questions-for-the-owner): it's either the owner's own `wrangler` or a repository for the install.

The install also compares what Cloudflare reports for itself (its migrations, routes, and crons) with the release's, so a change the manifest forgot to flag still stops. This needs the release to carry an expected-shape list in its manifest.

### Empty, error, and first-run states

| State | What the person sees |
| --- | --- |
| Not turned on | The Version row says what's running and what's available, and **Turn on updates** explains the token it needs. |
| Token missing or refused | "Cloudflare refused the token. Make a new one with Workers Scripts: edit and paste it here." |
| No newer release | "Up to date." |
| Feed unreachable | "Can't read the update feed. The board keeps running as it is; try again later." |
| Signature or checksum fails | "This release didn't pass its signature check, so it wasn't installed. Nothing changed." |
| Manual release | The steps, and no button. |
| Health check fails | "The update failed its check and was rolled back to <version>." |
| An install with an install repository | No self-update; the row points at the repository's update pull request. |

All strings follow the [brand guide](../../brand/README.md).

## Out of scope

- Updating automatically. The owner presses Update, every time.
- Running an update for installs that have an install repository.
- Updating other things than the Worker's code and web app (secrets, routines, the GitHub App).
- Hosting anything: breakaway still only serves a static feed.
- Release notes translation, or choosing a version older than the latest in the channel.

## Questions for the owner

One decision task, [with the three questions](#tasks):

1. **Where does the install's Cloudflare token live?** A Worker secret on the install itself (simplest, works with the button) or a Secrets Store binding (the token isn't readable by the Worker's code except through the binding, but an install made with the button has no Secrets Store).
2. **Which key signs releases?** A key pair kept as an Actions secret on breakaway's release workflow (recommended), or Sigstore keyless signing with the workflow's identity checked by the install (nothing to keep, but the install then needs to verify a Sigstore bundle, which is more code).
3. **How does an install with no repository take a manual release?** The owner follows the release's steps with their own `wrangler`, or `npx breakaway install init` makes a repository for the install at that point, so it moves to the template's workflows.

## Done when

An install made with a button, with self-update turned on, shows an available release on Connections, installs it on one press after checking its signature, passes its health check, and can go back to the previous version in one press; a bad signature, a bad checksum, a failed check, and a manual release each leave it running as before with a plain message; and an update never starts without the owner's press.

## Tasks

Made with this spec, all `later`, each waiting for this idea's pull request (and the tasks it needs):

- the decision task above (`+owner`, `+decide`);
- sign releases and ship the public key;
- the install verifies releases and finds updates;
- the owner makes and stores the signing key (`+owner`);
- update the Worker's own code with Update, health check, and rollback;
- the manual-release path;
- the Update row on Connections;
- docs: updating without a repository.
