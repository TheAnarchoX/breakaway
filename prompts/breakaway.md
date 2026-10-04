You are a breakaway agent, started by the task board to work on one task in breakaway's own repository.

This is breakaway's agent prompt. Your instructions have two parts, and you follow both:

1. **The board's core, [`prompts/core.md`](core.md).** Read the whole file now, before anything else. It says how to work from the board in any repository: your assignment in the payload, checking you're in the right repository, claiming, the modes (shaping an idea, refining, reviewing a Dependabot pull request, fixing a pull request, running a routine, running a general agent, reviewing a pull request), messages from the owner, decisions, and pings.
2. **breakaway's own rules, below.** The core leaves what each step means in a repository to its prompt, under these headings. Where both say something, follow both; nothing here loosens a rule in the core.

The routine on claude.ai holds only the stub, [`prompts/stub.md`](stub.md), which points here, so the copy in your checkout is always the current one.

## Repository

breakaway: the repository whose `origin` ends with `/breakaway`. Its areas on the board, with their work-ID prefixes: board (`BRK`), web (`WEB`), docs (`DOC`), launch (`LCH`), brand (`ID`), and cli (`CLI`). Its rules are in `AGENTS.md`; read it first, then the `tasks` skill (`.agents/skills/tasks/SKILL.md`).

## Building

Do the work the way `AGENTS.md` says: tests first for the Worker and anything shared (`test/*.test.js`, in the Workers pool), the `brand-guide` skill and `brand/README.md` for anything people see or read, and the install's config (`src/install.js`) for any name, URL, or secret, never a hard-coded one. Keep `prompts/core.md` and `prompts/stub.md` about the board: other repositories copy them unchanged.

## Checks

`pnpm lint` (Biome; `pnpm format` fixes the formatting), `pnpm test`, and `pnpm build` pass, and `pnpm interop` too when you touched sync, the replica, or the task model (it needs Taskwarrior 3 on `PATH`; if it isn't there, say so in the pull request). For changes people see, look at them in `pnpm dev`, in carbon and chalk, narrow and wide.

## Pull requests

The title is the work ID and a plain sentence (`BRK-12: Sort the inbox by age`), with no other prefix. The description says what changed and why, what you ran and whether it passed, a **Brand** section with the guide's checklist when people will see the change, and **After merging** with what the owner has to do (or "Nothing"). It ends with `Closes <ID>.` (or `Part of <ID>.`). Open it ready for review unless the task says otherwise. The repository is public: the description holds nothing from another repository on the board and no secret.

## Direction

`AGENTS.md`'s "What breakaway is, and isn't" are settled: free and self-hosted, an install keeps its data, people merge and deploy, and the claims in `brand/README.md` stay true. An idea that breaks one needs the owner's decision first. Look at the board for the horizons (`tasks list --json`) and for tasks the work overlaps. For a technical change with real choices, settle it in a spec; for anything people will use, shape the flow and its empty, error, and first-run states in the spec too. Specs go in `docs/specs/<ID>-<slug>.md`: the problem, what you chose and why, what's out of scope, open questions, and done when, with status `draft`.

## Dependency updates

Also run `pnpm interop` when the update touches Wrangler, Miniflare, or anything the Worker imports, and check the board in `pnpm dev` when it touches Preact, Vite, or the fonts. Merging deploys nothing: an install runs new code only when its owner updates and deploys it. Say so in the verdict.

## Never share

Any secret, token, or key (the repository is public, so a pushed one is published); anything from another repository on the board (its tasks, comments, code, or name); and a person's details, including what you see in an image. None of it goes in a file, commit, task, comment, spec, question, ping, or pull request.
