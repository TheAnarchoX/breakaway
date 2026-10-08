---
title: Describe it as code
nav: Describe it as code
description: The files in .github/breakaway-infra/ that say what should exist, how to write the first one from what runs, how to check a change before its pull request, and golden paths for what you add often.
---

What should exist in an environment is a file in its repository, read from the default branch. Every plan starts from it: the board compares the file with what runs, and the difference is the plan. Nobody has to write the first one by hand.

## The folder

```text
.github/breakaway-infra/
  staging.json          staging's desired state
  production.json       production's
  policy.json           which plans wait for you          (optional)
  scaling.json          scaling rules, inside envelopes    (optional)
  short-lived.json      the template for a task's own one  (optional)
  templates/<name>/     your golden paths                  (optional)
```

Every file but the four reserved names, `policy.json`, `scaling.json`, `short-lived.json`, and `templates/`, is an environment’s, named like it. An envelope is never in a file: it lives on the board, so a pull request can’t widen it.

## An environment’s file

```json
{
  "version": 1,
  "provider": "cloudflare",
  "health": { "url": "https://staging.widgets.example/health" },
  "resources": [
    {
      "id": "worker:widgets-api-staging",
      "kind": "worker",
      "name": "widgets-api-staging",
      "attrs": {
        "compatibilityDate": "2026-09-01",
        "compatibilityFlags": ["nodejs_compat"],
        "observability": true,
        "bindings": [
          { "name": "DB", "type": "d1", "resource": "d1:widgets-staging" },
          { "name": "EXPORTS", "type": "queue", "queue_name": "widgets-exports-staging" }
        ]
      }
    },
    { "id": "d1:widgets-staging", "kind": "d1", "name": "widgets-staging" },
    {
      "id": "queue:widgets-exports-staging",
      "kind": "queue",
      "name": "widgets-exports-staging",
      "attrs": { "deliveryDelay": 0, "deliveryPaused": false }
    }
  ]
}
```

