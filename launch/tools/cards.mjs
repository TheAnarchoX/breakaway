// Builds the launch images: launch/media/*.png (2160 px, square). Each card is an entry below: a kicker,
// a display headline, and a body. Run: node cards.mjs [name ...]
import { logoOnDark, page, still, withBrowser } from './kit.mjs';

const OUT = new URL('../media/', import.meta.url);

const CSS = `
.copy{position:absolute;left:84px;right:84px;top:220px}
.copy .display{font-size:132px}
.copy .lede{margin-top:40px;max-width:880px}
.board{position:absolute;left:84px;right:84px;top:290px;display:grid;grid-template-columns:1fr 1fr;gap:96px 48px}
.board .display{font-size:176px;line-height:.9}
.board .label{margin-top:14px}
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
.cmd i{font-style:normal;color:var(--muted)}`;

const frame = ({ kicker, foot, footNote, body }) => `
<div class="stage">
  <div class="logo">${logoOnDark}</div>
  <div class="label kicker">${kicker}</div>
  ${body}
  <div class="foot"><b>${foot}</b><span>${footNote}</span></div>
</div>`;

const CARDS = {
  // The race board: the three approved facts, set big. Real numbers only.
  '01-race-board': {
    alt: 'Four big numbers on a dark ground: 160 pull requests, under 48 hours, 1 person, 0 editors opened. The 160 is red.',
    html: frame({
      kicker: 'The run',
      foot: 'breakaway',
      footNote: 'Leave the pack.',
      body: `<div class="board">
        <div><div class="display red">160</div><div class="label">pull requests</div></div>
        <div><div class="display">&lt;48</div><div class="label">hours</div></div>
        <div><div class="display">1</div><div class="label">person</div></div>
        <div><div class="display">0</div><div class="label">editors opened</div></div></div>`,
    }),
  },
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
    alt: 'A card headed "Run your own." with the command npx breakaway install init, and the line: free, and the source is public.',
    html: frame({
      kicker: 'Self-hosting',
      foot: 'breakaway',
      footNote: 'Free · the source is public',
      body: `<div class="copy"><div class="display">Run<br>your <span class="red">own.</span></div>
          <p class="lede">On your own Cloudflare account. The guide takes you from nothing to a board that starts agents and updates itself.</p></div>
        <div class="cmd" style="top:760px"><i>$</i> npx breakaway install init</div>`,
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
