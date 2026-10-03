# breakaway brand guide

<!-- brand-lint-ignore-file name, never-word, exclamation, open-source: the guide quotes what the lint catches. -->

How breakaway looks and sounds everywhere: the board, its docs, the landing page, and launch posts. Follow it for every string and every pixel, whether you're a person or an agent.

A breakaway is the rider who leaves the pack and holds the lead alone. That's the feeling to get across: the frontier, moving fast, one person with one tool. So the brand is loud and fast, and it never claims more than is true.

**In one line:** breakaway is a task board for you and your coding agents: they claim the work, you merge it.
**Tagline:** Leave the pack.

## The name

- **Always lowercase: breakaway.** At the start of a sentence too, in headings, and in the logo. Never "Breakaway", "BreakAway", "BREAKAWAY", "Break Away", or "break-away". In code and on the command line it's `breakaway` as well.
- **One word, and a thing, not a person:** "breakaway marks the task done", not "breakaway thinks". The board doesn't say "we".
- **Keep it out of uppercase labels.** Kickers and labels are set in capitals, and "BREAKAWAY" isn't the name. Leave the name out of them.

## Voice

breakaway sounds like the rider who just went clear: sure of the move, short of breath, no time for filler. Loud and fast where most tools are calm, and still true.

| breakaway is | breakaway isn't |
| --- | --- |
| **Fast.** The point first, in as few words as it takes. Verb first, number first: "3 agents running." | Slow. Preambles, "please note", "in order to", "it looks like". |
| **Loud.** Short lines said with conviction and set big. One idea per line, then a full stop. | Shouting. Capitalised sentences, exclamation marks, emoji. Loud comes from size and certainty, not volume. |
| **True.** Only what the board does today, and numbers that happened. | Promises and benchmarks: "10x your output", "replace your team", speed nobody measured. |
| **Plain where it counts.** Buttons, statuses, errors, and docs use the literal word. | Clever at the cost of clear. A button says "Claim", not "Attack". |
| **On your side.** Talks to you, the person running the board, and gives agents credit for their work. | Smug, or taking shots at other tools or at people who work differently. |

### Writing it

- **Headlines** are 2 to 6 words with a full stop, never an exclamation mark: "Leave the pack." "Agents claim the work. You merge it." Rhythm comes from short sentences in a row: "Write the work down. Agents claim it. You merge it."
- **Sentence case** for everything: headings, buttons, menu items, dialog titles.
- **Buttons are verbs** that say what happens: "Claim", "Release", "Start the next few", "Merge". Never "OK", "Submit", or "Yes". A confirm dialog asks the question ("Release BRK-12?") and says what follows ("Anyone can claim it after.").
- **Errors** say what failed and what to do, in one line, without blame or codes: "Couldn't claim BRK-12: claude-a has it." Never "Oops", and never "Something went wrong" on its own.
- **Success is a word or two**, or nothing when the screen already shows it: "Claimed." "Merged."
- **Empty states may be loud**: "All clear. Nothing waits on you."
- **Numbers are digits**, and real or left out. Use tabular figures in tables and counters.
- **Address the person as "you".** Name agents by their name (`claude-brd-27`) or call them "agent". Everyone else is "people", never "users".
- **Curly apostrophes and quotes** in the board (`’`, `“ ”`).
- **Plain international English**: no slang a non-native reader needs looked up, apart from the cycling words below.

### Cycling words

The name comes from road racing, and a few of its words fit. Use them in headlines, on the landing page, in launch posts, and in an empty state's heading. Never in buttons, statuses, errors, or instructions, and at most one per screen.

| Say | It means | Use it for |
| --- | --- | --- |
| **Leave the pack.** | Break away from everyone else. | The tagline |
| **Off the front** | Ahead of everyone, in the break | What's leading: a headline, a section title |
| **Go clear** | Get away and open a gap | A headline, an empty state |
| **The gap** | The lead you hold | The logo, and the space around the thing that leads |
| **The red number** | The race number the most combative rider of a Tour de France stage wears the next day: usually the one who went on the attack in the breakaway | The claimed task's work ID ([signature moves](#signature-moves)) |

Leave out the insider words ("peloton", "domestique", "lanterne rouge"), "attack" (it means something else in security), and "stage" (it collides with staging).

### Instead of this, that

| Instead of | Write |
| --- | --- |
| Welcome! Let's get your board set up. | Set up your board. |
| Your task has been successfully claimed. | Claimed. |
| Oops! Something went wrong. | Couldn't reach GitHub. Try again in a minute. |
| No tasks match your current filters. | Nothing matches. Clear a filter. |
| Are you sure you want to release this task? | Release BRK-12? Anyone can claim it after. |
| Supercharge your workflow with AI agents 🚀 | Agents claim the work. You merge it. |
| breakaway is a revolutionary, next-gen platform for AI-powered development. | breakaway is a task board for you and your coding agents. |
| Ship 10x faster. | One claim per task, so two agents never work on the same one. |

