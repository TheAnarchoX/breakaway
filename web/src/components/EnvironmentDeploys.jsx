import { useEffect } from 'preact/hooks';
import { ExternalLink, Rocket } from 'lucide-preact';
import { ago, shortVersion } from '../lib/model.js';
import { repoFacts } from '../lib/github-scope.js';
import { github, hashFor, loadGitHub, loadPipelineEnvironments, pipelineEnvironments, repoName } from '../lib/store.js';
import { chooseTab } from '../views/GitHubView.jsx';
import { Card, DeployRow, PromoteButton, RollbackButton, deployWord } from './Release.jsx';

/*
 * A pipeline environment's deploys on its page (WEB-88; docs/specs/IDEA-19-architect.md, "The first instance"): the
 * deploy flow and the environment as one place. What's live there and who put it there, its recent deploys with their
 * logs, and on production the release flow's own Promote and Roll back, the same buttons with the same checks. The
 * release flow's cards link here, and this links back.
 */

/** @param {{ iso: string | null }} props */
function When({ iso }) {
  if (!iso) return null;
  return (
    <time dateTime={iso} title={new Date(iso).toLocaleString()}>
      {ago(iso)}
    </time>
  );
}

/** Opens the GitHub view's release flow, the tab its Promote and Roll back are on. */
function ReleasesLink() {
  return (
    <a
      href={hashFor({ view: 'github', environment: null, task: null, pr: null })}
      onClick={() => chooseTab('releases')}
    >
      the GitHub view’s release flow
    </a>
  );
}

/**
 * Who put what's live there: a merge deploys staging, and Promote and Roll back are the owner's.
 * @param {any} live the environment's live deploy (BRK-195)
 * @param {string} role `staging` or `production`
 * @param {string} branch
 */
function liveBy(live, role, branch) {
  if (live.task === 'rollback') return 'Rolled back by you.';
  if (role === 'production') return 'Promoted by you.';
  return `Deployed by the Deploy workflow, on a merge to ${branch}.`;
}

/**
 * What's live from the environment alone, while the GitHub view hasn't loaded or isn't connected.
 * @param {{ deploys: any }} props
 */
function LiveFacts({ deploys }) {
  const { live, last } = deploys;
  const word = last && last !== live && last.sha !== live?.sha ? deployWord(last) : null;
  return (
    <dl class="flow-facts">
      {live && (
        <>
          <div>
            <dt>Commit</dt>
            <dd>
              <span class="gh-sha">{live.sha.slice(0, 7)}</span>
            </dd>
          </div>
          <div>
            <dt>Version</dt>
            <dd>
              <code>{shortVersion(live)}</code>
            </dd>
          </div>
          <div>
            <dt>Went live</dt>
            <dd>
              <When iso={live.at} />
            </dd>
          </div>
        </>
      )}
      {word && (
        <div>
          <dt>Last deploy</dt>
          <dd>
            {word.label}, {last.sha.slice(0, 7)}, <When iso={last.at} />
            {last.url && (
              <>
                {' · '}
                <a href={last.url} target="_blank" rel="noopener noreferrer">
                  Open the run
                  <ExternalLink size={13} aria-hidden="true" />
                </a>
              </>
            )}
          </dd>
        </div>
      )}
    </dl>
  );
}

/**
 * The Deploys section: a pipeline's environment's deploys, or, for a staging or production in a repository without a
 * pipeline, how to turn deploys on. Nothing for one that isn't the pipeline's in a repository that has one.
 * @param {{ env: any }} props
 */
export function DeploysSection({ env }) {
  // The release flow's cards and buttons come from the GitHub view's data.
  const role = env.pipeline;
  const offers = !role && env.kind !== 'short-lived' && !env.deploys;
  useEffect(() => {
    if ((role || offers) && !github.peek().loaded) loadGitHub();
    if (role === 'staging') loadPipelineEnvironments();
  }, [role, offers]);
  const data = github.value.data;
  const facts = repoFacts(data, env.repo);
  const view = facts?.slug === env.repo ? facts : null;
  if (!role) {
    // Only a staging or production that could be a pipeline's, in a repository known to have none, offers deploys.
    if (!offers || !github.value.loaded || view?.pipeline) return null;
    return (
      <section class="infra-section" aria-labelledby="infra-deploys">
        <h2 id="infra-deploys">
          <Rocket size={18} aria-hidden="true" />
          Deploys
        </h2>
        <p class="muted">
          Deploys aren’t on for {repoName(env.repo)}. Move it to breakaway’s deploy flow from the{' '}
          <a href={hashFor({ view: 'github', environment: null, task: null, pr: null })}>GitHub view</a>: then every
          merge deploys staging, Promote and Roll back move production, and both environments show their deploys here.
        </p>
      </section>
    );
  }
  const branch = view?.branch ?? 'the default branch';
  const card = view?.flow?.[role] ?? null;
  const live = env.deploys?.live ?? null;
  const recent = (data?.deploys ?? [])
    .filter((d) => (d.repo ?? data.slug) === env.repo && d.env === env.target)
    .slice(0, 8);
  const production = pipelineEnvironments.value[env.repo]?.production;
  const name = role === 'production' ? 'Production' : 'Staging';
  return (
    <section class="infra-section" aria-labelledby="infra-deploys">
      <h2 id="infra-deploys">
        <Rocket size={18} aria-hidden="true" />
        Deploys
      </h2>
      {card ? (
        <Card name={name} card={card} heading="h3">
          {live && <p class="meta">{liveBy(live, role, branch)}</p>}
          {role === 'production' && (
            <div class="env-deploy-actions">
              <PromoteButton view={view} idBase="env" />
              <RollbackButton view={view} idBase="env" />
            </div>
          )}
        </Card>
      ) : live || env.deploys?.last ? (
        <div class="flow-card">
          <LiveFacts deploys={env.deploys} />
          {live && <p class="meta">{liveBy(live, role, branch)}</p>}
        </div>
      ) : (
        <p class="muted">
          Nothing deployed here yet.{' '}
          {role === 'staging'
            ? `The next merge to ${branch} deploys here.`
            : 'Promote staging’s build once staging has one, and it goes live here.'}
        </p>
      )}
      <p class="meta">
        {role === 'staging' && production ? (
          <>
            Promote and Roll back are on{' '}
            <a href={hashFor({ view: 'infrastructure', environment: String(production), task: null })}>
              production’s page
            </a>{' '}
            and <ReleasesLink />.
          </>
        ) : (
          <>
            The same buttons are on <ReleasesLink />, with staging beside production.
          </>
        )}
      </p>
      {recent.length > 0 && (
        <>
          <h3 class="infra-deploys-recent">Recent deploys</h3>
          <ul class="gh-runs">
            {recent.map((d) => (
              <DeployRow key={d.id} d={d} showEnv={false} />
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
