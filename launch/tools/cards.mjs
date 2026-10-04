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
.post.reply{margin-left:72px}`;

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
