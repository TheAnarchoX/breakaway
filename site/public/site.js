// The theme switch, copy buttons on code, and the latest release in the hero. Nothing here is needed to read the page,
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

const line = document.querySelector('[data-release]');
if (line) {
  fetch('/releases.json')
    .then((r) => (r.ok ? r.json() : null))
    .then((feed) => {
      const stable = feed?.channels?.stable;
      const main = feed?.channels?.main;
      const text = stable ? `Latest release: ${stable.version}` : main ? `Latest pre-release: ${main.version}` : '';
      const notes = stable?.notes ?? main?.notes;
      if (!text) return;
      line.textContent = '';
      const a = document.createElement('a');
      a.href = notes ?? '#';
      a.textContent = text;
      line.append(a);
    })
    .catch(() => {});
}
