// Seeds Architect on the launch board (board/worker.js). By default, after seed.sh's tasks, the README's world:
// acme/widgets's staging and production on a made-up Cloudflare account, a change that was approved and applied in
// staging, one waiting for the owner, an envelope on production, and an incident there. With `film`, the film's world
// (LCH-38) instead, on a fresh board: FILM_STEPS below, which footage.mjs runs one at a time. Every step goes through
// the board's own API and code: the owner's presses with the signed-in cookie, the apply as the runner does it, and the
// platform and GitHub moved along with /__launch (world.mjs). Nothing here is real. It needs BREAKAWAY_URL and
// BREAKAWAY_TOKEN. Run: node architect.mjs [film [<last step>]]
import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { filmPlatformOf } from './board/provider.js';
import { applyAsRunner, call, cli, desired, file, jwk, launch, owner, plansOf, REPO, sync } from './world.mjs';

/** The README's world (LCH-32): staging and production of widgets-api, as the screenshots show them. */
async function readmeWorld() {
  // The made-up account, connected read only, and what runs on it.
  await launch('github', { keys: [jwk] });
  const staging = await launch('platform', { environment: 'staging', fresh: { render: 2, consumers: 2 } });
  const production = await launch('platform', { environment: 'production', fresh: { render: 3, consumers: 4 } });
  await owner('infra/connections/cloudflare', 'PUT', { token: 'launch-read-token' });
  const envs = {};
  for (const [name, target] of [
    ['staging', 'widgets-api-staging'],
    ['production', 'widgets-api'],
  ]) {
    envs[name] = (
      await owner('infra/environments', 'POST', { repo: 'widgets', provider: 'cloudflare', name, kind: name, target })
    ).environment;
  }

  // The default branch describes what runs now.
  await launch('github', {
    files: {
      [file('staging')]: desired(staging.resources),
      [file('production')]: desired(production.resources),
      // The repository's policy: the default's limits, and room for production's bill.
      '.github/breakaway-infra/policy.json': `${JSON.stringify({ version: 1, costLimit: 5, budget: 20, environments: { production: { budget: 60 } } }, null, 2)}\n`,
    },
    sha: 'a1c3e5f',
    message: 'Describe staging and production as code',
  });
  await sync();
  await launch('platform', {
    environment: 'production',
    events: [
      { resource: null, kind: 'cost', level: 'info', value: 31.4, minutesAgo: 300, text: 'this month so far' },
      {
        resource: 'd1:widgets-db',
        kind: 'alert',
        level: 'warning',
        value: 81,
        minutesAgo: 140,
        text: 'widgets-db is 81% full',
      },
      {
        resource: 'queue:widgets-exports',
        kind: 'alert',
        level: 'info',
        value: 12,
        minutesAgo: 70,
        text: 'widgets-exports has 12 messages waiting',
      },
    ],
  });
  await launch('platform', {
    environment: 'staging',
    events: [{ resource: null, kind: 'cost', level: 'info', value: 12.1, minutesAgo: 280, text: 'this month so far' }],
  });
  await launch('refresh');

  // Yesterday's change, applied: an agent's pull request let staging's export queue run 3 at a time.
  const ids = {
    queue: 'queue:widgets-exports-staging',
    render: 'container:widgets-render-staging',
  };
  await launch('github', {
    pulls: [
      {
        number: 38,
        title: 'API-6: Run three exports at a time in staging',
        sha: 'b38',
        state: 'closed',
        merged: true,
        hoursAgo: 26,
      },
    ],
    files: { [file('staging')]: desired(staging.resources, { [ids.queue]: { maxConcurrency: 3 } }) },
    sha: 'merge-38',
    message: 'API-6: Run three exports at a time in staging (#38)',
  });
  await sync();
  await launch('drift');
  const first = (await plansOf(envs.staging)).find((p) => ['draft', 'waiting'].includes(p.state));
  if (first.state === 'draft') await owner(`infra/plans/${first.id}`, 'PATCH', { state: 'waiting' });
  await owner(`infra/plans/${first.id}/approve`, 'POST');
  await applyAsRunner(first.id, envs.staging);
  await launch('refresh');

  // The one waiting now: room for four render containers in staging, from an agent's merged pull request.
  const now = (await launch('platform', { environment: 'staging' })).resources;
  await launch('github', {
    pulls: [
      {
        number: 41,
        title: 'API-7: Give staging’s render containers room for four',
        sha: 'b41',
        state: 'closed',
        merged: true,
        hoursAgo: 1,
      },
    ],
    pullFiles: { 41: [{ filename: file('staging'), status: 'modified', additions: 2, deletions: 2 }] },
    files: {
      [file('staging')]: desired(now, { [ids.render]: { maxInstances: 4 }, [ids.queue]: { maxConcurrency: 4 } }),
    },
    sha: 'merge-41',
    message: 'API-7: Give staging’s render containers room for four (#41)',
  });
  await sync();
  await launch('drift');

  // Production's envelope: the owner's bounds, set once.
  await owner(`infra/envelopes/${envs.production.id}`, 'PUT', {
    envelope: {
      scale: [{ kind: 'container', resource: 'widgets-render', min: 2, max: 10 }],
      monthly: 60,
      restarts: { cap: 3, hours: 24 },
    },
  });

  // And an incident: production's render containers stop answering.
  await launch('platform', { environment: 'production', health: { 'container:widgets-render': 'down' } });
  await launch('signals', {
    signals: [
      {
        source: 'cloudflare',
        environment: 'production',
        environmentId: envs.production.id,
        resource: 'container:widgets-render',
        kind: 'health',
        level: 'critical',
        minutesAgo: 6,
        text: 'widgets-render is down: 3 of 3 instances failed their health check',
      },
    ],
  });
  await launch('refresh');
  const incidents = (await call(`/api/infra/incidents?environment=${envs.production.id}&open=true`)).incidents;
  console.log(
    `Seeded Architect: staging ${envs.staging.id}, production ${envs.production.id}; plans ${(await plansOf(envs.staging)).map((p) => `${p.id} ${p.state}`).join(', ')}; incident ${incidents.map((i) => i.task?.wid).join(', ')}.`,
  );
}

