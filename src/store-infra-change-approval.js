/**
 * TaskStore's approvals of changes from the console (docs/specs/BRK-258-plan-from-the-board.md, "One press to
 * approve"; BRK-260). The owner approves the plan of a change whose pull request the board opened (BRK-259,
 * store-infra-changes.js): POST /api/infra/changes/<n>/approve with `{ sha, digest }`, the head and the plan they saw,
 * cookie-only in worker.js with the `by` check second. Before anything merges, the board checks the pull request is
 * still the board's at that head, the environment isn't observe only or frozen, and the plan at that head is still the
 * one approved and isn't refused by the policy. Then it keeps the approval and merges the pull request as the owner's
 * action, the way Merge and Merge when green do (store-github.js's githubWrite): with the head commit, so a push in
 * between refuses; squash where the repository allows it. Not ready yet → GitHub's auto-merge, or the first sync after
 * its checks pass where the repository doesn't allow auto-merge; behind → the board updates its own branch first.
 *
 * Merging applies nothing. After the merge, drift's comparison makes the plan from the merged file (store-infra-drift.js),
 * keeping the deletes the change asked for, and hands it here: when its digest is the approved one and its policy names
 * no rule the approved plan didn't, the board approves it on the recorded press and the executor applies it with its
 * usual checks; otherwise it waits for the owner with the usual push. An approval waits at most 24 hours for its merge.
 * Every write appends a `change` entry to the audit trail with the environment.
 */
import { AgentError } from './store-agents.js';
import { GitHubError, fromBase64 } from './github.js';
import { DESIRED_MAX_BYTES, checkDesiredFile, desiredPath } from './infra-desired.js';
import { driftDue } from './infra-drift.js';
import { LIVE_STATES, changeTarget } from './infra-changes.js';
import { creatableKinds, targetKinds } from './infra-provider.js';
import { planDigest } from './infra-runner.js';
import { redact } from './redact.js';
import {
  appliedRules,
  approvalLapsed,
  approvalWords,
  keptForMerge,
  mergeRoute,
  newRules,
} from './infra-change-approval.js';

/** @typedef {import('./infra-change-approval.js').ChangeApproval} ChangeApproval */

/** Where docs/tasks.md says what to do when GitHub refuses the board's merge (a required review, a ruleset). */
export const REFUSED_DOCS = 'docs/tasks.md#approving-a-change-from-the-console';

/** Whether `by` is the owner's: none, or `owner`. Anything else is an agent's name, and is refused. */
const owners = (by) => by === undefined || by === null || by === '' || by === 'owner';
const refPath = (b) => b.split('/').map(encodeURIComponent).join('/');
const DISABLE_AUTO_MERGE =
  'mutation($id: ID!) { disablePullRequestAutoMerge(input: { pullRequestId: $id }) { clientMutationId } }';
const ENABLE_AUTO_MERGE =
  'mutation($id: ID!, $method: PullRequestMergeMethod!, $sha: GitObjectID!) { enablePullRequestAutoMerge(input: { pullRequestId: $id, mergeMethod: $method, expectedHeadOid: $sha }) { clientMutationId } }';

/** A read GitHub answers 404 (not there) to is nothing found. */
async function orNull(promise) {
  try {
    return await promise;
  } catch (error) {
    if (error instanceof GitHubError && error.status === 404) return null;
    throw error;
  }
}

/** A refusal with a status, kept as the API answers it. */
const refuse = (status, error, extra = {}) => ({ status, body: { error, ...extra } });

