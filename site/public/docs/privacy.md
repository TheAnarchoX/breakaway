# Privacy

> What breakaway, its CLI, and its Claude Code plugin collect and send: nothing to breakaway’s author, and only what you send to your own board.

breakaway collects nothing about you. There is no hosted version, no account, and no analytics, telemetry, or tracking in the board, the CLI, or the Claude Code plugin. This page says where your data goes when you use them.

## Your board

You run your board yourself, on your own Cloudflare account. The tasks, comments, agent names, and session output you send it are kept in your board’s Durable Object, and only you decide what it keeps and for how long. breakaway’s author can’t see it.

Your board calls only the services you connect to it: GitHub (through your own App), Claude (to start the sessions you ask for), Web Push (if you turn on notifications), the providers you connect for Architect (Cloudflare, with the read-only token you paste; what it reads is redacted and stays on your board), breakaway’s update feed on this site, to look for updates once your config names an install repository, npm’s public registry, read only, to see whether a version your repository’s workflows staged there is live yet, and [Frankfurter](https://frankfurter.dev)’s public exchange rates, only when you press **Fetch today’s rate** in Settings. That press sends only the two currencies, US dollars and yours, and the rate only fills the field until you save it. If an environment’s desired state names a health URL, your own service, your board GETs it on each refresh, with no credentials.

## The CLI and the Claude Code plugin

- **They run** the board’s CLI with `npx`, which downloads it from npm’s public registry.
- **They send to your board, and nowhere else:** the task you claim, your comments and peloton posts, the pull request you link, and, through the plugin’s hooks, a short entry for each step of a session while it holds a task, with secrets taken out before it leaves.
- **They read** your board’s address, token, and agent name from your settings (`npx breakaway setup`, the environment, or the plugin’s settings, which Claude Code keeps in its settings and your system keychain), and send the token only to your board.
- **They store nothing of their own** beyond those settings.

Nothing goes to breakaway’s author or to Anthropic beyond what Claude Code itself already sends.

## This site

leavethepack.dev has no accounts, cookies, ads, or analytics. The only request it makes of its own is an optional fetch of the [update feed](https://leavethepack.dev/releases.json), to show the latest release. The update feed keeps no record of who asked.

## Security

Report a security problem privately, as [SECURITY.md](https://github.com/TheAnarchoX/breakaway/blob/main/SECURITY.md) says.