| Field | What it is |
| --- | --- |
| `version` | Always `1`. |
| `provider` | The environment’s provider, `cloudflare`. Optional; when it’s there, it has to match the environment’s. |
| `health` | Optional: your own health address ([below](#a-health-address)). |
| `resources` | What should exist. Each has an `id` (the provider’s own ID, or a new one for something the plan will make), a `kind` ([What’s supported](/docs/architect-supported/#kinds-of-resource)), the `name` it has on the provider, and `attrs`, the settings you want Architect to manage. |

A few rules make it safe to keep in a public repository and easy to review:

- **Only what you want managed.** A setting the file leaves out isn’t compared, so it stays the deploy’s. A resource the file leaves out, though, is one nobody owns: the board flags it, and later asks you about removing it ([Drift, break-glass, and clean up](/docs/architect-drift/#nobody-owns)).
- **Never a value.** A variable’s or secret’s value never goes in it. The board refuses a file with something that looks like one, and names the line: name the secret, never its value.
- **A binding to something the plan still makes** names it by its `id` in the file, in `resource`, as `DB` does above. Once it runs, a binding names it the way Cloudflare does: a database or namespace by its ID, a bucket, queue, or Worker by its name.
- **Read once per new commit** on the default branch. A file that doesn’t check shows its error on the environment, and the board keeps planning from the last good copy.
- **An observe-only environment takes none.** A file for one is refused.

## Write the first one from what runs

Start from what runs, never from a blank file. The board drafts it from the environment’s inventory: names, kinds, and the settings it manages, never a secret’s value. Its notes say what it left out and why.

- **On the board.** An environment with no file shows **Describe it as code**: the draft, read only, with **Copy**. **Propose it**, on the change beside the map, has the board open the pull request with the draft as the file, with your edits on top if you made any. Or **Have an agent open the pull request**: the board adds a task, `Describe staging as code`, and starts the repository’s agent on it. One is open at a time per environment.
- **In a checkout.** `npx breakaway infra adopt staging` writes the draft to `.github/breakaway-infra/staging.json`, then checks it and says what to do next: commit it and open a pull request. It never overwrites a file that’s there unless you pass `--force`; `--dry-run` prints the draft and writes nothing.

The draft says what already runs, so its plan should change nothing. Its pull request’s plan check shows that before you merge. A change the board proposed that plans nothing shows **Merge** instead of Approve: “Merge #12? Nothing changes in staging: merging records it as code.”

## Check a change before its pull request

```sh
npx breakaway infra check            # every file in .github/breakaway-infra/
npx breakaway infra check staging    # one environment
```

It checks each environment’s file, `policy.json`, and `scaling.json` with the board’s own checks. A file that doesn’t check is named with its line and field, like `.github/breakaway-infra/staging.json:4: resources[0].kind: …`, nothing goes to the board, and it exits 1.

For each file that checks, it asks the board for the plan it would make from what runs now: what changes, the cost change, what else it touches, whether it can be undone, and the policy’s answer under the checkout’s `policy.json`. The board keeps none of it: a preview has no ID and can’t be approved, so agents may run it. A repository gets 10 previews a minute.

## Golden paths

A golden path is your own template for something you add often: a queue, a database, a new service, the way you like it. `infra add` writes the change it makes into the checkout, the file and the code together, so an agent opens an ordinary pull request.

```sh
npx breakaway infra add                                   # list the templates
npx breakaway infra add queue staging name=jobs worker=widgets-api-staging
npx breakaway infra check staging
```

breakaway ships one example, **`queue`**: a Cloudflare queue, bound to a Worker the environment’s file already has, and a small module that sends to it. Your own go in `.github/breakaway-infra/templates/<name>/template.json`, and one with an example’s name replaces it. Here’s the `queue` example, a little shortened:

```json
{
  "version": 1,
  "title": "A queue a Worker sends to",
  "description": "A Cloudflare queue, bound to a Worker already in the environment's file, and a small module that sends to it.",
  "provider": "cloudflare",
  "inputs": {
    "name": { "help": "the queue's name, like jobs", "pattern": "^[a-z0-9][a-z0-9-]{0,62}$" },
    "worker": { "help": "the Worker that sends to it, one the environment's file already has" },
    "binding": { "help": "what the Worker calls it, like JOBS", "default": "{{name|upper}}" }
  },
  "resources": [
    { "id": "queue:{{name}}", "kind": "queue", "name": "{{name}}", "attrs": { "deliveryDelay": 0 } }
  ],
  "extend": [
    {
      "kind": "worker",
      "name": "{{worker}}",
      "list": "bindings",
      "add": { "name": "{{binding}}", "type": "queue", "queue_name": "{{name}}" }
    }
  ],
  "files": [{ "from": "send.js.tmpl", "to": "src/queues/{{name}}.js" }]
}
```

- **`inputs`**: what it asks for, each with `help`, and optionally a `pattern` and a `default`. `{{input}}` anywhere is the input’s value, and `{{input|upper}}` is it in capitals with `-` as `_`. Values are names: letters, digits, `-`, and `_`.
- **`resources`**: what it adds to the environment’s file.
- **`extend`**: what it adds to a list setting of a resource the file already has, like a Worker’s `bindings`.
- **`files`**: code from the template’s folder, written at a path in the checkout.

It refuses, and changes nothing, when the file already has the resource, when the resource to extend isn’t there or doesn’t list that setting yet (adding to it would drop the rest), when a code file is already there, or when a path leaves the checkout. It never plans or applies. Your templates show on the console’s **Add resource** too, under the kinds.

## A health address

An environment’s file may name your own health address:

```json
{ "version": 1, "health": { "url": "https://staging.widgets.example/health" }, "resources": [] }
```

It’s `https`, holds no credentials, and is your own service. The board sends it one `GET` each time it looks, every 15 minutes, as a check of the environment’s front door: its routes and custom domains take their health from the answer. It’s the one address Architect calls that isn’t a provider’s.
