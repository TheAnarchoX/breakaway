import LOGO from '../../../brand/logo/logo-on-dark.svg?raw';
import MARK from '../../../brand/logo/mark-on-dark.svg?raw';

/**
 * breakaway's logo and mark (brand/README.md, Logo), drawn from the brand's own files so they never drift.
 * The pack and the wordmark take the theme's text color and the rider takes --red (`.logo-pack`,
 * `.logo-rider` in app.css), so one file works on carbon and chalk. Decorative: the link or heading
 * around it carries the name.
 */
const themed = (svg) =>
  svg
    .replace(/<title>[^<]*<\/title>/u, '')
    .replace(' role="img"', ' aria-hidden="true" focusable="false"')
    .replace(/ width="[\d.]+" height="[\d.]+"/u, '')
    .replaceAll('fill="#f4f4f1"', 'class="logo-pack"')
    .replaceAll('fill="#e61e0b"', 'class="logo-rider"');

const SOURCES = { logo: themed(LOGO), mark: themed(MARK) };

/**
 * `kind` is "logo" (the mark and the wordmark) or "mark" (the gap alone).
 * @param {Record<string, any>} props
 */
export function Logo({ kind = 'logo', class: cls = '' }) {
  return (
    <span class={`logo logo-${kind} ${cls}`} aria-hidden="true" dangerouslySetInnerHTML={{ __html: SOURCES[kind] }} />
  );
}
