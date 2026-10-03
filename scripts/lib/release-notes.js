/**
 * Release notes for what a deploy carries: the merged pull requests between two commits, grouped by the area
 * their work ID names ("BRK-12: …" is the board area). Areas are `{ prefix, name }`, from the board's registry
 * for the repository or from the caller; a pull request without a known prefix goes under "Other". Pure.
 */

/** A commit message's pull request number: "… (#31)" from a squash, or "Merge pull request #31". */
export function prNumberOf(message) {
  const first = String(message ?? '').split('\n')[0];
  const m = /Merge pull request #(\d+)/u.exec(first) ?? /\(#(\d+)\)\s*$/u.exec(first);
  return m ? Number(m[1]) : null;
}

/** "BRK-12: Sort it" → { id: 'BRK-12', prefix: 'BRK', text: 'Sort it' }; no work ID → id and prefix null. */
export function parseTitle(title) {
  const m = /^\s*([A-Z][A-Z0-9]{1,7})-(\d+)\s*[:–-]\s*(.+)$/u.exec(String(title ?? ''));
  return m
    ? { id: `${m[1]}-${m[2]}`, prefix: m[1], text: m[3].trim() }
    : { id: null, prefix: null, text: String(title ?? '').trim() };
}

/** "BRK:Board,WEB:Web" (the --areas option) → [{ prefix, name }]. */
export function parseAreas(text) {
  return String(text ?? '')
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const [prefix, ...name] = part.split(':');
      return { prefix: prefix.trim().toUpperCase(), name: name.join(':').trim() || prefix.trim().toUpperCase() };
    });
}

/**
 * Markdown notes: a heading with `title` and the version, a section per area (in `areas` order, then Other)
 * listing each pull request as "- <text> (<work ID>, #<number>)", then the migrations when there are any.
 * `prs`: `[{ number, title }]`. Returns the text, ending in a newline.
 */
export function releaseNotes({ title, version, prs = [], areas = [], migrations = [] }) {
  const known = new Map(areas.map((a) => [a.prefix, a.name]));
  const groups = new Map();
  for (const pr of [...prs].sort((a, b) => a.number - b.number)) {
    const t = parseTitle(pr.title);
    const heading = known.get(t.prefix) ?? 'Other';
    if (!groups.has(heading)) groups.set(heading, []);
    const ref = [t.id, `#${pr.number}`].filter(Boolean).join(', ');
    groups.get(heading).push(`- ${t.text} (${ref})`);
  }
  const order = [...areas.map((a) => a.name), 'Other'].filter((h, i, all) => groups.has(h) && all.indexOf(h) === i);
  const lines = [`## ${[title, version].filter(Boolean).join(' ')}`.trim(), ''];
  if (!prs.length) lines.push('No merged pull requests since the last release.', '');
  for (const heading of order) lines.push(`### ${heading}`, '', ...groups.get(heading), '');
  if (migrations.length) lines.push('### Migrations', '', ...migrations.map((m) => `- ${m}`), '');
  return `${lines.join('\n').replace(/\n+$/u, '')}\n`;
}
