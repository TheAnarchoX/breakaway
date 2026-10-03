# Security

## Report a problem

Please report a vulnerability privately, not in a public issue or pull request. Use [GitHub's private vulnerability reporting](https://github.com/TheAnarchoX/breakaway/security/advisories/new) on this repository.

Say what you found, how to reproduce it, and what it lets someone do. You'll get a reply as soon as the owner can give one. Please give a fix time to ship before you share details.

## What an install holds

Each person runs breakaway on their own Cloudflare account, so what follows lives in your install and nowhere else. breakaway has no hosted version and sends no analytics or telemetry.

- **The board's API token**, which lets the CLI and agents read and change tasks.
- **The GitHub App's private key**, which lets the board read pull requests and checks on the repositories you connect.
- **Routine tokens**, which let a routine on claude.ai start an agent on a task.
- **Push keys**, for the notifications the board sends you.
- **Your tasks**, in the install's Durable Object.

Secrets belong in `.dev.vars` (locally) or your install's Secrets Store, never in a tracked file. If one leaks, rotate it and tell us if the leak came from breakaway's code.

## What's in scope

A flaw in breakaway's code that lets someone read or change an install's data without its token, run code, or get hold of a secret. Problems in Cloudflare, GitHub, Claude Code, or Taskwarrior belong with their own projects.
