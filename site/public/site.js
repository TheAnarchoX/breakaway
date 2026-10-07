// The theme switch, copy buttons on code, the latest release in the hero, and the road ahead. Nothing here is needed to read the page,
// and nothing calls a service other than this site's own update feed.
const root = document.documentElement;
const systemLight = () => matchMedia('(prefers-color-scheme: light)').matches;
const current = () => root.dataset.theme ?? (systemLight() ? 'light' : 'dark');

const toggle = document.querySelector('[data-theme-toggle]');
function label() {
  if (!toggle) return;
  const next = current() === 'dark' ? 'chalk' : 'carbon';
  toggle.textContent = next === 'chalk' ? 'Chalk' : 'Carbon';
  toggle.setAttribute('aria-label', `Switch to the ${next} theme`);
}
toggle?.addEventListener('click', () => {
  const next = current() === 'dark' ? 'light' : 'dark';
  root.dataset.theme = next;
  try {
    localStorage.setItem('breakaway.theme', next);
  } catch {
    // Not saved; it lasts until the page closes.
  }
  label();
});
label();

for (const pre of document.querySelectorAll('pre')) {
  if (pre.parentElement?.classList.contains('code')) continue;
  const holder = document.createElement('div');
  holder.className = 'code';
  pre.replaceWith(holder);
  holder.append(pre);
}
for (const holder of document.querySelectorAll('.code')) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'copy';
  button.textContent = 'Copy';
  button.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(holder.querySelector('code')?.textContent ?? '');
      button.textContent = 'Copied';
    } catch {
      button.textContent = 'Press ctrl+c';
    }
    setTimeout(() => (button.textContent = 'Copy'), 1800);
  });
  holder.append(button);
}

// The latest release in the hero, and the road ahead moved along (LCH-39): a release at or below the latest stable is
// out, the one after it is next. Without the feed, both stay as the page was built.
const line = document.querySelector('[data-release]');
const road = document.querySelector('[data-road]');
const newer = (a, b) => {
  const [x, y] = [a, b].map((v) => v.split('.').map(Number));
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return false;
};

function showRelease(stable, main) {
  const text = stable ? `Latest release: ${stable.version}` : main ? `Latest pre-release: ${main.version}` : '';
  const notes = stable?.notes ?? main?.notes;
  if (!line || !text) return;
  line.textContent = '';
  const a = document.createElement('a');
  a.href = notes ?? '#';
  a.textContent = text;
  line.append(a);
}

function moveRoad(stable) {
  if (!road || !/^\d+\.\d+\.\d+$/u.test(stable?.version ?? '')) return;
  let next = true;
  for (const stop of road.querySelectorAll('[data-version]')) {
    const version = stop.dataset.version;
    const out = !newer(version, stable.version);
    const state = out ? 'out' : next ? 'next' : 'planned';
    if (!out) next = false;
    stop.dataset.state = state;
    stop.querySelector('[data-road-state]').textContent = { out: 'Out', next: 'Next', planned: 'Planned' }[state];
    stop.querySelector('.stop-out').hidden = !out;
    stop.querySelector('.stop-features').hidden = out;
    if (out && version === stable.version && stable.notes) stop.querySelector('.stop-out a').href = stable.notes;
  }
}

if (line || road) {
  fetch('/releases.json')
    .then((r) => (r.ok ? r.json() : null))
    .then((feed) => {
      showRelease(feed?.channels?.stable, feed?.channels?.main);
      moveRoad(feed?.channels?.stable);
    })
    .catch(() => {});
}
