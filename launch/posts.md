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