// ---- The film (LCH-38; launch/2.0.0.md, piece 6) ----------------------------------------------------------------
// acme/widgets's web app at three scales, the same setup at three points in time: S, a small app (widgets-web, two
// custom domains, two Durable Objects, a D1 database) on the deploy flow; M, staging and production with a queue, a
// container, an R2 bucket, and a KV namespace, staging's through a plan you approve; L, a chase on `exports`, a
// short-lived environment per task, an envelope scaling staging, and an incident in production. Each step moves the
// world on, and footage.mjs captures the board's views between them. Work IDs come out as the storyboard names them
// on a fresh launch board: the history is WGT-1 to WGT-11, the idea IDEA-7, and the incident WGT-41.

const W = { repo: 'widgets', area: 'wgt' };
const CLAIMS = ['WGT-15', 'WGT-16', 'WGT-17'];
/** Made-up tasks, through the CLI, as the owner (or `as` an agent), in acme/widgets. */
const task = (
  title,
  { tags = ['agent'], horizon = 'now', brief = title, done = `${title}.`, depends, priority } = {},
) =>
  /([A-Z]+-\d+)/u.exec(
    cli([
      'add',
      title,
      '--repo',
      W.repo,
      '--project',
      W.area,
      ...tags.flatMap((t) => ['--tag', t]),
      '--horizon',
      horizon,
      '--brief',
      brief,
      '--done-when',
      done,
      ...(depends ? ['--depends', depends] : []),
      ...(priority ? ['--priority', priority] : []),
    ]),
  )?.[1];
