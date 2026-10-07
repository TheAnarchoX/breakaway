import { hashFor } from '../lib/store.js';

/**
 * An audit entry's summary (WEB-96): its words, with a plan it names linking to that plan's page.
 * @param {{ parts: (string | { plan: string })[], environment: string | number, class?: string }} props
 */
export function AuditSummary({ parts, environment, class: cls }) {
  if (!parts.length) return null;
  return (
    <p class={cls}>
      {parts.map((p, i) =>
        typeof p === 'string' ? (
          p
        ) : (
          <a
            key={i}
            href={hashFor({ view: 'infrastructure', environment: String(environment), plan: p.plan, task: null })}
          >
            {p.plan}
          </a>
        ),
      )}
    </p>
  );
}
