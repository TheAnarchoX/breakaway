/**
 * breakaway's brand lint: the guide's mechanical rules (brand/README.md), as patterns over text. Pure over
 * `[{ path, text }]`, so it's tested without a disk. A line opts out of a rule with a comment naming it:
 * `brand-lint-ignore name` on the line itself, `brand-lint-ignore-next-line name` on the line before, or
 * `brand-lint-ignore-file name` anywhere in the file. A bare `brand-lint-ignore` covers every rule; several
 * rules are separated by commas.
 */

/** @typedef {{ id: string, message: string, pattern: RegExp, skip?: (line: string, match: RegExpExecArray) => boolean }} Rule */

const NEVER = [
  'revolutionary',
  'game-changing',
  'next-gen',
  'seamless(?:ly)?',
  'supercharg\\w*',
  'unleash\\w*',
  'unlock\\w*',
  'magic(?:al)?',
  'effortless(?:ly)?',
  'blazing[- ]fast',
  '10x',
  'ai-powered',
  'cutting-edge',
  'world-class',
];

/** @type {Rule[]} */
export const RULES = [
  {
    id: 'name',
    message:
      'The name is always lowercase: "breakaway", never "Breakaway", "BreakAway", "BREAKAWAY", "Break Away", or "break-away".',
    // Not part of a path or identifier, and not an environment variable (BREAKAWAY_TOKEN).
    pattern: /(?<![\w./-])(?:Breakaway|BreakAway|BREAKAWAY|Break[ -]Away|break-away)(?![\w-])/gu,
    skip: (line, m) => /^BREAKAWAY_[A-Z]/u.test(line.slice(m.index)),
  },
  {
    id: 'never-word',
    message:
      'A word that is never breakaway’s (it says "fast" or "new" without saying how): say what the board does instead.',
    pattern: new RegExp(`(?<![\\w-])(?:${NEVER.join('|')})(?![\\w])`, 'giu'),
  },
  {
    id: 'exclamation',
    message: 'No exclamation marks: loud comes from size and certainty, not volume.',
    // An exclamation mark that ends a word or sentence in prose; not `!==`, `!x`, `<!--`, `![alt]`, or a shebang.
    pattern: /[A-Za-z0-9’'")\]]!(?=\s|$|["'’”<)])/gu,
  },
  {
    id: 'open-source',
    message:
      'Say "free for personal and noncommercial use" or "the source is public": breakaway’s licence isn’t an open source one.',
    pattern: /\bopen[- ]source\b/giu,
    // Apache 2.0 releases, the Open Source Initiative, and the font licence's own words are about the term itself.
    skip: (line) =>
      /Apache|Open Source Initiative|\bOSI\b|Open Font|doesn’t count|doesn't count|until the Apache|open-source-/iu.test(
        line,
      ),
  },
];

const IGNORE = /brand-lint-(ignore(?:-next-line|-file)?)(?:[ \t]+([a-z][a-z, -]*[a-z]))?/u;

/** The rule ids a directive names, or null for every rule. */
const named = (list) => (list ? list.split(/[ ,]+/u).filter(Boolean) : null);
const covers = (ids, id) => ids === null || ids.includes(id);

/**
 * Returns the findings: `{ path, line, column, rule, message, text }`, in file and line order.
 * @param {{ path: string, text: string }[]} files
 * @param {{ rules?: Rule[] }} [options]
 */
export function lint(files, { rules = RULES } = {}) {
  const findings = [];
  for (const { path, text } of files) {
    const lines = String(text).split(/\r?\n/u);
    const whole = [];
    for (const line of lines) {
      const d = IGNORE.exec(line);
      if (d && d[1] === 'ignore-file') whole.push(named(d[2]));
    }
    const fileOff = (id) => whole.some((ids) => covers(ids, id));
    let next;
    lines.forEach((line, i) => {
      const here = IGNORE.exec(line);
      const sameLine = here && here[1] === 'ignore' ? named(here[2]) : undefined;
      const previous = next;
      next = here && here[1] === 'ignore-next-line' ? named(here[2]) : undefined;
      for (const rule of rules) {
        if (fileOff(rule.id)) continue;
        if (sameLine !== undefined && covers(sameLine, rule.id)) continue;
        if (previous !== undefined && previous !== null ? previous.includes(rule.id) : previous === null) continue;
        for (const m of line.matchAll(rule.pattern)) {
          if (rule.skip?.(line, m)) continue;
          findings.push({
            path,
            line: i + 1,
            column: m.index + 1,
            rule: rule.id,
            message: rule.message,
            text: line.trim().slice(0, 160),
          });
        }
      }
    });
  }
  return findings;
}

/** A finding as one line a run prints: `path:line:col rule: message`. */
export const format = (f) => `${f.path}:${f.line}:${f.column} ${f.rule}: ${f.message}\n    ${f.text}`;
