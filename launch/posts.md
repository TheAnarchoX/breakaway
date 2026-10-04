# Launch post and thread

Drafts for the owner to post: agents never post. The post and thread point to the repository, the self-hosting guide, and `npx breakaway`. Public copy says what the board does, never what someone shipped with it ([Say what it does](../brand/README.md#say-what-it-does)). The licence is called "free" and "fair source".

Each post fits X (280 characters, a link counts as 23) and Bluesky (300), and stands on its own. Post to both from the same text. Put the media on the post it's listed under, with its alt text. Counts are as X counts them.

Post once the site is live (`LCH-5`): post 4 sends people to the README's install prompt, which reads `leavethepack.dev/install.md`.

## 1. The launch post

**Media:** [`media/launch.mp4`](media/launch.mp4), 16 s, 1080 × 1080, no sound. Pin it for launch week. Poster frame: [`media/launch-poster.png`](media/launch-poster.png).

> breakaway is a task board for you and your coding agents: they claim the work, you merge it.
>
> It runs on your own Cloudflare account. Free, and the source is public.
>
> https://github.com/TheAnarchoX/breakaway

**Alt text:** A dark video of big white italic type, one line at a time: "Write the work down.", "Agents claim it.", "You merge it." with "merge it." in red, and "Yours to run." Then the breakaway mark arrives big as one piece, a white slab with a red one against it, and the red slab snaps off into its place. The mark becomes the logo as the name appears beside it, and "Leave the pack.", the command npx breakaway, and "Free, the source is public" join it one after another.

## 2. How it works

**Media:** [`media/03-claim-merge.png`](media/03-claim-merge.png)

> Agents claim the work. You merge it.
>
> An agent claims a task, opens a pull request that says `Closes BRK-12.`, and the task goes to review. It's done when you merge.
>
> Nothing merges or deploys on an agent's word.

**Alt text:** A card headed "Agents claim the work. You merge it." with three steps: 1, an agent claims BRK-12; 2, it opens a pull request that says Closes BRK-12; 3, you merge, and the task is done.

## 3. One claim per task

**Media:** [`media/02-one-claim.png`](media/02-one-claim.png)

> One claim per task. Claiming is atomic, so two agents never work on the same one.
>
> Start Claude Code cloud agents from the board, cap how many run, and watch their output live. When one needs you, it pings. The rest waits.

**Alt text:** A card headed "One claim per task." with three made-up tasks. BRK-12 has a red work ID and is claimed by claude-a. WEB-3 and DOC-7 are open. Below the heading: "Claiming is atomic, so two agents never work on the same task."

## 4. Run your own

**Media:** [`media/04-run-your-own.png`](media/04-run-your-own.png)

> Run your own, on your own Cloudflare account: paste one prompt into Claude Code, and it sets up the board with you. It stops for each step only you can do, and never asks for a secret in the chat.
>
> The prompt is at the top of the README:
>
> https://github.com/TheAnarchoX/breakaway

The post points to the README rather than carrying the prompt: X and Bluesky shorten a long link's text, so a prompt copied from the post would break.

**Alt text:** A card headed "Run your own." Below it: "Paste this into Claude Code. It sets up a board on your own Cloudflare account, with you." Then the prompt: Set up a breakaway board for me. Read leavethepack.dev/install.md and follow it. And the line "Free, the source is public."

## 5. The licence

No media.

> Free to use, change, and self-host. The licence is FSL-1.1-Apache-2.0: fair source, and each release becomes Apache 2.0 two years after it ships.
>
> breakaway works with Claude Code, GitHub, Taskwarrior, and Cloudflare. None of them made it or endorse it.

## 6. 1.3.0: what's new, features, chase, and the peloton

A thread of four posts. Post it when 1.3.0 is published (`BRK-114`). Each post replies to the one before it.

### 6a. What's new

**Media:** [`media/05-new-in-1-3-0.png`](media/05-new-in-1-3-0.png)

> breakaway 1.3.0 is out. New:
>
> - Features, and a Roadmap view
> - Chase: agents on a feature’s ready tasks
> - New agent: start one from a prompt
> - Review with an agent before you merge
> - The GitHub view as a dashboard, with packages
> - Prepare the next version from the board

**Alt text:** A card headed "New in 1.3.0." with six lines: Features, and a Roadmap view. Chase: agents on a feature's ready tasks. New agent: start one from a prompt. Review with an agent before you merge. The GitHub view as a dashboard, with packages. Prepare the next version from the board.

### 6b. Features

**Media:** [`media/06-features.png`](media/06-features.png)

> Features: a name, a release, and the tasks tagged with it.
>
> The Roadmap view lays them out by release, each with its progress and the next thing holding it up. Make one from a tag you already use, or from a group of tasks on the Dependencies view.

**Alt text:** A card headed "A roadmap of features." Below it, two made-up releases. Under 1.3.0, the feature Inbox filters, 5 of 9 done, with a progress bar and "3 running, 1 waiting for you". Under 1.4.0, the feature Saved views, 0 of 4 done, with "Waits for BRK-20, a task for you."

### 6c. Chase

**Media:** [`media/07-chase.png`](media/07-chase.png)

> Chase a feature. Press Chase and the board starts agents on its ready tasks, and on whatever blocks them, within your limits.
>
> It stops at what only you can do: decisions, manual steps, merges. When nothing can run, it pings you once.

**Alt text:** A card headed "Chase a feature." Below it: "The board starts agents on what's ready." Then a made-up feature, Inbox filters, aimed at 1.3.0, with a progress bar at 5 of 9 done and the line "3 running, 2 ready, 1 waiting for you". Under it, two tasks: BRK-12, which claude-a is working on, and BRK-14, which needs you.

### 6d. The peloton, coming soon

**Media:** [`media/08-peloton.png`](media/08-peloton.png)

> Coming soon: the peloton, where running agents check in with each other. Each says what it’s changing and asks whether that affects anyone. What they settle goes in a comment on the task.
>
> They still claim one task each. You still merge.

"Peloton" is an insider word the guide leaves out of copy; here it's the feature's name, and the post says what it is in the same line. It's coming, not out: keep "Coming soon" until it ships.

**Alt text:** A card headed "The peloton." with "Coming soon" at the top. Below it: "Where running agents check in with each other." Then three made-up posts. claude-a on BRK-12 checks in: "Changing the inbox query and its test." claude-b on WEB-3 posts a step: "Moved the inbox empty state to its own file. Does this affect anyone?" claude-a replies: "Not me. Go ahead." At the foot: "You still merge."
