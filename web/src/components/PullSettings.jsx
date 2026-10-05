import { confirmDialog, githubRepoFacts, mergeMethod, pullSetting, setPullSetting } from '../lib/store.js';
import { Segmented } from './ui.jsx';

const ON_OFF = [
  { id: 'on', label: 'On' },
  { id: 'off', label: 'Off' },
];

/**
 * Keep branches up to date, and Merge when green, for one repository: the owner's, in this browser only. A
 * repository's settings page shows them (WEB-31). `data` is the GitHub view's; `slug` null is the default
 * repository's; `name` names it in the labels and the confirm.
 * @param {Record<string, any>} props
 */
export function RepoPullSettings({ data, slug = null, name = null }) {
  const facts = githubRepoFacts(slug);
  if (!facts) return null;
  const own = facts.slug ?? slug;
  const isDefault = facts.isDefault !== false;
  const method = mergeMethod.value === 'merge' ? 'a merge commit' : 'squash';
  const branch = facts.branch ?? 'main';
  const keep = pullSetting(own, 'keep');
  const merge = pullSetting(own, 'merge');
  // What merging deploys: a legacy install's Worker goes to staging; another repository's pipeline decides; none deploys nothing.
  const deploys = !facts.pipeline ? '' : isDefault ? ' Merging deploys to staging.' : ' Merging can start a deploy.';
  const where = name ? ` in ${name}` : '';
  const blocked = facts.access?.write?.ok === false ? facts.access.write.reason : null;
  const turnOnMerging = async () => {
    const ready = (data.open ?? []).filter((p) => p.verdict === 'ready' && (!data.all || p.repo === own)).length;
    const now =
      ready === 1
        ? ' 1 is ready now and merges straight away.'
        : ready > 1
          ? ` ${ready} are ready now and merge straight away.`
          : '';
    const ok = await confirmDialog({
      title: name ? `Merge pull requests in ${name} when green?` : 'Merge pull requests when green?',
      body: `Every open pull request${where} that isn’t a draft merges (${method}) once its required checks pass, including Dependabot’s.${now}${facts.pipeline ? (isDefault ? ' Merging deploys to staging; you promote it to production yourself.' : ' Merging can start a deploy.') : ''} It works while the board is open in this browser.`,
      confirmLabel: 'Turn on',
    });
    if (ok) setPullSetting(own, 'merge', true);
  };
  return (
    <>
      <div class="field">
        <span class="field-label">Keep branches up to date</span>
        <Segmented
          label={`Keep branches up to date${where}`}
          options={ON_OFF}
          value={keep ? 'on' : 'off'}
          onChange={(v) => setPullSetting(own, 'keep', v === 'on')}
        />
        <span class="field-hint">
          When {branch} moves on, updates each open pull request’s branch with it, and its checks run again. Skips
          drafts and conflicts.
        </span>
      </div>
      <div class="field">
        <span class="field-label">Merge when green</span>
        <Segmented
          label={`Merge when green${where}`}
          options={ON_OFF}
          value={merge ? 'on' : 'off'}
          onChange={(v) => {
            if (v === 'off') setPullSetting(own, 'merge', false);
            else if (!merge) turnOnMerging();
          }}
        />
        <span class="field-hint">
          Every open pull request that isn’t a draft merges ({method}) once its checks pass.{deploys} Turn it off for
          one on its page.
        </span>
      </div>
      {blocked && <span class="field-hint">{blocked}</span>}
      {data?.githubStatus?.held && (
        <span class="field-hint">
          On hold: GitHub reports trouble ({data.githubStatus.summary}). Both carry on once it’s working again.
        </span>
      )}
    </>
  );
}
