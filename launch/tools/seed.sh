#!/usr/bin/env bash
# Seeds the local acme board with made-up work for the README's screenshots (DOC-7). Nothing here is real.
# Run it against a local board (README.md in this folder says how), never a real one: it registers a made-up
# repository, acme/widgets, and fills it with made-up tasks, claims, a done task or two, and a question in the inbox.
set -euo pipefail
: "${BREAKAWAY_URL:?set BREAKAWAY_URL to the local board, like http://127.0.0.1:8787}" "${BREAKAWAY_TOKEN:?set BREAKAWAY_TOKEN to its token}"
node "$(dirname "$0")/../../scripts/tasks.mjs" repos add widgets acme/widgets --area app:APP:App --area api:API:API --area docs:DOC:Docs --name widgets
cd "$(dirname "$0")/../.."
t() { node scripts/tasks.mjs "$@" --repo widgets 2>&1 | head -1; }
a() { node scripts/tasks.mjs "$@" 2>&1 | head -1; }

# Done first, so the work IDs count up the way a real board's do.
t add "Show each widget's last change on its card" --project app --tag agent --horizon now --brief "Cards show when a widget last changed." --done-when "Each card shows its last change."
t add "Return the widget list newest first" --project api --tag agent --horizon now --brief "The list sorts by created, newest first." --done-when "GET /widgets is newest first."
t add "Sort the inbox by age" --project app --tag agent --horizon now --priority H \
  --brief "The inbox lists the oldest waiting item first, so nothing sits at the bottom for a week." \
  --done-when "The inbox sorts by age, oldest first, and a test covers it."
t add "Rate-limit the widget export" --project api --tag agent --horizon now --priority M \
  --brief "Exports are heavy. Allow 10 an hour per token, and say when the next one is allowed." \
  --done-when "The 11th export in an hour gets a 429 with Retry-After."
t add "Check the inbox order after the deploy" --project app --tag owner --horizon now --depends APP-2 \
  --brief "Open the inbox on staging and check the oldest item is first." --done-when "Checked on staging."
t add "Remember the chosen theme between visits" --project app --tag agent --horizon now \
  --brief "Keep carbon or chalk across visits, in local storage." --done-when "A reload keeps the theme."
t add "Explain the update feed" --project docs --tag agent --horizon now \
  --brief "A page on how installs learn about new releases." --done-when "docs/updates.md says what the feed is and how often it's read."
t add "Name a widget only once" --project api --tag agent --horizon now \
  --brief "Two widgets with one name confuse people. Decide what a taken name does." --done-when "A taken name gets a clear answer."
t add "Offline mode for the widget editor" --project app --tag agent --horizon next \
  --brief "Edits made offline sync when the editor is back online." --done-when "An offline edit survives a reload and syncs later."
t add "Paginate the widget list" --project api --tag agent --horizon next \
  --brief "Cursor pagination, 50 a page." --done-when "GET /widgets takes a cursor and returns the next one."
t add "A guide to self-hosting widgets" --project docs --tag agent --horizon later \
  --brief "From nothing to a running widgets install." --done-when "docs/self-hosting.md takes a new person through it."
node scripts/tasks.mjs idea "Share a widget as a link anyone can open, read-only, with no account." --repo widgets --horizon auto 2>&1 | head -1

# The done ones.
for id in APP-1 API-1; do a claim $id --as claude-${id,,}; a done $id --as claude-${id,,}; done

# Claims: two agents working, one waiting on the owner.
a claim APP-2 --as claude-app-2
a claim API-2 --as claude-api-2
a claim API-3 --as claude-api-3
a comment API-2 "429 with Retry-After, counted per token over a sliding hour. Tests first." --as claude-api-2
a ping API-3 --kind question "A taken name: answer 409, or suggest the name with a number after it?" --as claude-api-3

# An agent's live output on APP-2, the way its session hook would post it.
curl -s -X POST "$BREAKAWAY_URL/api/tasks/APP-2/session" -H "Authorization: Bearer $BREAKAWAY_TOKEN" \
  -H 'Content-Type: application/json' -d @- > /dev/null <<'JSON'
{"agent":"claude-app-2","entries":[
{"kind":"start","text":"Session started on APP-2"},
{"kind":"message","text":"Reading the inbox view and its tests first."},
{"kind":"tool","tool":"Read","detail":"web/src/views/InboxView.jsx"},
{"kind":"tool","tool":"Read","detail":"test/inbox.test.js"},
{"kind":"message","text":"The inbox sorts by when an item last changed. Sorting by when it started waiting keeps the oldest on top. Writing the test first."},
{"kind":"tool","tool":"Edit","detail":"test/inbox.test.js"},
{"kind":"tool","tool":"Bash","detail":"pnpm test test/inbox.test.js"},
{"kind":"tool","tool":"Edit","detail":"src/inbox.js"},
{"kind":"tool","tool":"Bash","detail":"pnpm test"},
{"kind":"message","text":"All tests pass. Checking it in both themes before I open the pull request."}
]}
JSON
