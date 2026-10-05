/**
 * A repository's agent prompt, made from the board's template (prompts/repository.md). `repos init` writes it
 * into the repository (src/init.js), and the board's tests check the wizard against it, so it lives
 * in the board's package (CLD-135). Pure.
 */

/** Where the `tasks` skill sits in a repository the board runs. */
export const SKILL = '.agents/skills/tasks/SKILL.md';
/** Where the `pipeline` skill sits: how an agent moves a repository's CI/CD to the deploy flow (BRK-92). */
export const PIPELINE_SKILL = '.agents/skills/pipeline/SKILL.md';

/** The repository's areas for its prompt and AGENTS.md: "product (`BWYP`), cloud (`BWYC`)". */
export const areaList = (repo) => repo.areas.map((a) => `${a.project} (\`${a.prefix}\`)`).join(', ');

/**
 * Its agent prompt, from tools/tasks/prompts/repository.md: the comment dropped, its name, slug, owner/name,
 * the skill's path, and its areas filled in, and each section's `<…>` replaced by `sections[heading]` (CLD-196).
 * A section with no answer keeps its placeholder, which the board flags until someone fills it in.
 */
export function routinePrompt(template, repo, sections = {}) {
  let text = String(template);
  for (const [heading, answer] of Object.entries(sections)) {
    const body = String(answer ?? '').trim();
    if (!body) continue;
    // Headings are plain words, so they go into the pattern as they are.
    const at = new RegExp(`(^## ${heading}\n\n)<[^\n]*>$`, 'mu');
    text = text.replace(at, (_, head) => `${head}${body}`);
  }
  return text
    .replace(/^<!--[\s\S]*?-->\n/u, '')
    .replaceAll('<name>', repo.name || repo.slug)
    .replaceAll('<slug>', repo.slug)
    .replaceAll('<owner/name>', repo.github)
    .replaceAll('<path of the skill>', SKILL)
    .replace(
      'Its rules are in `AGENTS.md`',
      `Its areas on the board, with their work-ID prefixes: ${areaList(repo)}. Its rules are in \`AGENTS.md\``,
    );
}
