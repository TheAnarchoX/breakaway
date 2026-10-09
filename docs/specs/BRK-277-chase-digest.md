# BRK-277 · An hourly digest of a chase

Task: BRK-277 on the board, in the `captaincy` feature · Status: draft

## Problem

While a chase runs, what happened lives on its peloton: dozens of posts an hour between agents. The owner shouldn't have to read it to know what merged, what waits for them, and what's stuck.

## What it became

### 1. When the board writes one

- Once an hour while a chase is on: the tick (the alarm and the cron) writes a digest when an hour has gone by since the last one, or since the chase started. Nothing in the first hour.
- Once when the chase stops (the owner's Stop) or ends (every task done or in review): its **last digest**, saying why.
- Each covers the stretch since the one before. The board keeps them 30 days (table `chase_digests`).
- While GitHub or Claude is down the tick does nothing, so no digest either; the next tick after it works covers the whole stretch.

### 2. What one says

- **Merged**: the pull requests merged in the stretch that close one of the chase's tasks, oldest first, with links to the screenshots their descriptions carry (Markdown or `<img>` images on GitHub's own hosts, at most 4 each). The board keeps the links when it reads the pull request (`images` on the stored pull request), never the images. The page links to them rather than showing them: the board's pages only load images from the board, and a private repository's screenshots only open for someone signed in to GitHub.
- **Waits for you**: the chase's Needs you (pull requests to merge, decisions, steps for you, routines to connect, untagged tasks) in the order to take them: the task's priority, then how much work it frees, then merges before decisions before steps.
- **Stuck**: what the chase won't try again, with why and the last comment.
- **Next**: the first 3 in the chase's queue, each starting now or with why it waits. This is the board's plan; the chase's written plan stays with the road captain, whose lines say what of it matters.
- **From the road captain**: a few lines, when the captain wrote some since the last digest (`npx breakaway captain <feature> digest --file <path>`, `POST /api/features/<slug>/captain` with `{ digest, by }`, up to 600 characters, the captain's only; a new note replaces one not yet carried).
- The chase's live line, as of the digest.

### 3. Where it shows

- **Inbox**: the newest digest of each chase, under Digests, with its counts and the first 3 things waiting for you; the next one replaces it, and Dismiss clears it until the next. It never counts on the bell or the tab's title: it's news, not a ping.
- **Feature**: a Digests section beside the chase, listing the latest 48, each linked to its page (`#/roadmap?feature=<slug>&digest=<id>`, `GET /api/features/<slug>/digests/<id>`).

### 4. Push

- Off by default. The owner turns it on per chase with **Push digests** on the feature (`digestPush` on Chase; the owner's only).
- When on, a digest pushes only if something merged, waits for the owner, or is stuck (or it's the last), and at most once an hour across every chase. The push opens the digest's page.

## Out of scope

- Showing the screenshots inline, or keeping copies: that would mean loading images from GitHub in the board's pages or storing them in the install.
- Reading the chase's written plan for a "next step": it's free text, so the captain's lines carry it.
- A digest for a chase without its tick (a chase that's off).

## Open questions

- Should the hour be a setting per chase? One hour fits the task's ask; it's a constant (`DIGEST_EVERY_MS`) until someone needs another.

## Done when

While a chase runs, an hourly digest lands in the inbox with merged work (with screenshots when present), what waits for the owner in order, what's stuck, and the next step; at most one push an hour; tests cover the digest's content.

## How to check it

1. Chase a feature with a few tasks, one of them a decision and one a step for you.
2. An hour later, open the inbox: under Digests, the chase's digest says what merged and what waits for you, decision or step first by priority.
3. Press Open the digest: its page lists merged pull requests, with links to their screenshots, then what waits for you, what's stuck, and what's next.
4. On the feature, turn on Push digests: the next digest with something in it reaches your phone, and no more than one an hour.
5. Stop the chase: its last digest shows in the inbox.
