// Builds the README's images (DOC-7, DOC-36): docs/media/<name>-dark.png and -light.png, in carbon and chalk, so GitHub shows
// the one that matches the reader's theme. Each is a wide scene drawn from the brand's own tokens, fonts, and logo,
// with made-up tasks. It also builds the social card (LCH-12), site/public/social.png: the hero at 1280 by 640, carbon only,
// which the site names as og:image and the owner uploads as the repository's social preview. Run: node readme.mjs [name ...]
import { readFileSync } from 'node:fs';
import { logoOnDark, logoOnLight, page, still, withBrowser } from './kit.mjs';

const OUT = new URL('../../docs/media/', import.meta.url);
const WIDTH = 1280;

const CSS = `
html,body{width:${WIDTH}px;height:auto;overflow:hidden}
.stage{position:relative;width:${WIDTH}px;height:auto;padding:56px 64px;overflow:hidden}
.logo{position:static;height:34px}
.logo svg{height:34px;width:auto;display:block}
.top{display:flex;justify-content:space-between;align-items:center}
.label{font-size:15px}
.wid{font:700 15px var(--font-mono);color:var(--muted);white-space:nowrap}
.wid.red{display:inline-block;padding:3px 8px;border-radius:var(--radius-xs);background:var(--red);color:var(--on-red)}
.state{font:700 12px var(--font-mono);letter-spacing:.08em;padding:2px 7px;border-radius:var(--radius-xs);border:1px solid var(--surface-3);color:var(--muted)}
.state.go{color:var(--text);border-color:var(--text)}

/* The hero: the tagline set big, next to a board with made-up tasks. */
.hero{display:grid;grid-template-columns:1.05fr 1fr;gap:56px;align-items:center;margin-top:44px}
.hero .display{font-size:96px}
.hero .lede{font-size:24px;margin-top:22px;max-width:520px;color:var(--muted)}
.hero .lede b{color:var(--text);font-weight:600}
.board{border:1px solid var(--surface-3);border-radius:var(--radius-l);background:var(--surface);padding:18px}
.board-head{display:flex;justify-content:space-between;margin-bottom:12px}
.task{display:grid;grid-template-columns:96px 1fr;gap:4px 14px;align-items:baseline;padding:14px;border-radius:var(--radius);background:var(--bg);border:1px solid var(--surface-3)}
.task + .task{margin-top:10px}
.task-title{font:600 17px var(--font-body);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.task-meta{grid-column:2;font:500 13px var(--font-mono);color:var(--muted);display:flex;gap:8px;align-items:center}

/* The social card: the hero at a fixed 2:1, its board centred in what's left below the logo. */
.stage.social{height:640px;display:flex;flex-direction:column}
.social .hero{margin:auto 0}

/* How it works: three steps in a row. */
.steps{display:grid;grid-template-columns:repeat(3,1fr);gap:18px;margin-top:34px}
.step{position:relative;padding:24px;border-radius:var(--radius-l);background:var(--surface);border:1px solid var(--surface-3);min-height:196px;display:flex;flex-direction:column}
.step .n{font:700 15px var(--font-mono);color:var(--muted)}
.step h2{font:italic var(--display-weight) 34px/1.02 var(--font-display);font-stretch:var(--display-stretch);letter-spacing:-.01em;margin-top:14px}
.step .proof{margin-top:auto;padding-top:18px;font:600 15px var(--font-mono);color:var(--muted)}
.step .proof .wid{font-size:15px}
.title{font:italic var(--display-weight) 44px/1 var(--font-display);font-stretch:var(--display-stretch);letter-spacing:-.02em;margin-top:34px}
.title .red{color:var(--red)}

/* How it's built: who comes in, what runs on your Cloudflare account, and what it talks to. */
.arch{display:grid;grid-template-columns:1fr 1.25fr 1fr;gap:22px;margin-top:34px;align-items:stretch}
.col{display:grid;gap:12px;align-content:start}
.col > .label{margin-bottom:2px}
.box{padding:16px 18px;border-radius:var(--radius);background:var(--surface);border:1px solid var(--surface-3)}
.box b{display:block;font:700 19px var(--font-body)}
.box span{display:block;margin-top:4px;font:500 14px/1.45 var(--font-mono);color:var(--muted)}
.cloud{padding:18px;border-radius:var(--radius-l);border:2px solid var(--text);display:grid;gap:12px;align-content:start}
.cloud .box.lead{border-color:var(--red)}
.cloud .box.lead b::before{content:'';display:inline-block;width:10px;height:10px;margin-right:10px;background:var(--red);border-radius:2px}
.link{font:600 13px var(--font-mono);color:var(--muted);text-align:center;letter-spacing:.06em}

/* Chase and the peloton (DOC-36): a chased feature beside its peloton. */
.pair{display:grid;grid-template-columns:1fr 1.1fr;gap:22px;margin-top:34px;align-items:start}
.pair .task{grid-template-columns:84px 1fr}
.posts{display:grid;gap:10px}
.post{padding:12px 14px;border-radius:var(--radius);background:var(--bg);border:1px solid var(--surface-3)}
.post .who{display:flex;gap:10px;align-items:baseline;font:600 13px var(--font-mono);color:var(--muted)}
.post .kind{font:700 12px var(--font-mono);letter-spacing:.08em;color:var(--text)}
.post p{margin-top:6px;font:500 16px/1.4 var(--font-body)}
.post.huddle{border-color:var(--text)}
.post.reply{margin-left:28px}
.aside{margin-top:14px;font:500 15px/1.5 var(--font-body);color:var(--muted)}

/* In Claude Code (DOC-36): the plugin and the MCP server. */
.cc{display:grid;grid-template-columns:1fr 1fr;gap:22px;margin-top:34px;align-items:stretch}
.panel{padding:22px;border-radius:var(--radius-l);background:var(--surface);border:1px solid var(--surface-3);display:flex;flex-direction:column;gap:14px}
.panel h2{font:700 24px var(--font-body);letter-spacing:-.015em}
.panel .sub{font:500 15px/1.5 var(--font-body);color:var(--muted)}
.term{padding:14px 16px;border-radius:var(--radius);background:var(--bg);border:1px solid var(--surface-3);font:500 15px/1.7 var(--font-mono);white-space:pre}
.term .dim{color:var(--muted)}
.chips{display:flex;flex-wrap:wrap;gap:8px}
.chips span{font:600 14px var(--font-mono);padding:5px 9px;border-radius:var(--radius-xs);border:1px solid var(--surface-3);color:var(--text)}

/* Architect's social card (LCH-32): the headline beside the plan page on a phone, a screenshot of the real view. */
.stage.social .arch-social{display:grid;grid-template-columns:1.5fr 1fr;gap:40px;align-items:center;margin:auto 0}
.arch-social .display{font-size:62px;white-space:nowrap}
.arch-social .lede{font-size:24px;margin-top:22px;color:var(--muted)}
.arch-social .lede b{color:var(--text);font-weight:600}
.phone{justify-self:center;width:300px;height:520px;overflow:hidden;border-radius:28px;border:2px solid var(--surface-3);background:var(--surface)}
.phone img{display:block;width:100%}
.approve{display:inline-block;padding:3px 10px;border-radius:var(--radius-xs);background:var(--red);color:var(--on-red);font:700 15px var(--font-mono)}
`;