**Words that are never breakaway's:** revolutionary, game-changing, next-gen, seamless, supercharge, unleash, unlock, magic, effortless, blazing fast, 10x, AI-powered, cutting-edge, world-class. Each says "fast" or "new" without saying how; say what the board does instead.

## Words breakaway uses

The board's own words, the same everywhere, so people learn them once.

| Say | Meaning | Don't say |
| --- | --- | --- |
| **task** | One piece of work, with a work ID | ticket, issue (that's GitHub's), story, item |
| **work ID** | `BRK-12`: the area's prefix and a number, never reused | ticket number, key |
| **claim** / **release** | Take a task / give it back. A task has one claim at a time. | assign, lock, grab |
| **agent** | A coding agent working on a task: Claude Code | bot, AI (as a noun), assistant, copilot, worker |
| **start** an agent | Start a cloud agent on a task from the board | launch, spawn, dispatch |
| **routine** | A saved agent run, on a schedule or a GitHub event | cron job, automation, workflow (that's GitHub's) |
| **ping** | An agent asking you to act; pings wait in the **inbox** | alert, notification (for the ping itself) |
| **idea** | Something to shape before anyone builds it | epic, feature request |
| **area** | The part of a repository a task belongs to, with its prefix (`BRK`, `WEB`) | category, label, project |
| **horizon** | **now**, **next**, or **later** | sprint, milestone, backlog |
| **repository** | A codebase the board runs; "repo" is fine in code and commands | project |
| **pull request** | GitHub's; "PR" where space is tight | merge request, patch |
| **In review**, **Done** | A task with an open pull request; one whose pull request merged | resolved, closed, shipped |
| **the board** | Your breakaway install, and its board view | workspace, dashboard, instance |
| **free**, **fair source** | The licence: free to use, change, and self-host, and Apache 2.0 two years after each release ([below](#free-and-fair-source)) | open source (until a release turns Apache 2.0) |
| **you** | The person who runs the board | user, admin, the owner (in the board's own words) |

## Claims that must stay true

Wherever breakaway describes itself, these are the claims, because they're what the board does. If the board changes, change the copy in the same pull request.

- **One claim per task.** Claiming is atomic, so two agents never work on the same task.
- **Pull requests close tasks.** A pull request that says `Closes BRK-12.` puts the task in review, and the task is done when it merges.
- **Agents start from the board.** Start Claude Code cloud agents on tasks, cap how many run, and watch their output live on the task. Local Claude Code sessions work through the CLI.
- **Agents ping you when they need you.** The rest waits on the board.
- **One board, several repositories**, each with its own areas, prompt, and agents.
- **Three ways in, one set of data**: the web board (installable, phone included), a CLI, and Taskwarrior sync.
- **It runs on Cloudflare**: Workers and a Durable Object.
- **Free, and the source is public** ([below](#free-and-fair-source)).

Say these only once they ship: self-hosting on your own Cloudflare account, and the setup guide.

**Works with, never "powered by".** breakaway works with Claude Code, GitHub, Taskwarrior, and Cloudflare; none of them made or endorse it. Never "official", "partner", "powered by", or a lockup with their logos.

### Free and fair source

breakaway's licence is FSL-1.1-Apache-2.0, the Functional Source License: free to use, change, and self-host for anything except offering a competing service, and each release becomes Apache 2.0 two years after it ships. That's [Fair Source](https://fair.io/licenses/), and the Open Source Initiative doesn't count it as open source until the Apache date. So say "free", "fair source", or "the source is public", name the licence, and say "open source" only of releases that have turned Apache 2.0. Loud and true: "Free to run. Free to change. Apache 2.0 in two years."

### Say what it does

breakaway talks about what the board does, never about what someone shipped with it: no counts of pull requests, hours, or people, no benchmarks, and no before-and-after. Where a sentence reaches for speed, say how the board works instead: one claim per task, pull requests close tasks, and agents ping you when they're stuck.

## Logo

The logo is **the gap**: a slab for the pack, a gap, and a narrow red slab for the rider off the front, both leaning 10° like the type, next to the wordmark.

![The logo: a chalk slab and a narrow red slab with a gap between them, leaning like the italic wordmark "breakaway", shown big on carbon, as app icons from 160 to 16 px on carbon and chalk, and on white.](previews/logo.svg)

- **It says the name in two shapes**: everyone else, the gap, and the one who went clear. The gap is the point, so it's wide on purpose, wide enough to hold at 16 px. In one color, the gap carries it.
- **Red is always the rider.** The pack is chalk on dark grounds and carbon on light ones; the narrow slab is breakaway red on both.
- **How it's built.** Both slabs stand on the wordmark's baseline and are as tall as its ascender, the top of the b. In units of 1/100 of the wordmark's size, the pack is 44 wide, the gap 16, and the rider 22, with corners rounded by 3, and the wordmark starts 24 after the mark. All of it is in [`tools/build.mjs`](tools/build.mjs).
- **The wordmark** is "breakaway" in Archivo at width 125, weight 850, italic, with −0.02em tracking, always lowercase, drawn as outlines. Use the files; don't retype it.
- **Watch for the pause sign.** Two slanted bars can read as a pause sign or `//`. The uneven widths, the red, and the lean keep it apart, so keep all three.

### Using it

- **Files** are in [`logo/`](logo/): the logo (`logo-on-dark.svg`, `logo-on-light.svg`), the mark alone (`mark-on-dark.svg`, `mark-on-light.svg`, `mark-one-color.svg`), the wordmark alone (`wordmark-on-dark.svg`, `wordmark-on-light.svg`), and the app icons: `icon.svg` (the mark on a rounded carbon tile), `favicon.svg` (the same with a bigger mark, for 16 and 32 px), `icon-maskable.svg` (full bleed, the mark inside the safe zone), and `icon-monochrome.svg` (white, for themed icons). The `-on-dark` files go on carbon and other dark grounds, the `-on-light` ones on chalk and light grounds.
- **Clear space** is the mark's height on every side.
- **Smallest sizes:** 16 px for the icon, 24 px tall for the mark, 96 px wide for the logo. Smaller than that, use the mark alone.
- **One color:** `mark-one-color.svg` can be recolored to any single color for print.
- **Don't** recolor the red or swap which part is red, change the lean, set the wordmark in another font or in capitals, add outlines, shadows, glows, or gradients, put the mark in a circle or a bubble, animate it beyond the splash, or lock it up with another logo.

## Color

**Red is the rider. Everything else is the pack.** Carbon and chalk are the grounds, and one red thing leads each view: the primary action, the task being worked, or what's live. A single red on a field of carbon is louder than red everywhere, so red stays rare.

![The palette: breakaway red, carbon, and chalk, then both themes with their surfaces and every text color with its contrast.](previews/palette.svg)

All colors are tokens in [`tokens.css`](tokens.css), with the same names the board's stylesheets use. Use the tokens, never hex values, and make every view work in both themes. **Carbon (dark) is the default**; chalk (light) follows the system setting or the person's choice.

| Token | Carbon | Chalk | Use |
| --- | --- | --- | --- |
| `--red` | `#e61e0b` | `#e61e0b` | breakaway red: the logo, the primary action, the red number. The same in both themes |
| `--on-red` | `#ffffff` | `#ffffff` | Text on red |
| `--bg` | `#0d0e10` | `#f4f4f1` | The page: carbon or chalk |
| `--bg-2` | `#121316` | `#ebebe7` | The sidebar and other recessed areas |
| `--surface` | `#17181c` | `#ffffff` | Cards, inputs, panels |
| `--surface-2` | `#1e2025` | `#f6f6f3` | Raised layers, hovers |
| `--surface-3` | `#282a30` | `#e6e6e1` | The highest layer |
| `--text` | `#f4f4f1` | `#0d0e10` | Text and headings |
| `--muted` | `#a4a7b0` | `#54575f` | Secondary text |
| `--faint` | `#6e717b` | `#84878e` | Edges and icons only. Never text |
| `--accent` | `#ff5b3f` | `#c4180a` | Red as text: links, focus, the active item |
| `--success` | `#43d17a` | `#0b733a` | Ready, merged, passing |
| `--warn` | `#ffc23d` | `#865500` | Blocked, waiting on something |
| `--danger` | `#ff5f7a` | `#b3123c` | Failing, broken; always with an icon and words |

**Contrast** (WCAG 2.2, against `--bg`). [`test/brand.test.js`](../test/brand.test.js) checks every text color on every background and surface (4.5:1), the status colors on their own tinted pills, and that these numbers match the tokens.

| Token | Carbon | Chalk |
| --- | --- | --- |
| `--text` | 17.5:1 | 17.5:1 |
| `--muted` | 8.0:1 | 6.6:1 |
| `--accent` | 6.3:1 | 5.5:1 |
| `--success` | 9.8:1 | 5.4:1 |
| `--warn` | 12.0:1 | 5.8:1 |
| `--danger` | 6.6:1 | 6.2:1 |
| `--faint` | 4.0:1 | 3.3:1 |
| `--red` | 4.2:1 | 4.2:1 |

- **Red is a fill**, for the primary button, the red number, and the logo, with white text on it (4.6:1). As text it's only for display sizes (24 px bold and up); smaller red text is `--accent`.
- **Errors aren't the brand red.** `--danger` is a cooler crimson, and errors always carry an icon and words, so red never means "wrong" by color alone.
- **`--faint` fails as text** (4.0:1 on carbon, 3.3:1 on chalk): it's for input edges and icons, which need 3:1.
- **Flat color, hard edges.** No gradients, glows, or film grain.

## Type

Two open-source families (SIL Open Font License), self-hosted from `@fontsource-variable/archivo` and `@fontsource-variable/chivo-mono`, so no font requests go to a third party. Both come from the same foundry, Omnibus-Type.

![Type: "Leave the pack." in wide heavy italic, a heading and body text in Archivo, work IDs and labels in Chivo Mono with BRK-27 on a red chip, and the headline rhythm: Write the work down. Agents claim it. You merge it.](previews/type.svg)

| Role | Set in | Use |
| --- | --- | --- |
| **Display** | Archivo, width 125, weight 800 to 900 (850 by default), italic | Headlines, big numbers, the wordmark: `--font-display` with `font-stretch: var(--display-stretch)` and `font-weight: var(--display-weight)` |
| **Heading** | Archivo, width 100, weight 700, tracking −0.015em | Headings in the board |
| **Body** | Archivo, width 100, weight 400 (600 for emphasis) | Everything people read: `--font-body` |
| **Mono** | Chivo Mono, weight 500 to 700 | Work IDs, numbers, commands, code: `--font-mono` |
| **Label** | Chivo Mono, weight 600 to 700, capitals, tracking +0.12em | Kickers and small labels above a heading |

- **Display is always wide and italic**, and only for headlines and big numbers: never body text, buttons, or anything under 24 px.
- **One display line per view.** Everything else is heading, body, or mono.
- **Kickers** are written in sentence case in the source; CSS does the capitals, so screen readers don't shout.
- **Numbers line up**: work IDs and counts in mono, or tabular figures (`font-variant-numeric: tabular-nums`) in Archivo.
- Headings use `text-wrap: balance`.

## Shape and motion

- **The lean is 10°**, Archivo's italic angle (`--lean`). The marks, slanted cuts, and anything that shows direction lean forward, to the right, at that angle and no other.
- **Corners are tight**: 4, 8, 12, 16, and 24 px (`--radius-xs` to `--radius-xl`). Chips are nearly square, like race numbers; buttons take `--radius-s`.
- **Motion is fast and forward**: 120, 180, and 280 ms (`--dur-fast`, `--dur`, `--dur-slow`) on `--ease`, a fast-out curve that never bounces. Things arrive from the left and leave to the right.
- **The splash**: the rider slides ahead and the gap opens, once, in 280 ms. It's the only time the logo moves.
- **Reduced motion** (the system setting, and the board's own) turns every movement into an instant change, the splash included. Nothing flashes more than three times a second.

## Signature moves

- **The red number.** The task being worked, the one with a claim, shows its work ID in white on red (`--red`, `--on-red`, Chivo Mono, `--radius-xs`), like the most combative rider's race number. One per claim; nothing else wears it.
- **The gap.** Give the thing that leads some room. The primary action stands apart, not in a row of equals.

## Imagery

- **Flat grounds, one red, the lean.** Carbon or chalk, hard edges, no glows, gradients, grain, or 3D.
- **No mascots for software.** No robots, brains, sparkles, rockets, or lightning bolts: agents are tools, not characters.
- **Bikes stay in the words.** No cyclists, jerseys, or race photos.
- **Screenshots** show the board with made-up tasks (`BRK-`, `WEB-`, `DOC-` IDs and invented titles), never a real repository's private work.

## Checklist

Before handing back anything people see or read:

- [ ] "breakaway" is lowercase, and the terms match [the word list](#words-breakaway-uses).
- [ ] Headlines are short and end in a full stop; no exclamation marks, no words from the never list.
- [ ] Every claim is one from [Claims that must stay true](#claims-that-must-stay-true), and nothing counts what someone shipped with it.
- [ ] Buttons, statuses, and errors are plain; cycling words only in headlines, one per screen at most.
- [ ] Only tokens; one red thing per view; no red text below display size.
- [ ] It works in carbon and chalk, narrow and wide, and the contrast test passes.
- [ ] Keyboard, screen reader, and reduced motion still work.

## Where things are

Paths are from this folder.

| What | Where |
| --- | --- |
| Design tokens | [`tokens.css`](tokens.css) |
| Logo files | [`logo/`](logo/) |
| Preview sheets | [`previews/`](previews/) |
| How they're built | [`tools/build.mjs`](tools/build.mjs): `cd tools && npm install && npm run build`. The geometry is in the file, the colors come from `tokens.css`, and every word is outlines, so the files need no fonts. |
| Contrast and token checks | [`../test/brand.test.js`](../test/brand.test.js), in the board's tests |
| Fonts | `@fontsource-variable/archivo`, `@fontsource-variable/chivo-mono` |