const finish = (id, agent = `claude-${id.toLowerCase()}`) => {
  cli(['claim', id], { as: agent });
  cli(['done', id], { as: agent });
};
/** Uses up work IDs, so the ones the film shows come out as named. Deleted tasks never show. */
function skipTo(number, make) {
  for (;;) {
    const id = make();
    cli(['modify', id, '--status', 'deleted']);
    if (Number(id.split('-')[1]) >= number - 1) return;
  }
}
const session = (id, agent, entries) => call(`/api/tasks/${id}/session`, { method: 'POST', body: { agent, entries } });
let shas = 0;
const sha = (tag) => `${tag}${(++shas).toString(16).padStart(4, '0')}`;
const film = {};
/** The film's environments, by name, from the board. */
async function envsByName() {
  const all = (await call('/api/infra/environments?repo=widgets')).environments;
  return Object.fromEntries(all.map((e) => [e.name, e]));
}
const deployment = (id, env, task, minutesAgo, description) => ({
  id,
  environment: env,
  sha: `d${id}`,
  task,
  ref: 'main',
  description,
  creator: { login: task === 'deploy' ? 'github-actions[bot]' : 'acme-owner' },
  created_at: new Date(Date.now() - minutesAgo * 60_000).toISOString(),
  updated_at: new Date(Date.now() - minutesAgo * 60_000).toISOString(),
  status: {
    state: 'success',
    description,
    created_at: new Date(Date.now() - (minutesAgo - 1) * 60_000).toISOString(),
  },
});