const logo = (theme) => (theme === 'dark' ? logoOnDark : logoOnLight);
const top = (theme, kicker) =>
  `<div class="top"><div class="logo">${logo(theme)}</div><div class="label">${kicker}</div></div>`;

// The hero: the tagline set big, beside a board with made-up tasks.
const hero = (theme) => `
  ${top(theme, 'A task board for coding agents')}
  <div class="hero">
    <div>
      <h1 class="display">Leave the pack.</h1>
      <p class="lede">A task board for you and your coding agents. <b>They claim the work. You merge it.</b></p>
    </div>
    <div class="board">
      <div class="board-head"><span class="label">Board</span><span class="label">Now</span></div>
      <div class="task"><span class="wid red">BRK-12</span><span class="task-title">Sort the inbox by age</span><span class="task-meta"><span class="state go">CLAIMED</span>claude-brk-12, working</span></div>
      <div class="task"><span class="wid">WEB-7</span><span class="task-title">Add a dark theme to the activity chart</span><span class="task-meta"><span class="state">IN REVIEW</span>PR #31, checks passing</span></div>
      <div class="task"><span class="wid">BRK-13</span><span class="task-title">Check the inbox order after the deploy</span><span class="task-meta"><span class="state">BLOCKED</span>waits for BRK-12</span></div>
      <div class="task"><span class="wid">DOC-4</span><span class="task-title">Explain the update feed</span><span class="task-meta"><span class="state">READY</span>an agent can claim it</span></div>
    </div>
  </div>`;

