import { ExternalLink, History } from 'lucide-preact';
import { ago } from '../lib/model.js';
import { github, hashFor } from '../lib/store.js';
import { timelineItems } from '../lib/env-stream.js';

/**
 * The strip under the console's map (WEB-97): the environment's recent deploys and incidents on one line, newest first,
 * each linking to its run's log or its incident's task. Deploys come from the GitHub view's data, which the Deploys
 * panel loads; incidents from the console's own read.
 * @param {{ env: any, incidents: any[] }} props
 */
export function Timeline({ env, incidents }) {
  const data = github.value.data;
  const deploys = env.pipeline
    ? (data?.deploys ?? []).filter((/** @type {any} */ d) => (d.repo ?? data.slug) === env.repo && d.env === env.target)
    : [];
  const items = timelineItems({ deploys, incidents });
  return (
    <section class="console-timeline" aria-labelledby="infra-timeline">
      <h2 id="infra-timeline">
        <History size={14} aria-hidden="true" />
        Recent
      </h2>
      {items.length ? (
        <ol class="timeline-list">
          {items.map((i) => {
            const iso = new Date(i.at).toISOString();
            const body = (
              <>
                <span class="timeline-label">{i.label}</span>
                {i.detail && <span class="timeline-detail">{i.detail}</span>}
                <time class="meta" dateTime={iso} title={new Date(i.at).toLocaleString()}>
                  {ago(iso)}
                </time>
              </>
            );
            return (
              <li key={i.key} class={`timeline-item timeline-${i.tone}`}>
                <span class="timeline-dot" aria-hidden="true" />
                {i.href ? (
                  <a href={i.href} target="_blank" rel="noopener noreferrer">
                    {body}
                    <ExternalLink size={12} aria-hidden="true" />
                  </a>
                ) : i.task ? (
                  <a href={hashFor({ task: i.task.wid ?? i.task.uuid })}>{body}</a>
                ) : (
                  <span>{body}</span>
                )}
              </li>
            );
          })}
        </ol>
      ) : (
        <p class="console-quiet">No deploys or incidents yet.</p>
      )}
    </section>
  );
}