/** @type {Record<string, (this: any, ...args: any[]) => any>} */
export const infraChangeApprovalMethods = {
  /** A change's approval, or null. */
  changeApproval(row) {
    return /** @type {ChangeApproval | null} */ (row.approval ? JSON.parse(row.approval) : null);
  },

  /** Keeps a change's approval as it is now. */
  setChangeApproval(n, approval) {
    this.sql.exec(
      'UPDATE infra_changes SET approval = ?, updated = ? WHERE n = ?',
      approval ? JSON.stringify(approval) : null,
      Date.now(),
      Number(n),
    );
  },

  /**
   * Says why an approved change's pull request can't merge now: the change stays approved, and the audit trail gets
   * one entry each time the reason changes. A null `why` clears it (it's merging again).
   */
  noteChangeMerge(row, why) {
    const now = this.changeRow(row.n);
    if ((now.why ?? null) === (why ?? null)) return;
    this.sql.exec('UPDATE infra_changes SET why = ?, updated = ? WHERE n = ?', why, Date.now(), now.n);
    this.appendInfraAudit({
      kind: 'change',
      repo: now.repo,
      environment: now.name,
      environmentId: Number(now.environment),
      by: 'board',
      outcome: why ? 'couldn’t merge' : 'merging',
      summary: why ?? `#${now.pull} can merge again; the board merges it as approved`,
    });
  },

  /**
   * The environment a plan is made for (BRK-298): the one computation the pull request's check, the console's preview,
   * Approve, and `infra check` share, so they always plan the same thing. One with a target is planned as it is. One
   * with none (built from nothing, BRK-291) is planned with `target`, its change's, else the one Worker `desired` makes;
   * `target` in the answer names it then. With none, or several and no change to say which, it answers the `problem`.
   * A provider with no target kind plans as it is.
   * @param {Record<string, any>} env
   * @param {import('./infra-provider.js').DesiredState} desired
   * @param {string | null} [target] the change's target, for an environment that has none
   * @returns {{ env: Record<string, any>, target: string | null, label?: string, problem?: string }}
   */
  infraPlanTarget(env, desired, target = null) {
    if (env.target) return { env, target: null };
    if (target) return { env: { ...env, target }, target };
    const provider = this.infraProviderFor(env.provider);
    const kinds = provider ? targetKinds(provider) : [];
    const label = String((provider ? creatableKinds(provider)[kinds[0]]?.label : null) ?? kinds[0] ?? 'target');
    const one = changeTarget({ target: null, file: desired, kinds, environment: env.name, label });
    if (one.name) return { env: { ...env, target: one.name }, target: one.name, label };
    if (!kinds.length) return { env, target: null };
    return {
      env,
      target: null,
      problem: one.choices.length
        ? `${env.name} has no target, and its desired state makes ${one.choices.length} ${label}s (${one.choices.join(', ')}): set which one is its target on the board, then it plans`
        : `${env.name} has no target yet: add a ${label} for it to run to its desired state, or set its target on the board`,
    };
  },

  /**
   * The plan a desired state's text makes, with its digest: the one computation a change's preview at propose time and
   * at its pull request's head share (BRK-286), so the plan proposed and the plan approved only differ when the head or
   * what runs moved. The policy is the default branch's. Answers `{ error }` when the text doesn't check. An
   * environment with no target is planned with the one the change gives it (BRK-291), through infraPlanTarget.
   * @param {Record<string, any>} env
   * @param {string} text the file's text, exactly as committed
   * @param {string | null} [target] the change's target, for an environment that has none
   */
  async changePreviewOf(env, text, target = null) {
    const checked = checkDesiredFile(text, {
      provider: this.infraProviderFor(env.provider),
      expectProvider: env.provider,
    });
    if ('error' in checked) return { error: checked.error };
    const at = this.infraPlanTarget(env, checked.desired, target);
    if (at.problem) return { error: { line: null, field: 'target', message: at.problem } };
    const planned = await this.previewInfraPlan(at.env, checked.desired, this.infraPolicyFor(env.repo));
    return { desired: checked.desired, preview: { ...planned, digest: await planDigest(planned.diff) } };
  },

  /**
   * The plan the change's file makes at `sha` (its pull request's head), with its digest: changePreviewOf over the
   * file's text there. Answers a refusal when the file is gone or doesn't check.
   */
  async changePreviewAt(env, row, client, sha) {
    const path = desiredPath(env.name);
    const got = await orNull(client.get(`/contents/${refPath(path)}?ref=${encodeURIComponent(sha)}`));
    if (!got || Array.isArray(got) || got.type !== 'file')
      return { refused: refuse(409, `#${row.pull} has no ${path} at its head: propose again`) };
    if (Number(got.size ?? 0) > DESIRED_MAX_BYTES)
      return { refused: refuse(409, `${path} is over ${DESIRED_MAX_BYTES / 1024} KB at #${row.pull}’s head`) };
    const at = await this.changePreviewOf(env, fromBase64(got.content), row.target ?? null);
    if (at.error)
      return {
        refused: refuse(409, `${path} doesn’t check at #${row.pull}’s head: ${at.error.message}. Propose again.`),
      };
    return { preview: at.preview };
  },

  /**
   * POST /api/infra/changes/<n>/approve: the owner's, from the signed-in board. `{ sha, digest }` are the pull
   * request's head and the plan's digest the owner saw. Answers `{ change, preview }`; the change is `merged` when the
   * pull request merged at once, else `approved` (merging, or `why` it can't).
   */
  infraChangeApproveApi(ref, body = {}) {
    return this.run(async () => {
      if (!owners(body.by)) throw new AgentError('only the owner approves a change, from the board', 403);
      const row = this.changeRow(ref);
      if (!LIVE_STATES.includes(row.state))
        throw new AgentError(`change ${row.n} is ${row.state}, so there’s nothing to approve`, 409);
      if (!/^[0-9a-f]{7,64}$/iu.test(String(body.sha ?? '')))
        return refuse(400, 'send the head commit you saw as "sha"');
      if (!/^[0-9a-f]{64}$/u.test(String(body.digest ?? '')))
        return refuse(400, 'send the digest of the plan you saw as "digest"');
      const env = this.changeEnvironment(String(row.environment));
      if (env.frozen) throw new AgentError(approvalWords.frozen(env.name), 409);
      this.infraApproving ??= new Set();
      if (this.infraApproving.has(Number(row.n)))
        throw new AgentError(`The board is already approving change ${row.n}: wait a moment`, 409);
      this.infraApproving.add(Number(row.n));
      try {
        const github = await this.changeGitHub(env);
        if (!github)
          throw new AgentError('Connect GitHub on Connections first: approving merges its pull request', 409);
        return await this.approveInfraChange(row, env, github, { sha: String(body.sha), digest: body.digest });
      } finally {
        this.infraApproving.delete(Number(row.n));
      }
    });
  },

  async approveInfraChange(row, env, { client, repo }, { sha, digest }) {
    let approved = false;
    try {
      // 1. The pull request: still open, still the board's, at the head the owner saw.
      const pull = await orNull(client.get(`/pulls/${row.pull}`));
      if (!pull) {
        this.moveInfraChange(row, 'closed', {
          by: 'board',
          outcome: 'closed',
          why: 'its pull request is gone from GitHub',
          summary: `#${row.pull} is gone from GitHub; nothing changes`,
        });
        return refuse(409, `#${row.pull} is gone from GitHub, so there’s nothing to approve`);
      }
      if (this.followInfraChange(row, pull))
        return refuse(409, `#${row.pull} is ${this.changeRow(row.n).state} now, so there’s nothing to approve`, {
          change: this.changeOut(this.changeRow(row.n)),
        });
      if (pull.head?.sha !== sha || sha !== row.commit_sha)
        return refuse(409, approvalWords.moved(row.pull), { headSha: pull.head?.sha ?? null });

      // 2. The plan at that head is still the one the owner saw and the change kept, and the policy doesn't refuse it.
      const at = await this.changePreviewAt(env, row, client, sha);
      if (at.refused) return at.refused;
      const { preview } = at;
      // Nothing to apply at the head (a file for what runs, or edits that leave it as it runs): it merges instead.
      if (!preview.changes) {
        this.keepChangePlan(row.n, preview);
        return refuse(409, approvalWords.nothing(env.name, row.pull), {
          nothing: true,
          preview,
          change: this.changeOut(this.changeRow(row.n)),
        });
      }
      if (preview.digest !== digest || preview.digest !== row.digest)
        return refuse(409, approvalWords.changed, {
          changed: true,
          preview,
          change: this.changeOut(this.changeRow(row.n)),
        });
      if (preview.policy?.outcome === 'refused') {
        const why = preview.policy.rules?.find((r) => r.applies && r.effect === 'refuse')?.reason;
        return refuse(409, `Your policy refuses it${why ? `: ${why}` : ''}`, { preview });
      }

      // 3. Keep the approval, then merge as the owner's action.
      const edits = JSON.parse(row.edits);
      /** @type {ChangeApproval} */
      const approval = {
        by: 'owner',
        at: new Date().toISOString(),
        sha,
        digest: preview.digest,
        kept: await planDigest(keptForMerge(preview.diff, edits)),
        rules: appliedRules(preview.policy),
        merge: null,
        plan: null,
        settled: null,
      };
      this.sql.exec(
        "UPDATE infra_changes SET approval = ?, state = 'approved', why = NULL, updated = ? WHERE n = ?",
        JSON.stringify(approval),
        Date.now(),
        row.n,
      );
      approved = true;
      this.appendInfraAudit({
        kind: 'change',
        repo: row.repo,
        environment: row.name,
        environmentId: Number(row.environment),
        by: 'owner',
        outcome: 'approved',
        summary: `approved by the owner at ${sha.slice(0, 7)}; digest ${preview.digest.slice(0, 12)}. The board merges #${row.pull}`,
      });
      // A new environment takes the target its change adds now, so the plan from the merge is made for it (BRK-291).
      this.giveChangeTarget(row, 'owner');
      await this.mergeInfraChange(this.changeRow(row.n), env, { client, repo }, pull);
      return { status: 200, body: { change: this.changeOut(this.changeRow(row.n)), preview } };
    } catch (error) {
      if (!(error instanceof GitHubError)) throw error;
      if (!approved)
        return refuse(
          502,
          `GitHub didn’t answer for #${row.pull}: ${redact(error.reason ?? error.message)}. Nothing merged; approve again in a moment.`,
          { github: error.status },
        );
      this.noteChangeMerge(row, this.mergeRefusal(row, error));
      return { status: 200, body: { change: this.changeOut(this.changeRow(row.n)) } };
    }
  },

  /** Why GitHub refused to merge, in the card's words. */
  mergeRefusal(row, error) {
    if (error.status === 403 && /not accessible by integration/iu.test(error.reason ?? ''))
      return approvalWords.permission(row.pull);
    if (error.status === 409) return approvalWords.moved(row.pull);
    return `${approvalWords.refused(row.pull, redact(error.reason ?? error.message))} (${REFUSED_DOCS})`;
  },

  /** How the repository lets the board merge: squash where it can, else a merge commit, else a rebase. */
  async changeMergeSettings(client) {
    const info = await orNull(client.get(''));
    const method =
      info?.allow_squash_merge === false ? (info?.allow_merge_commit === false ? 'rebase' : 'merge') : 'squash';
    return { method, autoMerge: info ? info.allow_auto_merge !== false : true };
  },

  /**
   * Moves an approved change's pull request on, from GitHub's `pull`: merges it now, updates the board's branch when
   * it's behind, turns on auto-merge (or leaves it to the next green sync) while its checks run, or says why it can't.
   */
  async mergeInfraChange(row, env, { client, repo }, pull) {
    const approval = /** @type {ChangeApproval} */ (this.changeApproval(row));
    const known = this.sql
      .exec('SELECT data FROM gh_pulls WHERE repo = ? AND number = ?', row.repo, Number(row.pull))
      .toArray()[0];
    const data = known ? JSON.parse(known.data) : null;
    const route = mergeRoute({
      mergeable: pull.mergeable ?? null,
      mergeableState: pull.mergeable_state ?? null,
      checks: data?.headSha === pull.head.sha ? (data.checks?.state ?? null) : null,
    });
    if (route === 'conflicts') return this.noteChangeMerge(row, approvalWords.conflicts(row.pull));
    if (route === 'failing') return this.noteChangeMerge(row, approvalWords.failing(row.pull));
    const settings = await this.changeMergeSettings(client);
    if (route === 'now') return this.mergeChangeNow(row, { client, repo }, pull.head.sha, settings.method);
    let head = pull.head.sha;
    const nodeId = pull.node_id;
    if (route === 'behind') {
      head = await this.updateChangeBranch(row, env, { client, repo });
      if (!head) return;
    }
    let mode = /** @type {import('./infra-change-approval.js').MergeMode} */ ('sync');
    if (settings.autoMerge && nodeId)
      try {
        await client.graphql(ENABLE_AUTO_MERGE, {
          id: nodeId,
          method: settings.method.toUpperCase(),
          sha: head,
        });
        mode = 'auto';
      } catch (error) {
        // Auto-merge off for the repository, or GitHub says it's ready after all: the next sync merges it.
        if (!(error instanceof GitHubError)) throw error;
      }
    this.setChangeApproval(row.n, { ...approval, merge: mode });
    this.noteChangeMerge(row, null);
    // The sync reads its checks again and, without auto-merge, merges it once they pass.
    await this.githubWebhook('pull_request', null, { slug: row.repo });
  },

  /** Merges the change's pull request at `sha`, as the owner's action, and asks for a sync to compare what merged. */
  async mergeChangeNow(row, { client, repo }, sha, method) {
    const approval = /** @type {ChangeApproval} */ (this.changeApproval(row));
    const merged = await client.send('PUT', `/pulls/${row.pull}/merge`, { sha, merge_method: method });
    this.setChangeApproval(row.n, { ...approval, merge: approval.merge ?? 'now' });
    this.moveInfraChange(this.changeRow(row.n), 'merged', {
      by: 'owner',
      outcome: 'merged',
      summary: `#${row.pull} merged on the owner’s approval (${method}); the board plans from the merge`,
    });
    this.keepChangeMerge(row.n, typeof merged?.sha === 'string' ? merged.sha : null, Date.now());
    this.sql.exec(
      'INSERT INTO gh_events (at, data, repo) VALUES (?, ?, ?)',
      Date.now(),
      JSON.stringify({
        kind: 'pr_merged_by_owner',
        number: Number(row.pull),
        title: `Change ${row.name}`,
        url: row.pull_url ?? null,
        wids: [],
        method,
      }),
      repo.slug,
    );
    await this.githubWebhook('pull_request', null, { slug: row.repo });
  },

  /**
   * Updates the board's own branch from the default branch with a merge commit, when protection wants it current.
   * The plan at the new head must still be the approved one; otherwise nothing merges and the change says so. Returns
   * the new head, or null when it can't go on.
   */
  async updateChangeBranch(row, env, { client, repo }) {
    const base = repo.defaultBranch || 'main';
    let made;
    try {
      made = await client.send('POST', '/merges', {
        base: row.branch,
        head: base,
        commit_message: `Merge ${base} into ${row.branch}`,
      });
    } catch (error) {
      if (error instanceof GitHubError && error.status === 409) {
        this.noteChangeMerge(row, approvalWords.conflicts(row.pull));
        return null;
      }
      throw error;
    }
    if (!made?.sha) return row.commit_sha; // already current
    this.sql.exec('UPDATE infra_changes SET commit_sha = ?, updated = ? WHERE n = ?', made.sha, Date.now(), row.n);
    this.appendInfraAudit({
      kind: 'change',
      repo: row.repo,
      environment: row.name,
      environmentId: Number(row.environment),
      by: 'board',
      outcome: 'updated',
      summary: `updated #${row.pull} from ${base} (${String(made.sha).slice(0, 7)}) so it can merge`,
    });
    const now = this.changeRow(row.n);
    const at = await this.changePreviewAt(env, now, client, made.sha);
    const approval = /** @type {ChangeApproval} */ (this.changeApproval(now));
    if (at.refused || at.preview.digest !== approval.digest) {
      this.noteChangeMerge(now, approvalWords.updated(row.pull));
      return null;
    }
    return made.sha;
  },

  /** Turns GitHub's auto-merge off on a change's pull request, so nothing merges without the owner's approval. */
  async stopChangeAutoMerge(client, pull) {
    await client.graphql(DISABLE_AUTO_MERGE, { id: pull.node_id });
  },

  /**
   * An approval that waited 24 hours for its merge lapses: the change is open again and asks for a new approval, and
   * GitHub's auto-merge is turned off so nothing merges on the old press.
   */
  async lapseChangeApproval(row, client) {
    const approval = this.changeApproval(row);
    if (approval?.merge === 'auto')
      try {
        const pull = await client.get(`/pulls/${row.pull}`);
        if (pull?.auto_merge) await this.stopChangeAutoMerge(client, pull);
      } catch (error) {
        if (!(error instanceof GitHubError)) throw error;
      }
    this.sql.exec(
      "UPDATE infra_changes SET approval = NULL, state = 'open', why = ?, updated = ? WHERE n = ?",
      approvalWords.lapsed,
      Date.now(),
      row.n,
    );
    this.appendInfraAudit({
      kind: 'change',
      repo: row.repo,
      environment: row.name,
      environmentId: Number(row.environment),
      by: 'board',
      outcome: 'lapsed',
      summary: `the approval of #${row.pull} waited 24 hours for its merge and lapsed; nothing merged`,
    });
  },

  /**
   * During a sync, after the board followed its changes' pull requests (store-infra-changes.js): each approved change
   * lapses, says why it can't merge, or merges at the first green sync where auto-merge isn't on; and an environment
   * whose approved change merged is compared at once, so its plan is made from the merge.
   */
  async advanceInfraChanges(client, repo) {
    const now = Date.now();
    const approved = this.sql
      .exec("SELECT * FROM infra_changes WHERE repo = ? AND state = 'approved' AND pull IS NOT NULL", repo.slug)
      .toArray();
    for (const row of approved) {
      const approval = this.changeApproval(row);
      if (approvalLapsed(approval, now)) {
        await this.lapseChangeApproval(row, client);
        continue;
      }
      const known = this.sql
        .exec('SELECT data FROM gh_pulls WHERE repo = ? AND number = ?', repo.slug, Number(row.pull))
        .toArray()[0];
      const data = known ? JSON.parse(known.data) : null;
      if (!data || data.state !== 'open' || data.headSha !== row.commit_sha) continue;
      const route = mergeRoute({
        mergeable: data.mergeable ?? null,
        mergeableState: data.mergeableState ?? null,
        checks: data.checks?.state ?? null,
      });
      try {
        if (route === 'conflicts') this.noteChangeMerge(row, approvalWords.conflicts(row.pull));
        else if (route === 'failing') this.noteChangeMerge(row, approvalWords.failing(row.pull));
        else if (approval?.merge === 'sync' && route === 'now') {
          const { method } = await this.changeMergeSettings(client);
          await this.mergeChangeNow(row, { client, repo }, row.commit_sha, method);
        } else if (route === 'behind') {
          const env = this.environmentRow(String(row.environment), null);
          const pull = await client.get(`/pulls/${row.pull}`);
          await this.mergeInfraChange(row, env, { client, repo }, pull);
        } else this.noteChangeMerge(row, null);
      } catch (error) {
        if (!(error instanceof GitHubError)) throw error;
        this.noteChangeMerge(row, this.mergeRefusal(row, error));
      }
    }

    // A merged change whose approval waits for its plan: compare its environment now, not on the next drift tick.
    const merged = this.sql
      .exec(
        `SELECT DISTINCT environment FROM infra_changes WHERE repo = ? AND state = 'merged' AND approval IS NOT NULL
           AND json_extract(approval, '$.plan') IS NULL`,
        repo.slug,
      )
      .toArray();
    for (const { environment } of merged) {
      const env = this.sql.exec('SELECT * FROM infra_environments WHERE id = ?', environment).toArray()[0];
      if (!env || this.driftRefusal(env)) continue;
      const last = this.sql.exec('SELECT * FROM infra_drift WHERE environment = ?', env.id).toArray()[0];
      const sha =
        this.sql
          .exec('SELECT valid_sha FROM infra_desired WHERE repo = ? AND environment = ?', env.repo, env.name)
          .toArray()[0]?.valid_sha ?? null;
      if (!driftDue(last, sha, now)) continue;
      try {
        await this.checkInfraDrift(env.id);
      } catch {
        /* being compared already, or no longer comparable: the drift tick looks again */
      }
    }
  },

  /**
   * The approval drift's comparison after a merge settles: the environment's latest merged change, when it's the
   * board's, the owner approved it before it merged, and its plan isn't made yet. Else null.
   */
  approvedMergedChange(environmentId) {
    const row = this.sql
      .exec(
        "SELECT * FROM infra_changes WHERE environment = ? AND state = 'merged' ORDER BY updated DESC, n DESC LIMIT 1",
        Number(environmentId),
      )
      .toArray()[0];
    const approval = row ? this.changeApproval(row) : null;
    return approval && !approval.plan && !approval.settled ? row : null;
  },

  /**
   * The plan drift made from an approved change's merge: approved on the owner's recorded press when its digest is the
   * one approved and its policy names no new rule, else in front of the owner with the usual push. A plan the policy
   * let through is approved already; one it refused stays a draft.
   * @param {Record<string, any>} change the change's row (approvedMergedChange)
   * @param {ReturnType<typeof import('./infra-plans.js').planView>} plan
   */
  async settleChangeApproval(change, plan) {
    const approval = /** @type {ChangeApproval} */ (this.changeApproval(change));
    const digest = await planDigest(JSON.parse(this.planRow(plan.id).diff));
    /** @type {ChangeApproval['settled']} */
    let settled;
    let summary;
    if (plan.state === 'approved') {
      settled = 'approved';
      summary = `${plan.id} from #${change.pull} was let through by your policy`;
    } else if (plan.state !== 'draft' || plan.policy?.outcome === 'refused') {
      settled = 'refused';
      summary = `${plan.id} from #${change.pull} is ${plan.state === 'draft' ? 'refused by your policy' : plan.state}; your approval isn’t used`;
    } else if (digest === approval.kept && newRules(approval.rules, plan.policy).length === 0) {
      this.moveInfraPlan(plan.id, 'waiting', {
        by: 'board',
        summary: `#${change.pull} merged a change you approved on the console`,
      });
      plan = await this.approveInfraPlan(plan.id, {
        by: 'owner',
        summary: `approved on the console before #${change.pull} merged; digest ${digest.slice(0, 12)}`,
      });
      settled = 'approved';
      summary = `${plan.id} from #${change.pull} is the plan you approved; the board applies it`;
    } else {
      const added = newRules(approval.rules, plan.policy);
      plan = await this.waitForOwner(plan.id, {
        by: 'board',
        summary: `#${change.pull} merged, but its plan isn’t the one you approved${added.length ? `: your policy’s ${added.join(', ')} now applies` : ''}`,
        reason: approvalWords.between,
      });
      settled = 'waits';
      summary = `${plan.id} from #${change.pull} isn’t the plan you approved, so it waits for you`;
    }
    this.setChangeApproval(change.n, { ...approval, plan: plan.id, settled });
    this.appendInfraAudit({
      kind: 'change',
      repo: change.repo,
      environment: change.name,
      environmentId: Number(change.environment),
      plan: plan.id,
      by: 'board',
      outcome: settled === 'approved' ? 'planned' : settled === 'waits' ? 'waits' : 'refused',
      summary,
    });
    return plan;
  },
};