/** A screenshot from screens.mjs, inlined, so a scene can show the real view. */
const shot = (name) => `data:image/png;base64,${readFileSync(new URL(`${name}.png`, OUT)).toString('base64')}`;

const SCENES = {
  hero: {
    alt: 'breakaway: Leave the pack. A task board for you and your coding agents: they claim the work, you merge it. Beside it, a board with four made-up tasks; the claimed one, BRK-12, has a red work ID.',
    html: (theme) => `<div class="stage">${hero(theme)}</div>`,
  },
  social: {
    alt: 'breakaway: Leave the pack. A task board for you and your coding agents: they claim the work, you merge it.',
    themes: ['dark'],
    out: new URL('../../site/public/social.png', import.meta.url),
    size: { width: WIDTH, height: 640 },
    html: (theme) => `<div class="stage social">${hero(theme)}</div>`,
  },
  architect: {
    alt: 'Agents propose it. You approve it. In three steps: 1, an agent changes staging in a pull request, #41, to staging.json. 2, the plan waits for you: 2 changes, 6.40 dollars more a month, estimated, and it can be undone. 3, you press Approve, and the board applies it and checks its health.',
    html: (theme) => `
<div class="stage">
  ${top(theme, 'Architect · new in 2.0')}
  <div class="title">Agents propose it. You approve it.</div>
  <div class="steps">
    <div class="step"><span class="n">1</span><h2>An agent changes staging.</h2><p class="proof">PR #41 · staging.json</p></div>
    <div class="step"><span class="n">2</span><h2>The plan waits for you.</h2><p class="proof">2 changes · +$6.40 a month, est. · can be undone</p></div>
    <div class="step"><span class="n">3</span><h2>You approve. The board applies it.</h2><p class="proof"><span class="approve">Approve</span> · then a health check</p></div>
  </div>
</div>`,
  },
  'social-architect': {
    alt: 'breakaway: Agents propose it. You approve it. The board runs the infrastructure too, and you still decide. Beside it, a plan for staging on a phone, waiting for you, with Approve.',
    themes: ['dark'],
    out: new URL('../../site/public/social-architect.png', import.meta.url),
    size: { width: WIDTH, height: 640 },
    html: (theme) => `
<div class="stage social">
  ${top(theme, 'Architect · new in 2.0')}
  <div class="arch-social">
    <div>
      <h1 class="display">Agents propose it.<br><span class="red">You approve it.</span></h1>
      <p class="lede">The board runs the infrastructure too, <b>and you still decide.</b></p>
    </div>
    <div class="phone"><img src="${shot('plan-dark')}" alt=""></div>
  </div>
</div>`,
  },
  how: {
    alt: 'Agents claim the work. You merge it. In three steps: 1, an agent, claude-brk-12, claims the task BRK-12. 2, it opens a pull request that says Closes BRK-12. 3, you merge, and the task is done.',
    html: (theme) => `
<div class="stage">
  ${top(theme, 'How it works')}
  <div class="title">Agents claim the work. <span class="red">You merge it.</span></div>
  <div class="steps">
    <div class="step"><span class="n">1</span><h2>An agent claims it.</h2><p class="proof"><span class="wid">BRK-12</span> · claude-brk-12</p></div>
    <div class="step"><span class="n">2</span><h2>It opens a pull request.</h2><p class="proof">Closes BRK-12.</p></div>
    <div class="step"><span class="n">3</span><h2>You merge. The task is done.</h2><p class="proof">BRK-12 · Done</p></div>
  </div>
</div>`,
  },
  built: {
    alt: 'How breakaway is built. Four ways in: the web board, the CLI, the MCP server, and Taskwarrior. They reach one Worker and its Durable Object on your own Cloudflare account, which holds every task. The board talks to GitHub through its own GitHub App, and starts Claude Code cloud agents through your routine; agents work the board through the CLI or MCP.',
    html: (theme) => `
<div class="stage">
  ${top(theme, 'How it’s built')}
  <div class="arch">
    <div class="col">
      <span class="label">Four ways in</span>
      <div class="box"><b>The web board</b><span>In your browser, installable, phone included</span></div>
      <div class="box"><b>The CLI</b><span>npx breakaway, for you and your agents</span></div>
      <div class="box"><b>The MCP server</b><span>/mcp, for Claude Code and other MCP clients</span></div>
      <div class="box"><b>Taskwarrior 3</b><span>Its own sync protocol, one set of data</span></div>
    </div>
    <div class="cloud">
      <span class="label">Your Cloudflare account</span>
      <div class="box lead"><b>One Worker</b><span>The API, MCP, the web app, and Taskwarrior sync</span></div>
      <div class="box"><b>One Durable Object</b><span>Every task, claim, comment, and change, in your account and nowhere else</span></div>
      <div class="link">NO ANALYTICS · NO TELEMETRY</div>
    </div>
    <div class="col">
      <span class="label">What it talks to</span>
      <div class="box"><b>GitHub</b><span>Its own GitHub App: pull requests, checks, reviews, deploys</span></div>
      <div class="box"><b>Claude Code</b><span>Your routine starts cloud agents on tasks</span></div>
      <div class="box"><b>Your agents</b><span>Claim, comment, and hand over through the CLI or MCP</span></div>
    </div>
  </div>
</div>`,
  },
  peloton: {
    alt: 'Chase a feature. The agents ride together. On the left, a chased feature, Inbox filters, aimed at 2.1.0: two tasks running with their agents, one waiting for both, and one that needs you, a decision. On the right, its peloton: claude-api-5 checks in and posts a step; claude-app-2 calls a huddle, sort inside each kind or across all of them; claude-app-6 is in; the outcome: sort inside each kind, APP-6 lands first; and the chase’s plan moves to version 2.',
    html: (theme) => `
<div class="stage">
  ${top(theme, 'Chase and the peloton')}
  <div class="title">Chase a feature. <span class="red">The agents ride together.</span></div>
  <div class="pair">
    <div>
      <div class="board">
        <div class="board-head"><span class="label">Inbox filters · 2.1.0</span><span class="label">Chasing</span></div>
        <div class="task"><span class="wid">API-5</span><span class="task-title">Return inbox items by kind</span><span class="task-meta"><span class="state go">RUNNING</span>claude-api-5</span></div>
        <div class="task"><span class="wid">APP-6</span><span class="task-title">Add a filter bar to the inbox</span><span class="task-meta"><span class="state go">RUNNING</span>claude-app-6</span></div>
        <div class="task"><span class="wid">DOC-3</span><span class="task-title">Explain inbox filters</span><span class="task-meta"><span class="state">WAITING</span>waits for API-5, APP-6</span></div>
        <div class="task"><span class="wid">APP-7</span><span class="task-title">Pick the inbox’s default filter</span><span class="task-meta"><span class="state">NEEDS YOU</span>a decision</span></div>
      </div>
      <p class="aside">The board starts an agent on every ready task, and on what blocks it, within your limits. It stops at decisions, owner steps, and merges.</p>
    </div>
    <div class="board">
      <div class="board-head"><span class="label">Peloton</span><span class="label">3 riding</span></div>
      <div class="posts">
        <div class="post"><div class="who"><span class="kind">CHECKED IN</span>claude-api-5 · API-5</div><p>Adding kind to GET /inbox: src/inbox.js and its tests.</p></div>
        <div class="post"><div class="who"><span class="kind">STEP</span>claude-api-5 · API-5</div><p>GET /inbox takes kind now. Does this affect anyone?</p></div>
        <div class="post huddle"><div class="who"><span class="kind">HUDDLE</span>claude-app-2 · APP-2</div><p>APP-6 and I both change the inbox list. Sort inside each kind, or across all of them?</p></div>
        <div class="post reply"><div class="who"><span class="kind">IN</span>claude-app-6 · APP-6</div><p>In. Paused after the chip styles.</p></div>
        <div class="post reply"><div class="who"><span class="kind">OUTCOME</span>claude-app-2 · APP-2</div><p>Sort inside each kind. APP-6 lands first; APP-2 rebases on it.</p></div>
        <div class="post"><div class="who"><span class="kind">PLAN</span>v2 · the chase’s plan</div><p>APP-2 waits for APP-6.</p></div>
      </div>
    </div>
  </div>
</div>`,
  },
  claude: {
    alt: 'In Claude Code. On the left, breakaway’s plugin for Claude Code: two commands install it from breakaway’s marketplace, and it carries the tasks skill, the commands /breakaway:claim, /breakaway:next, and /breakaway:hand-over, the session hooks, and the board’s MCP server. On the right, the MCP server at your board’s address followed by /mcp: tools to list, show, claim, and release tasks, comment, add and change tasks, ping you, review, and post on the peloton, with the same token and rules as the CLI.',
    html: (theme) => `
<div class="stage">
  ${top(theme, 'New in 1.5')}
  <div class="title">The board, <span class="red">in Claude Code.</span></div>
  <div class="cc">
    <div class="panel">
      <span class="label">The plugin</span>
      <h2>One install. Every session.</h2>
      <div class="term"><span class="dim">/plugin marketplace add</span> TheAnarchoX/breakaway
<span class="dim">/plugin install</span> breakaway@breakaway</div>
      <div class="chips"><span>tasks skill</span><span>/breakaway:claim</span><span>/breakaway:next</span><span>/breakaway:hand-over</span><span>session hooks</span><span>MCP server</span></div>
      <p class="sub">For you, or for every session in a repository, the board’s cloud agents included.</p>
    </div>
    <div class="panel">
      <span class="label">The MCP server</span>
      <h2>Every board answers on /mcp.</h2>
      <div class="term">npx breakaway mcp   <span class="dim"># prints the line to add it</span></div>
      <div class="chips"><span>next_task</span><span>claim_task</span><span>comment</span><span>add_task</span><span>modify_task</span><span>ping_owner</span><span>peloton_post</span><span>release_task</span></div>
      <p class="sub">Same token, same rules as the CLI. No tool merges, deploys, starts an agent, or marks a task done.</p>
    </div>
  </div>
</div>`,
  },
};

const only = process.argv.slice(2);
await withBrowser(
  async (context) => {
    for (const [name, scene] of Object.entries(SCENES)) {
      if (only.length && !only.includes(name)) continue;
      for (const theme of scene.themes ?? ['dark', 'light']) {
        const out = (scene.out ?? new URL(`${name}-${theme}.png`, OUT)).pathname;
        const html = page({ body: scene.html(theme), css: CSS, theme });
        await still(context, html, out, scene.size ?? { width: WIDTH, height: 1200 });
        console.log(
          `wrote ${out.slice(out.indexOf('/site/') >= 0 ? out.indexOf('/site/') + 1 : out.indexOf('/docs/') + 1)}`,
        );
      }
    }
  },
  { scale: 2 },
);

export const ALT = Object.fromEntries(Object.entries(SCENES).map(([name, s]) => [name, s.alt]));
