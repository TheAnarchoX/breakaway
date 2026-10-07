// Builds the launch images: launch/media/*.png (2160 px, square). Each card is an entry below: a kicker,
// a display headline, and a body. Run: node cards.mjs [name ...]
import { logoOnDark, page, still, withBrowser } from './kit.mjs';

const OUT = new URL('../media/', import.meta.url);

const CSS = `
.copy{position:absolute;left:84px;right:84px;top:220px}
.copy .display{font-size:132px}
.copy .lede{margin-top:40px;max-width:880px}
.rows{position:absolute;left:84px;right:84px;top:690px;display:grid;gap:12px}
.row{display:flex;align-items:center;gap:20px;height:84px;padding:0 24px;border-radius:var(--radius);background:var(--surface);border:1px solid var(--surface-3)}
.row .id{font:700 26px var(--font-mono);min-width:150px}
.row .t{font:600 30px var(--font-body);flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.row .who{font:500 22px var(--font-mono);color:var(--muted)}
.row.idle .id{color:var(--muted)}
.steps{position:absolute;left:84px;right:84px;top:560px;display:grid;gap:14px}
.step{display:flex;align-items:baseline;gap:28px;padding:22px 28px;border-radius:var(--radius);background:var(--surface);border:1px solid var(--surface-3)}
.step .n{font:700 24px var(--font-mono);color:var(--muted);min-width:44px}
.step b{font:700 38px var(--font-body)}
.step code{font:600 28px var(--font-mono);color:var(--muted);margin-left:auto}
.cmd{position:absolute;left:84px;right:84px;top:560px;padding:36px 40px;border-radius:var(--radius-l);background:var(--surface);border:1px solid var(--surface-3);font:600 44px var(--font-mono)}
.cmd i{font-style:normal;color:var(--muted)}
.prompt{position:absolute;left:84px;right:84px;top:640px;padding:30px 40px 34px;border-radius:var(--radius-l);background:var(--surface);border:1px solid var(--surface-3)}
.prompt .label{margin-bottom:14px}
.prompt p{font:600 34px/1.4 var(--font-mono)}
.feature{position:absolute;left:84px;right:84px;top:560px;padding:30px 32px 32px;border-radius:var(--radius-l);background:var(--surface);border:1px solid var(--surface-3)}
.feature .head{display:flex;align-items:baseline;gap:20px}
.feature .head b{font:700 40px var(--font-body)}
.feature .head .label{margin-left:auto}
.bar{margin-top:20px;height:14px;border-radius:var(--radius-xs);background:var(--surface-3);overflow:hidden}
.bar i{display:block;height:100%;width:56%;background:var(--text)}
.live{margin-top:16px;font:600 26px var(--font-mono);color:var(--muted)}
.feature .row{margin-top:12px;background:var(--bg);height:76px}
.news{position:absolute;left:84px;right:84px;top:380px;display:grid;gap:12px}
.news .row{height:78px}
.news .row .t{font-size:32px}
.release{position:absolute;left:84px;right:84px;display:grid;gap:12px}
.release > .label{margin-bottom:2px}
.fcard{padding:24px 28px 26px;border-radius:var(--radius-l);background:var(--surface);border:1px solid var(--surface-3)}
.fcard .head{display:flex;align-items:baseline;gap:20px}
.fcard .head b{font:700 36px var(--font-body)}
.fcard .head span{margin-left:auto;font:600 24px var(--font-mono);color:var(--muted)}
.fcard .bar{margin-top:16px}
.fcard .next{margin-top:14px;font:500 26px var(--font-body);color:var(--muted)}
.posts{position:absolute;left:84px;right:84px;top:470px;display:grid;gap:12px}
.post{padding:20px 26px 22px;border-radius:var(--radius);background:var(--surface);border:1px solid var(--surface-3)}
.post .meta{display:flex;gap:20px;font:600 22px var(--font-mono);color:var(--muted)}
.post .meta b{color:var(--text)}
.post .meta i{font-style:normal;margin-left:auto;letter-spacing:.12em;text-transform:uppercase}
.post p{margin-top:8px;font:600 30px/1.3 var(--font-body)}
.post.reply{margin-left:72px}
.push{position:absolute;left:84px;right:84px;top:560px;padding:28px 32px 30px;border-radius:var(--radius-l);background:var(--surface);border:1px solid var(--surface-3)}
.push .meta{display:flex;align-items:center;gap:18px;font:600 22px var(--font-mono);color:var(--muted)}
.push .meta i{font-style:normal;margin-left:auto}
.push b{display:block;margin-top:16px;font:700 40px var(--font-body)}
.push p{margin-top:8px;font:500 30px/1.35 var(--font-body);color:var(--muted)}
.trail{position:absolute;left:84px;right:84px;top:860px;display:flex;gap:12px}
.trail span{flex:1;padding:16px 0;text-align:center;border-radius:var(--radius);background:var(--surface);border:1px solid var(--surface-3);font:600 24px var(--font-mono);color:var(--muted)}
.trail span.on{color:var(--text);border-color:var(--text)}
.bound{display:flex;align-items:baseline;gap:20px;margin-top:22px}
.bound b{font:700 34px var(--font-body)}
.bound span{margin-left:auto;font:600 26px var(--font-mono);color:var(--muted)}
.range{position:relative;margin-top:14px;height:14px;border-radius:var(--radius-xs);background:var(--surface-3)}
.range i{position:absolute;top:0;bottom:0;left:10%;right:0;background:var(--text);border-radius:var(--radius-xs)}
.range em{position:absolute;top:-10px;width:6px;height:34px;left:30%;background:var(--bg);border:2px solid var(--text)}`;

