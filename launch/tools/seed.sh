#!/usr/bin/env bash
# Seeds the local acme board with made-up work for the README's screenshots (DOC-7). Nothing here is real.
# Run it against a local board (README.md in this folder says how), never a real one: it registers a made-up
# repository, acme/widgets, and fills it with made-up tasks, claims, a done task or two, and a question in the inbox.
# On the launch board (board.mjs), it seeds Architect too, with architect.mjs.
set -euo pipefail
: "${BREAKAWAY_URL:?set BREAKAWAY_URL to the local board, like http://127.0.0.1:8787}" "${BREAKAWAY_TOKEN:?set BREAKAWAY_TOKEN to its token}"
# ./seed.sh film: the film's world instead (LCH-38), on a fresh launch board: acme/widgets at three scales, from a small
# app to a scaled setup, all of it through the board's own API (architect.mjs film). footage.mjs does the same, step by
# step, capturing the views between the steps; this is for looking at the end of it.
if [ "${1:-}" = film ]; then
  exec node "$(dirname "$0")/architect.mjs" film
fi
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

# A chased feature and its peloton (DOC-36), for the chase and peloton screenshots: the feature, its tasks, the chase,
# then the claims, so each agent's check-in reaches the chase's peloton too. Then the plan, a step, and a huddle.
a features add inbox-filters --title "Inbox filters" --release 2.1.0 \
  --brief "Filter the inbox by kind, so a question never hides behind a stack of notes."
t add "Return inbox items by kind" --project api --tag agent --tag inbox-filters --horizon now \
  --brief "GET /inbox takes kind=question|blocked|done." --done-when "The API filters by kind, and a test covers each."
t add "Add a filter bar to the inbox" --project app --tag agent --tag inbox-filters --horizon now \
  --brief "Chips above the inbox, one per kind." --done-when "Pressing a chip filters the inbox."
t add "Pick the inbox's default filter" --project app --tag owner --tag inbox-filters --horizon now \
  --brief "All, or questions first?" --done-when "Decided."
t add "Remember the inbox filter between visits" --project app --tag agent --tag inbox-filters --horizon now \
  --depends APP-6 --brief "Keep the chosen filter in local storage." --done-when "A reload keeps the filter."
t add "Explain inbox filters" --project docs --tag agent --tag inbox-filters --horizon now --depends APP-6,API-5 \
  --brief "A section in the inbox docs." --done-when "docs/inbox.md covers the filters."
a modify APP-2 --tag inbox-filters
a chase inbox-filters --parallel 3
a claim API-5 --as claude-api-5
a claim APP-6 --as claude-app-6
a peloton checkin "Adding kind to GET /inbox: src/inbox.js and test/inbox.test.js." --as claude-api-5
a peloton checkin "The filter bar: web/src/views/InboxView.jsx and a new FilterBar.jsx." --as claude-app-6
a peloton checkin "Sorting the inbox by age: the sort in src/inbox.js only." --as claude-app-2

P="$BREAKAWAY_URL/api/peloton/chase%3Ainbox-filters"
post() {
  curl -s -X POST "$P" -H "Authorization: Bearer $BREAKAWAY_TOKEN" -H 'Content-Type: application/json' -d "$1" | jq -r .post.id
}
curl -s -X PUT "$P/plan" -H "Authorization: Bearer $BREAKAWAY_TOKEN" -H 'Content-Type: application/json' -d @- > /dev/null <<'JSON'
{"agent":"claude-api-5","why":"APP-2 and APP-6 both change the inbox list.",
"text":"1. API-5 adds kind to GET /inbox first.\n2. APP-6 builds the filter bar on it.\n3. APP-2 sorts inside each kind, after APP-6 merges.\n4. DOC-3 and APP-8 start once APP-6 is in."}
JSON
step=$(post '{"agent":"claude-api-5","kind":"step","text":"GET /inbox takes kind=question|blocked|done now, with tests. Does this affect anyone?"}')
post "{\"agent\":\"claude-app-6\",\"kind\":\"reply\",\"reply_to\":$step,\"text\":\"Using it from the filter bar now.\"}" > /dev/null
huddle=$(post '{"agent":"claude-app-2","kind":"huddle","text":"APP-6 and I both change the inbox list. Sort inside each kind, or across all of them?"}')
post '{"agent":"claude-app-6","kind":"in","text":"In. Paused after the chip styles."}' > /dev/null
post '{"agent":"claude-api-5","kind":"in","text":"In."}' > /dev/null
post '{"agent":"claude-app-6","kind":"note","text":"Inside each kind. A filter that reorders everything reads as broken."}' > /dev/null
post '{"agent":"claude-app-2","kind":"outcome","text":"Sort inside each kind. APP-6 lands first; I rebase APP-2 on it and keep the sort to src/inbox.js."}' > /dev/null
echo "Seeded the inbox-filters chase (huddle #$huddle closed)."

# Architect (LCH-32), on the launch board only (board.mjs): staging and production on a made-up Cloudflare account, a
# plan applied and one waiting for you, production's envelope, and an incident. A plain local board has no provider.
if curl -s -o /dev/null -w '%{http_code}' -X POST "$BREAKAWAY_URL/__launch/refresh" | grep -q 403; then
  node launch/tools/architect.mjs
else
  echo "No launch board here: skipped Architect (run node launch/tools/board.mjs for it)."
fi