/** Each step of the film's world, in order: footage.mjs captures the board's views after the ones it names. */
export const FILM_STEPS = {
  // S: the small app, with its history: two releases shipped, the deploy flow, and what runs, healthy.
  async history() {
    cli(['repos', 'add', W.repo, REPO, '--area', 'wgt:WGT:Widgets', '--name', 'widgets']);
    await launch('github', { keys: [jwk] });
    for (const [slug, title, release, tasks] of [
      [
        'accounts',
        'Accounts',
        '1.0.0',
        [
          'Sign in with a magic link',
          'Keep each person’s widgets apart',
          'A room per widget, with its Durable Object',
          'Count views with a Durable Object',
          'Store widgets in D1',
        ],
      ],
      [
        'sharing',
        'Sharing',
        '1.1.0',
        [
          'Share a widget as a link',
          'Read-only links open without an account',
          'Revoke a shared link',
          'Show who opened a shared link',
          'Serve www.widgets.example too',
          'A page for links that were revoked',
        ],
      ],
    ]) {
      cli(['features', 'add', slug, '--title', title, '--release', release]);
      for (const t of tasks) finish(task(t, { tags: ['agent', slug] }));
      cli(['features', 'modify', slug, '--state', 'shipped']);
    }
    // IDEA-1 to IDEA-6 were other repositories' on this made-up board; only IDEA-7 is acme/widgets'.
    for (let i = 0; i < 6; i++)
      cli([
        'modify',
        /(IDEA-\d+)/u.exec(cli(['idea', `An earlier idea ${i + 1}`, '--repo', W.repo]))[1],
        '--status',
        'deleted',
      ]);

    // The deploy flow: every merge to main deploys to staging, and Promote moves production.
    const pipeline = `${process.env.TMPDIR ?? '/tmp'}/widgets-pipeline.json`;
    writeFileSync(pipeline, JSON.stringify({ workers: { staging: 'widgets-web-staging', production: 'widgets-web' } }));
    cli(['repos', 'modify', W.repo, '--pipeline', pipeline]);

    // What runs: the same small app twice, healthy, about $4 a month together.
    const staging = await launch('platform', { environment: 'staging', film: { scale: 's' } });
    const production = await launch('platform', { environment: 'production', film: { scale: 's' } });
    // Nothing yet where the short-lived environments will run: their plans make them.
    for (const id of CLAIMS) await launch('platform', { environment: id.toLowerCase(), film: { scale: 'empty' } });
    await owner('infra/connections/cloudflare', 'PUT', { token: 'launch-read-token' });
    await launch('github', {
      files: {
        [file('staging')]: desired(staging.resources),
        [file('production')]: desired(production.resources),
        '.github/breakaway-infra/policy.json': `${JSON.stringify({ version: 1, costLimit: 5, budget: 20, environments: { production: { budget: 60 } } }, null, 2)}\n`,
        '.github/breakaway-infra/short-lived.json': `${JSON.stringify(
          {
            version: 1,
            provider: 'cloudflare',
            target: 'widgets-web-{environment}',
            resources: [
              {
                id: 'worker:widgets-web-{environment}',
                kind: 'worker',
                name: 'widgets-web-{environment}',
                attrs: { compatibilityDate: '2026-09-01', usageModel: 'standard' },
              },
              { id: 'd1:widgets-db-{environment}', kind: 'd1', name: 'widgets-db-{environment}', attrs: {} },
            ],
          },
          null,
          2,
        )}\n`,
      },
      sha: sha('a'),
      message: 'Describe staging and production as code, and a short-lived environment per task',
    });
    await sync();
    await launch('refresh');
    film.envs = await envsByName();
  },

  // Shot 1: the idea, shaped by an agent into three tasks in now.
  async shape() {
    film.idea = /(IDEA-\d+)/u.exec(cli(['idea', 'Let people export their widgets', '--repo', W.repo]))[1];
    cli(['features', 'add', 'exports', '--title', 'Exports', '--release', '1.2.0', '--brief', 'Export your widgets.']);
    film.shaped = [
      task('Export a widget as JSON', { tags: ['agent', 'exports'], priority: 'H' }),
      task('Queue exports, one at a time per person', { tags: ['agent', 'exports'] }),
      task('Email a link when an export is ready', { tags: ['agent', 'exports'] }),
    ];
  },

  // Shot 2: an agent claims WGT-12, and its live output streams on the task.
  async claim() {
    cli(['claim', 'WGT-12'], { as: 'claude-wgt-12' });
    await session('WGT-12', 'claude-wgt-12', [
      { kind: 'start', text: 'Session started on WGT-12' },
      { kind: 'message', text: 'Reading the widget model and its tests first.' },
      { kind: 'tool', tool: 'Read', detail: 'src/widgets.js' },
      { kind: 'tool', tool: 'Read', detail: 'test/widgets.test.js' },
      {
        kind: 'message',
        text: 'An export is the widget and its room’s state, as one JSON file. Writing the test first.',
      },
      { kind: 'tool', tool: 'Edit', detail: 'test/export.test.js' },
      { kind: 'tool', tool: 'Bash', detail: 'npm test test/export.test.js' },
      { kind: 'tool', tool: 'Edit', detail: 'src/export.js' },
      { kind: 'tool', tool: 'Bash', detail: 'npm test' },
      { kind: 'message', text: 'All tests pass. Opening the pull request.' },
    ]);
  },

  // Shot 3: its pull request, #38, with its checks green.
  async pr() {
    const head = sha('b');
    await launch('github', {
      pulls: [{ number: 38, title: 'WGT-12: Export a widget as JSON', sha: head, hoursAgo: 0.3 }],
      pullFiles: {
        38: [
          { filename: 'src/export.js', status: 'added', additions: 64, deletions: 0 },
          { filename: 'test/export.test.js', status: 'added', additions: 48, deletions: 0 },
        ],
      },
      checks: {
        [head]: ['lint', 'test', 'typecheck'].map((name, i) => ({
          id: 700 + i,
          name,
          status: 'completed',
          conclusion: 'success',
          html_url: `https://github.com/${REPO}/runs/${700 + i}`,
          started_at: new Date(Date.now() - 300_000).toISOString(),
          completed_at: new Date(Date.now() - 120_000).toISOString(),
        })),
      },
    });
    cli(['modify', 'WGT-12', '--pr', '38']);
    await sync();
    film.head38 = head;
  },

  // Shot 3 and 4: you merge it, WGT-12 is done, the merge deploys to staging, and you promote it to production.
  async merge() {
    await launch('github', {
      pulls: [
        {
          number: 38,
          title: 'WGT-12: Export a widget as JSON',
          sha: film.head38,
          state: 'closed',
          merged: true,
          hoursAgo: 0.3,
        },
      ],
      sha: 'merge-38',
      message: 'WGT-12: Export a widget as JSON (#38)',
      files: {},
      deployments: [
        deployment(9002, 'widgets-web', 'deploy:promote', 1, 'Promoted merge-38 to production'),
        deployment(9001, 'widgets-web-staging', 'deploy', 4, 'Deployed merge-38 to staging'),
      ],
    });
    cli(['done', 'WGT-12'], { as: 'claude-wgt-12' });
    await sync();
    await launch('refresh');
  },

  // M, shot 5: production already runs a queue, a container, an R2 bucket, and a KV namespace, written down with
  // infra adopt; an agent's pull request, #41, adds them to staging, and its plan waits for you.
  async propose() {
    const production = await launch('platform', { environment: 'production', film: { scale: 'm', render: 3 } });
    const staging = (await launch('platform', { environment: 'staging' })).resources;
    const wanted = filmPlatformOf('staging', { scale: 'm', render: 2 }).resources;
    await launch('github', {
      files: { [file('production')]: desired(production.resources) },
      sha: sha('c'),
      message: 'Write down what production runs (infra adopt)',
    });
    await sync();
    await launch('refresh');
    await launch('github', {
      pulls: [
        {
          number: 41,
          title: 'WGT-13: Give staging the export queue, the render container, and their stores',
          sha: sha('p'),
          state: 'closed',
          merged: true,
          hoursAgo: 0.2,
        },
      ],
      pullFiles: { 41: [{ filename: file('staging'), status: 'modified', additions: 38, deletions: 2 }] },
      files: { [file('staging')]: desired([...staging, ...wanted.filter((r) => !staging.some((s) => s.id === r.id))]) },
      sha: 'merge-41',
      message: 'WGT-13: Give staging the export queue, the render container, and their stores (#41)',
    });
    await sync();
    await launch('drift');
    const plan = (await plansOf((await envsByName()).staging)).find((p) => ['draft', 'waiting'].includes(p.state));
    if (plan.state === 'draft') await owner(`infra/plans/${plan.id}`, 'PATCH', { state: 'waiting' });
    film.plan = plan.id;
  },

  // Shot 7: you approve it.
  async approve() {
    await owner(`infra/plans/${film.plan}/approve`, 'POST');
  },

  // Shot 8: the board applies it, through the runner, and its health check passes.
  async apply() {
    await applyAsRunner(film.plan, (await envsByName()).staging);
    await launch('refresh');
    await launch('drift');
  },

  // L, shot 9: the rest of the feature, chased by three agents.
  async chase() {
    cli(['done', 'WGT-13'], { as: 'claude-wgt-13' });
    const more = [
      ['Render a widget to PDF in a container', ['agent', 'exports', 'environment']],
      ['Keep exports in R2 for seven days', ['agent', 'exports', 'environment']],
      ['Cache export links in KV', ['agent', 'exports', 'environment']],
      ['Rate-limit exports per person', ['agent', 'exports']],
      ['An Exports page in settings', ['agent', 'exports']],
      ['Explain exports in the docs', ['agent', 'exports']],
    ];
    for (const [title, tags] of more) task(title, { tags });
    cli(['modify', 'WGT-18', '--depends', 'WGT-15']);
    cli(['modify', 'WGT-19', '--depends', 'WGT-17']);
    cli(['modify', 'WGT-20', '--depends', 'WGT-19']);
    cli(['chase', 'exports', '--parallel', '3']);
  },
  async claims() {
    cli(['claim', 'WGT-14'], { as: 'claude-wgt-14' });
    cli(['done', 'WGT-14'], { as: 'claude-wgt-14' });
    for (const id of CLAIMS) cli(['claim', id], { as: `claude-${id.toLowerCase()}` });
    cli(['peloton', 'checkin', 'The render container: src/render/ and its Durable Object.'], { as: 'claude-wgt-15' });
    cli(['peloton', 'checkin', 'Keeping exports in R2: src/export.js and the lifecycle rule.'], {
      as: 'claude-wgt-16',
    });
    cli(['peloton', 'checkin', 'Caching export links: src/links.js only.'], { as: 'claude-wgt-17' });
  },

  // Shot 10: a short-lived environment for each of the three, from the repository's template.
  async shortLived() {
    await launch('shortlived');
    for (const id of CLAIMS) {
      const name = id.toLowerCase();
      const env = (await envsByName())[name];
      for (const plan of (await plansOf(env)).filter((p) => ['draft', 'waiting'].includes(p.state))) {
        if (plan.state === 'draft') await owner(`infra/plans/${plan.id}`, 'PATCH', { state: 'waiting' });
        await owner(`infra/plans/${plan.id}/approve`, 'POST');
        await applyAsRunner(plan.id, env);
      }
    }
    await launch('refresh');
    await launch('shortlived');
  },
  // Shot 10: one task closes, and its environment's removal waits for you.
  async closeOne() {
    cli(['done', 'WGT-17'], { as: 'claude-wgt-17' });
    cli(['claim', 'WGT-19'], { as: 'claude-wgt-19' });
    await launch('shortlived');
  },

  // Shot 11: bounds you set once on staging, and the board scaling inside them.
  async envelope() {
    const env = (await envsByName()).staging;
    await owner(`infra/envelopes/${env.id}`, 'PUT', {
      envelope: {
        scale: [{ kind: 'container', resource: 'widgets-render-staging', min: 2, max: 6 }],
        monthly: 40,
        restarts: { cap: 3, hours: 24 },
      },
    });
    await launch('github', {
      files: {
        '.github/breakaway-infra/scaling.json': `${JSON.stringify(
          {
            version: 1,
            rules: [
              {
                name: 'render is busy',
                environments: ['staging'],
                resource: 'widgets-render-staging',
                kinds: ['alert'],
                level: 'warning',
                above: 80,
                act: 'scale',
                to: 4,
              },
            ],
          },
          null,
          2,
        )}\n`,
      },
      sha: sha('f'),
      message: 'Scale the render container when it’s busy',
    });
    await sync();
    await launch('signals', {
      signals: [
        {
          source: 'cloudflare',
          environment: 'staging',
          environmentId: env.id,
          resource: 'container:widgets-render-staging',
          kind: 'alert',
          level: 'warning',
          value: 91,
          minutesAgo: 1,
          text: 'widgets-render-staging is at 91% of its instances',
        },
      ],
    });
    await launch('tick');
    const scaled = (await plansOf(env)).find((p) => ['approved', 'applying'].includes(p.state));
    if (scaled) await applyAsRunner(scaled.id, env);
    await launch('refresh');
  },

  // Shot 12: production's render container goes down, the incident is WGT-41, and its runbook's agent is on it.
  async incident() {
    skipTo(41, () => task('A task from another week', { horizon: 'later' }));
    const env = (await envsByName()).production;
    await launch('platform', { environment: 'production', health: { 'container:widgets-render': 'down' } });
    await launch('signals', {
      signals: [
        {
          source: 'cloudflare',
          environment: 'production',
          environmentId: env.id,
          resource: 'container:widgets-render',
          kind: 'health',
          level: 'critical',
          minutesAgo: 4,
          text: 'widgets-render is down: 3 of 3 instances failed their health check',
        },
      ],
    });
    await launch('refresh');
    const incident = (await call(`/api/infra/incidents?environment=${env.id}&open=true`)).incidents[0];
    film.incident = incident?.task?.wid;
    cli(['claim', film.incident], { as: 'claude-wgt-41' });
    cli(
      [
        'comment',
        film.incident,
        'Diagnosed: widgets-render’s new image fails its health check on start (the PDF fonts moved). Fix: pin the image back and give it one more instance while it recycles, in pull request #57.',
      ],
      { as: 'claude-wgt-41' },
    );
    // Its pull request, #57, merged: the fix in production's file. The agent makes the plan from it.
    await launch('github', {
      files: {
        [file('production')]: desired((await launch('platform', { environment: 'production' })).resources, {
          'container:widgets-render': { maxInstances: 4 },
        }),
      },
      sha: 'merge-57',
      message: `${film.incident}: Pin widgets-render’s image back and give it room for four (#57)`,
    });
    await sync();
    // The runbook's agent proposes the fix as the incident's plan, so its steps move on; it waits for you.
    const plan = (
      await call('/api/infra/plans', {
        method: 'POST',
        body: { environment: env.id, source: 'incident', ref: film.incident, by: 'claude-wgt-41' },
      })
    ).plan;
    await owner(`infra/plans/${plan.id}`, 'PATCH', { state: 'waiting' });
    await launch('drift');
  },

  // Shot 13: the incident's follow-up lands in now.
  async followUp() {
    task('Check the render image’s fonts before it ships', {
      tags: ['agent', 'exports'],
      priority: 'H',
      brief: 'The incident’s follow-up: a check that fails when the PDF fonts are missing from the image.',
    });
  },
};

/** Runs the film's steps in order, up to and including `upto` (all of them when left out). */
export async function filmWorld(upto) {
  for (const [name, step] of Object.entries(FILM_STEPS)) {
    await step();
    console.log(`film: ${name}`);
    if (name === upto) return;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv[2] === 'film') await filmWorld(process.argv[3]);
  else await readmeWorld();
}
