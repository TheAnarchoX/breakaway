// Builds the README's images (DOC-7): docs/media/<name>-dark.png and -light.png, in carbon and chalk, so GitHub shows
// the one that matches the reader's theme. Each is a wide scene drawn from the brand's own tokens, fonts, and logo,
// with made-up tasks. Run: node readme.mjs [name ...]
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
`;

const logo = (theme) => (theme === 'dark' ? logoOnDark : logoOnLight);
const top = (theme, kicker) =>
  `<div class="top"><div class="logo">${logo(theme)}</div><div class="label">${kicker}</div></div>`;

const SCENES = {
  hero: {
    alt: 'breakaway: Leave the pack. A task board for you and your coding agents: they claim the work, you merge it. Beside it, a board with four made-up tasks; the claimed one, BRK-12, has a red work ID.',
    html: (theme) => `
<div class="stage">
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
    alt: 'How breakaway is built. Three ways in: the web board, the CLI, and Taskwarrior. They reach one Worker and its Durable Object on your own Cloudflare account, which holds every task. The board talks to GitHub through its own GitHub App, and starts Claude Code cloud agents through your routine; agents work the board through the CLI.',
    html: (theme) => `
<div class="stage">
  ${top(theme, 'How it’s built')}
  <div class="arch">
    <div class="col">
      <span class="label">Three ways in</span>
      <div class="box"><b>The web board</b><span>In your browser, installable, phone included</span></div>
      <div class="box"><b>The CLI</b><span>npx breakaway, for you and your agents</span></div>
      <div class="box"><b>Taskwarrior 3</b><span>Its own sync protocol, one set of data</span></div>
    </div>
    <div class="cloud">
      <span class="label">Your Cloudflare account</span>
      <div class="box lead"><b>One Worker</b><span>The API, the web app, and Taskwarrior sync</span></div>
      <div class="box"><b>One Durable Object</b><span>Every task, claim, comment, and change, in your account and nowhere else</span></div>
      <div class="link">NO ANALYTICS · NO TELEMETRY</div>
    </div>
    <div class="col">
      <span class="label">What it talks to</span>
      <div class="box"><b>GitHub</b><span>Its own GitHub App: pull requests, checks, reviews, deploys</span></div>
      <div class="box"><b>Claude Code</b><span>Your routine starts cloud agents on tasks</span></div>
      <div class="box"><b>Your agents</b><span>Claim, comment, and hand over through the CLI</span></div>
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
      for (const theme of ['dark', 'light']) {
        const out = new URL(`${name}-${theme}.png`, OUT).pathname;
        const html = page({ body: scene.html(theme), css: CSS, theme });
        await still(context, html, out, { width: WIDTH, height: 1200 });
        console.log(`wrote docs/media/${name}-${theme}.png`);
      }
    }
  },
  { scale: 2 },
);

export const ALT = Object.fromEntries(Object.entries(SCENES).map(([name, s]) => [name, s.alt]));