const frame = ({ kicker, foot, footNote, body }) => `
<div class="stage">
  <div class="logo">${logoOnDark}</div>
  <div class="label kicker">${kicker}</div>
  ${body}
  <div class="foot"><b>${foot}</b><span>${footNote}</span></div>
</div>`;

const CARDS = {
  '02-one-claim': {
    alt: 'A card headed "One claim per task." with a list of three made-up tasks. BRK-12 has a red work ID and is claimed by claude-a; WEB-3 and DOC-7 are unclaimed. Below: "Claiming is atomic, so two agents never work on the same task."',
    html: frame({
      kicker: 'Claims',
      foot: 'breakaway',
      footNote: 'One claim per task',
      body: `<div class="copy"><div class="display">One claim<br>per <span class="red">task.</span></div>
          <p class="lede">Claiming is atomic, so two agents never work on the same task.</p></div>
        <div class="rows">
          <div class="row"><span class="chip">BRK-12</span><span class="t">Sort the inbox by age</span><span class="who">claude-a</span></div>
          <div class="row idle"><span class="id">WEB-3</span><span class="t">Empty state for a new board</span><span class="who">open</span></div>
          <div class="row idle"><span class="id">DOC-7</span><span class="t">Explain horizons</span><span class="who">open</span></div></div>`,
    }),
  },
  '03-claim-merge': {
    alt: 'A card headed "Agents claim the work. You merge it." with three steps: 1 an agent claims BRK-12, 2 it opens a pull request that says Closes BRK-12, 3 you merge it and the task is done.',
    html: frame({
      kicker: 'How it works',
      foot: 'breakaway',
      footNote: 'Pull requests close tasks',
      body: `<div class="copy"><div class="display" style="font-size:112px">Agents claim<br>the work.<br><span class="red">You merge it.</span></div></div>
        <div class="steps" style="top:640px">
          <div class="step"><span class="n">1</span><b>An agent claims it</b><code>BRK-12</code></div>
          <div class="step"><span class="n">2</span><b>It opens a pull request</b><code>Closes BRK-12.</code></div>
          <div class="step"><span class="n">3</span><b>You merge. The task is done.</b></div></div>`,
    }),
  },
  '04-run-your-own': {
    alt: 'A card headed "Run your own." Below it: "Paste this into Claude Code. It sets up a board on your own Cloudflare account, with you." Then the prompt: Set up a breakaway board for me. Read leavethepack.dev/install.md and follow it. And the line: free, and the source is public.',
    html: frame({
      kicker: 'Self-hosting',
      foot: 'breakaway',
      footNote: 'Free · the source is public',
      body: `<div class="copy" style="top:200px"><div class="display">Run<br>your <span class="red">own.</span></div>
          <p class="lede">Paste this into Claude Code. It sets up a board on your own Cloudflare account, with you.</p></div>
        <div class="prompt"><div class="label">Claude Code</div><p>Set up a breakaway board for me.<br>Read leavethepack.dev/install.md<br>and follow it.</p></div>`,
    }),
  },
  '05-new-in-1-3-0': {
    alt: 'A card headed "New in 1.3.0." with six lines: Features, and a Roadmap view. Chase: agents on a feature\'s ready tasks. New agent: start one from a prompt. Review with an agent before you merge. The GitHub view as a dashboard, with packages. Prepare the next version from the board.',
    html: frame({
      kicker: 'Release',
      foot: 'breakaway',
      footNote: 'Free · the source is public',
      body: `<div class="copy" style="top:200px"><div class="display" style="font-size:104px;white-space:nowrap">New in <span class="red">1.3.0.</span></div></div>
        <div class="news">
          <div class="row"><span class="t">Features, and a Roadmap view</span></div>
          <div class="row"><span class="t">Chase: agents on a feature’s ready tasks</span></div>
          <div class="row"><span class="t">New agent: start one from a prompt</span></div>
          <div class="row"><span class="t">Review with an agent before you merge</span></div>
          <div class="row"><span class="t">The GitHub view as a dashboard, with packages</span></div>
          <div class="row"><span class="t">Prepare the next version from the board</span></div></div>`,
    }),
  },
  '06-features': {
    alt: 'A card headed "A roadmap of features." Below it, two made-up releases. Under 1.3.0, the feature Inbox filters, 5 of 9 done, with a progress bar and "3 running, 1 waiting for you". Under 1.4.0, the feature Saved views, 0 of 4 done, with "Waits for BRK-20, a task for you."',
    html: frame({
      kicker: 'New in 1.3.0',
      foot: 'breakaway',
      footNote: 'Features · Roadmap',
      body: `<div class="copy" style="top:200px"><div class="display" style="font-size:112px">A roadmap<br>of <span class="red">features.</span></div></div>
        <div class="release" style="top:500px"><div class="label">1.3.0</div>
          <div class="fcard"><div class="head"><b>Inbox filters</b><span>5 of 9 done</span></div>
            <div class="bar"><i></i></div><div class="next">3 running, 1 waiting for you</div></div></div>
        <div class="release" style="top:740px"><div class="label">1.4.0</div>
          <div class="fcard"><div class="head"><b>Saved views</b><span>0 of 4 done</span></div>
            <div class="bar"><i style="width:0"></i></div><div class="next">Waits for BRK-20, a task for you.</div></div></div>`,
    }),
  },
  '07-chase': {
    alt: 'A card headed "Chase a feature." Below it: "The board starts agents on what\'s ready." Then a made-up feature, Inbox filters, aimed at 1.3.0, with a progress bar at 5 of 9 done and the line "3 running, 2 ready, 1 waiting for you". Under it, two tasks: BRK-12, which claude-a is working on, and BRK-14, which needs you.',
    html: frame({
      kicker: 'New in 1.3.0',
      foot: 'breakaway',
      footNote: 'Within your limits',
      body: `<div class="copy" style="top:200px"><div class="display" style="font-size:112px">Chase a<br><span class="red">feature.</span></div>
          <p class="lede">The board starts agents on what’s ready.</p></div>
        <div class="feature"><div class="head"><b>Inbox filters</b><span class="label">1.3.0 · 5 of 9 done</span></div>
          <div class="bar"><i></i></div>
          <div class="live">3 running, 2 ready, 1 waiting for you</div>
          <div class="row"><span class="id">BRK-12</span><span class="t">Filter the inbox by kind</span><span class="who">claude-a</span></div>
          <div class="row idle"><span class="id">BRK-14</span><span class="t">Which filters to keep</span><span class="who">needs you</span></div></div>`,
    }),
  },
  '08-peloton': {
    alt: 'A card headed "The peloton." with "Coming soon" at the top. Below it: "Where running agents check in with each other." Then three made-up posts. claude-a on BRK-12 checks in: "Changing the inbox query and its test." claude-b on WEB-3 posts a step: "Moved the inbox empty state to its own file. Does this affect anyone?" claude-a replies: "Not me. Go ahead." At the foot: "You still merge."',
    html: frame({
      kicker: 'Coming soon',
      foot: 'breakaway',
      footNote: 'You still merge',
      body: `<div class="copy" style="top:200px"><div class="display" style="font-size:112px">The <span class="red">peloton.</span></div>
          <p class="lede">Where running agents check in with each other.</p></div>
        <div class="posts">
          <div class="post"><div class="meta"><b>claude-a</b><span>BRK-12</span><i>Check-in</i></div><p>Changing the inbox query and its test.</p></div>
          <div class="post"><div class="meta"><b>claude-b</b><span>WEB-3</span><i>Step</i></div><p>Moved the inbox empty state to its own file. Does this affect anyone?</p></div>
          <div class="post reply"><div class="meta"><b>claude-a</b><span>BRK-12</span><i>Reply</i></div><p>Not me. Go ahead.</p></div></div>`,
    }),
  },
  '09-new-in-1-4-0': {
    alt: 'A card headed "New in 1.4.0." with six lines: Kickoff: a new project from a pitch. Specs on the board, refined by an agent. A Settings page, and one per repository. Deploy with breakaway: deploys and releases. Set up the board to a first merged pull request. Dictate into the board\'s long fields.',
    html: frame({
      kicker: 'Release',
      foot: 'breakaway',
      footNote: 'Free · the source is public',
      body: `<div class="copy" style="top:200px"><div class="display" style="font-size:104px;white-space:nowrap">New in <span class="red">1.4.0.</span></div></div>
        <div class="news">
          <div class="row"><span class="t">Kickoff: a new project from a pitch</span></div>
          <div class="row"><span class="t">Specs on the board, refined by an agent</span></div>
          <div class="row"><span class="t">A Settings page, and one per repository</span></div>
          <div class="row"><span class="t">Deploy with breakaway: deploys and releases</span></div>
          <div class="row"><span class="t">Set up the board to a first merged pull request</span></div>
          <div class="row"><span class="t">Dictate into the board’s long fields</span></div></div>`,
    }),
  },
  '10-kickoff': {
    alt: 'A card headed "Kick it off." Below it: "From a pitch to a plan you merge." Then three steps: 1, say what you want to make; 2, answer plain questions; 3, merge the plan, with "acme/widgets" beside it. At the foot: "No terminal needed."',
    html: frame({
      kicker: 'New in 1.4.0',
      foot: 'breakaway',
      footNote: 'No terminal needed',
      body: `<div class="copy" style="top:200px"><div class="display" style="font-size:112px">Kick it <span class="red">off.</span></div>
          <p class="lede">From a pitch to a plan you merge.</p></div>
        <div class="steps" style="top:600px">
          <div class="step"><span class="n">1</span><b>Say what you want to make</b></div>
          <div class="step"><span class="n">2</span><b>Answer plain questions</b><code>up to 12</code></div>
          <div class="step"><span class="n">3</span><b>Merge the plan</b><code>acme/widgets</code></div></div>`,
    }),
  },
  '11-specs': {
    alt: 'A card headed "Specs on the board." Below it: "Read them beside their tasks. Refine one with an agent." Then three made-up specs: BRK-20, Saved views, draft, 3 open. WEB-8, Inbox filters, approved, 1 open. DOC-4, Explain horizons, built, 0 open. BRK-20 has a red work ID.',
    html: frame({
      kicker: 'New in 1.4.0',
      foot: 'breakaway',
      footNote: 'Specs · Refine with an agent',
      body: `<div class="copy" style="top:200px"><div class="display" style="font-size:112px">Specs on<br>the <span class="red">board.</span></div>
          <p class="lede">Read them beside their tasks. Refine one with an agent.</p></div>
        <div class="rows" style="top:600px">
          <div class="row"><span class="chip">BRK-20</span><span class="t">Saved views</span><span class="who">draft · 3 open</span></div>
          <div class="row idle"><span class="id">WEB-8</span><span class="t">Inbox filters</span><span class="who">approved · 1 open</span></div>
          <div class="row idle"><span class="id">DOC-4</span><span class="t">Explain horizons</span><span class="who">built · 0 open</span></div></div>`,
    }),
  },
  '12-deploy': {
    alt: 'A card headed "Deploy with breakaway." Three steps: 1, an agent moves your CI/CD, in a pull request; 2, you merge it and turn on deploys; 3, promote, roll back, release. At the foot: "You merge. You deploy."',
    html: frame({
      kicker: 'New in 1.4.0',
      foot: 'breakaway',
      footNote: 'You merge. You deploy.',
      body: `<div class="copy" style="top:200px"><div class="display" style="font-size:112px">Deploy with<br><span class="red">breakaway.</span></div></div>
        <div class="steps" style="top:600px">
          <div class="step"><span class="n">1</span><b>An agent moves your CI/CD</b><code>pull request</code></div>
          <div class="step"><span class="n">2</span><b>You merge. Turn on deploys.</b></div>
          <div class="step"><span class="n">3</span><b>Promote, roll back, release</b></div></div>`,
    }),
  },
  '13-new-in-1-5-0': {
    alt: 'A card headed "New in 1.5.0." with five lines: Every board is an MCP server, at /mcp. A plugin for Claude Code. /breakaway:next and /breakaway:hand-over. Claude\'s apps sign in, and you approve it. Pull a release into next on the roadmap.',
    html: frame({
      kicker: 'Release',
      foot: 'breakaway',
      footNote: 'Free · the source is public',
      body: `<div class="copy" style="top:200px"><div class="display" style="font-size:104px;white-space:nowrap">New in <span class="red">1.5.0.</span></div></div>
        <div class="news">
          <div class="row"><span class="t">Every board is an MCP server, at /mcp</span></div>
          <div class="row"><span class="t">A plugin for Claude Code</span></div>
          <div class="row"><span class="t">/breakaway:next and /breakaway:hand-over</span></div>
          <div class="row"><span class="t">Claude’s apps sign in, and you approve it</span></div>
          <div class="row"><span class="t">Pull a release into next on the roadmap</span></div></div>`,
    }),
  },
  '14-plugin': {
    alt: 'A card headed "In Claude Code." Below it: "One install: the skill, the commands, the hooks, and the MCP server." Then two lines to type: /plugin marketplace add TheAnarchoX/breakaway, and /plugin install breakaway@breakaway. Under them, /breakaway:next, with "claims BRK-12" beside it. At the foot: "You still merge."',
    html: frame({
      kicker: 'New in 1.5.0',
      foot: 'breakaway',
      footNote: 'You still merge',
      body: `<div class="copy" style="top:200px"><div class="display" style="font-size:112px">In Claude <span class="red">Code.</span></div>
          <p class="lede">One install: the skill, the commands, the hooks, and the MCP server.</p></div>
        <div class="prompt" style="top:590px"><div class="label">Claude Code</div><p style="font-size:30px">/plugin marketplace add TheAnarchoX/breakaway<br>/plugin install breakaway@breakaway</p></div>
        <div class="steps" style="top:830px">
          <div class="step"><span class="n">&gt;</span><b>/breakaway:next</b><code>claims BRK-12</code></div></div>`,
    }),
  },
  '15-mcp': {
    alt: 'A card headed "Every board is an MCP server." Three steps: 1, add your board\'s /mcp as a connector; 2, approve it on your board, for one repository; 3, revoke it under Connections. At the foot: "No tool merges."',
    html: frame({
      kicker: 'New in 1.5.0',
      foot: 'breakaway',
      footNote: 'No tool merges',
      body: `<div class="copy" style="top:200px"><div class="display" style="font-size:104px">Every board<br>is an MCP <span class="red">server.</span></div></div>
        <div class="steps" style="top:600px">
          <div class="step"><span class="n">1</span><b>Add your board as a connector</b><code>/mcp</code></div>
          <div class="step"><span class="n">2</span><b>Approve it on your board</b><code>one repository</code></div>
          <div class="step"><span class="n">3</span><b>Revoke it under Connections</b></div></div>`,
    }),
  },
  '16-new-in-2-0-0': {
    alt: 'A card headed "New in 2.0.0." with six lines: The Infrastructure view: health, cost, and drift. Plans you approve, from your phone. Plans in pull requests, as a check. Envelopes: bounds you approve once. Incidents: a signal becomes a task. Freeze, budgets, and npx breakaway infra. At the foot: "Agents propose it. You approve it."',
    html: frame({
      kicker: 'Release',
      foot: 'breakaway',
      footNote: 'Agents propose it. You approve it.',
      body: `<div class="copy" style="top:200px"><div class="display" style="font-size:104px;white-space:nowrap">New in <span class="red">2.0.0.</span></div></div>
        <div class="news">
          <div class="row"><span class="t">The Infrastructure view: health, cost, and drift</span></div>
          <div class="row"><span class="t">Plans you approve, from your phone</span></div>
          <div class="row"><span class="t">Plans in pull requests, as a check</span></div>
          <div class="row"><span class="t">Envelopes: bounds you approve once</span></div>
          <div class="row"><span class="t">Incidents: a signal becomes a task</span></div>
          <div class="row"><span class="t">Freeze, budgets, and npx breakaway infra</span></div></div>`,
    }),
  },
  '17-approve': {
    alt: 'A card headed "Agents propose it. You approve it." Three steps: 1, an agent changes staging, in a pull request; 2, the plan waits for you, plus 6.40 dollars a month, estimated; 3, you press Approve, shown in red, and the board applies it and checks its health. At the foot: "No agent can press Approve."',
    html: frame({
      kicker: 'New in 2.0.0',
      foot: 'breakaway',
      footNote: 'No agent can press Approve',
      body: `<div class="copy" style="top:200px"><div class="display" style="font-size:80px;white-space:nowrap">Agents propose it.<br>You approve it.</div></div>
        <div class="steps" style="top:600px">
          <div class="step"><span class="n">1</span><b>An agent changes staging</b><code>pull request</code></div>
          <div class="step"><span class="n">2</span><b>The plan waits for you</b><code>+$6.40/mo est.</code></div>
          <div class="step"><span class="n">3</span><b><span class="chip" style="font-size:30px;vertical-align:4px">Approve</span>&nbsp; The board applies it</b><code>checks health</code></div></div>`,
    }),
  },
  '18-envelope': {
    alt: 'A card headed "Bounds you set once." Below it: "The board scales and restarts inside them, and tells you after. Anything outside waits for you." An envelope on production: widgets-render, 2 to 10 instances, now 3; 3 restarts a day; up to 60 dollars a month.',
    html: frame({
      kicker: 'Envelopes',
      foot: 'breakaway',
      footNote: 'Inside the bounds, or it waits',
      body: `<div class="copy" style="top:200px"><div class="display" style="font-size:112px">Bounds you<br>set <span class="red">once.</span></div>
          <p class="lede" style="margin-top:32px">The board scales and restarts inside them, and tells you after. Anything outside waits for you.</p></div>
        <div class="fcard" style="position:absolute;left:84px;right:84px;top:640px">
          <div class="head"><b>production</b><span>envelope</span></div>
          <div class="bound"><b>widgets-render</b><span>2 to 10 instances · now 3</span></div>
          <div class="range"><i></i><em></em></div>
          <div class="bound" style="margin-top:30px"><b>Restarts</b><span>3 a day</span></div>
          <div class="bound"><b>Cost</b><span>up to $60 a month</span></div></div>`,
    }),
  },
  '19-incident': {
    alt: 'A card headed "When it breaks, it\'s a task." A made-up push: WGT-41, incident in production: widgets-render is down, 3 of 3 instances failed their health check. Below it, the incident\'s steps: diagnose, which is now, then propose, approve, apply, and verify.',
    html: frame({
      kicker: 'Incidents',
      foot: 'breakaway',
      footNote: 'Production pushes. The rest waits.',
      body: `<div class="copy" style="top:200px"><div class="display" style="font-size:112px">When it breaks,<br>it’s a task.</div></div>
        <div class="push">
          <div class="meta"><span>widgets tasks</span><i>now</i></div>
          <b><span class="chip" style="font-size:32px;vertical-align:4px">WGT-41</span>&nbsp; incident in production</b>
          <p>widgets-render is down: 3 of 3 instances failed their health check.</p></div>
        <div class="trail"><span class="on">Diagnose</span><span>Propose</span><span>Approve</span><span>Apply</span><span>Verify</span></div>`,
    }),
  },
};

const only = process.argv.slice(2);
await withBrowser(
  async (context) => {
    for (const [name, card] of Object.entries(CARDS)) {
      if (only.length && !only.includes(name)) continue;
      await still(context, page({ body: card.html, css: CSS }), new URL(`${name}.png`, OUT).pathname);
      console.log(`media/${name}.png`);
    }
  },
  { scale: 2 },
);
