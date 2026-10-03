import { useEffect } from 'preact/hooks';
import { ArrowDown, ArrowUp, ArrowUpDown } from 'lucide-preact';
import { HORIZONS, HORIZON_LABEL, PRIORITY_LABEL, STATES, ago, compareWid, rank, ref, stateOf } from '../lib/model.js';
import { areaLabel, areaList, byUuid, current, hashFor, listGroup, listSort, navOrder, visible } from '../lib/store.js';
import { useMedia } from '../lib/media.js';
import { ClaimChip, RepoChip, RoleTags, Segmented, StateBadge, widClass } from '../components/ui.jsx';
import { EmptyBoard } from '../components/EmptyBoard.jsx';
import { Title } from '../lib/richtext.jsx';

const STATE_ORDER = Object.fromEntries(STATES.map((s, i) => [s.id, i]));
const H_ORDER = { now: 0, next: 1, later: 2 };
const P_ORDER = { H: 0, M: 1, L: 2 };
const text = (a, b) => String(a ?? '￿').localeCompare(String(b ?? '￿'));

const SORTS = {
  rank: { label: 'Best first', cmp: rank },
  wid: { label: 'Work ID', cmp: compareWid },
  description: { label: 'Title', cmp: (a, b) => text(a.description, b.description) },
  state: { label: 'State', cmp: (a, b) => STATE_ORDER[stateOf(a)] - STATE_ORDER[stateOf(b)] || rank(a, b) },
  area: { label: 'Area', cmp: (a, b) => text(areaLabel(a.project), areaLabel(b.project)) || rank(a, b) },
  horizon: { label: 'Horizon', cmp: (a, b) => (H_ORDER[a.horizon] ?? 4) - (H_ORDER[b.horizon] ?? 4) || rank(a, b) },
  priority: { label: 'Priority', cmp: (a, b) => (P_ORDER[a.priority] ?? 3) - (P_ORDER[b.priority] ?? 3) || rank(a, b) },
  claim: { label: 'Claimed by', cmp: (a, b) => text(a.claim, b.claim) || rank(a, b) },
  modified: { label: 'Updated', cmp: (a, b) => String(b.modified).localeCompare(String(a.modified)) },
};

const GROUPS = [
  { id: 'none', label: 'No groups' },
  { id: 'state', label: 'State' },
  { id: 'area', label: 'Area' },
  { id: 'horizon', label: 'Horizon' },
];

function groupsOf(list, by) {
  if (by === 'none') return [{ id: 'all', label: null, tasks: list }];
  const defs =
    by === 'state'
      ? STATES.map((s) => ({ id: s.id, label: s.label }))
      : by === 'area'
        ? [...areaList.value.map((a) => ({ id: a.id, label: a.label })), { id: null, label: 'No area' }]
        : [...HORIZONS.map((h) => ({ id: h.id, label: h.label })), { id: null, label: 'No horizon' }];
  const key = (t) => (by === 'state' ? stateOf(t) : by === 'area' ? (t.project ?? null) : (t.horizon ?? null));
  return defs.map((d) => ({ ...d, tasks: list.filter((t) => key(t) === d.id) })).filter((g) => g.tasks.length);
}

/** @param {Record<string, any>} props */
function Deps({ task: t }) {
  const names = (uuids) =>
    uuids
      .map((u) => byUuid.value.get(u))
      .filter(Boolean)
      .map(ref)
      .join(', ');
  return (
    <>
      {t.blockedBy.length > 0 && <span class="dep dep-wait">Waits for {names(t.blockedBy)}</span>}
      {t.blocking.length > 0 && <span class="dep">Holds up {names(t.blocking)}</span>}
    </>
  );
}

export function ListView() {
  const wide = useMedia('(min-width: 900px)');
  const sort = listSort.value;
  const cmp = SORTS[sort.key]?.cmp ?? rank;
  const sorted = [...visible.value].sort((a, b) => (sort.dir === 'desc' ? -cmp(a, b) : cmp(a, b)));
  const groups = groupsOf(sorted, listGroup.value);
  useEffect(() => {
    navOrder.value = groups.flatMap((g) => g.tasks).map((t) => t.uuid);
  });

  const setSort = (key) => {
    listSort.value = sort.key === key ? { key, dir: sort.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'asc' };
  };
  const th = (key, label, className = '') => {
    const active = sort.key === key;
    const Icon = !active ? ArrowUpDown : sort.dir === 'asc' ? ArrowUp : ArrowDown;
    return (
      <th
        scope="col"
        class={className}
        aria-sort={active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : undefined}
      >
        <button type="button" class="th-sort" onClick={() => setSort(key)}>
          {label}
          <Icon size={14} aria-hidden="true" />
        </button>
      </th>
    );
  };

  return (
    <div class="list-view">
      <h1 class="visually-hidden">List</h1>
      <div class="list-tools">
        <label class="inline-select">
          <span>Sort</span>
          <select
            class="select select-sm"
            value={sort.key}
            onChange={(e) => {
              listSort.value = { key: e.currentTarget.value, dir: 'asc' };
            }}
          >
            {Object.entries(SORTS).map(([id, s]) => (
              <option key={id} value={id}>
                {s.label}
              </option>
            ))}
          </select>
        </label>
        <Segmented
          label="Group by"
          options={GROUPS}
          value={listGroup.value}
          onChange={(v) => {
            listGroup.value = v;
          }}
        />
        <span class="muted list-count">{sorted.length === 1 ? '1 task' : `${sorted.length} tasks`}</span>
      </div>
      {!sorted.length ? (
        <EmptyBoard />
      ) : (
        groups.map((g) => (
          <section key={g.id} class="list-group" aria-label={g.label ?? 'Tasks'}>
            {g.label && (
              <h2 class="list-group-head">
                {g.label}
                <span class="count">{g.tasks.length}</span>
              </h2>
            )}
            {wide ? (
              <div class="table-wrap">
                <table class="table">
                  <thead>
                    <tr>
                      {th('wid', 'ID', 'col-wid')}
                      {th('description', 'Title', 'col-title')}
                      {th('state', 'State')}
                      {th('area', 'Area')}
                      {th('horizon', 'Horizon')}
                      {th('priority', 'Priority')}
                      {th('claim', 'Claimed by')}
                      <th scope="col">Dependencies</th>
                      {th('modified', 'Updated')}
                    </tr>
                  </thead>
                  <tbody>
                    {g.tasks.map((t) => (
                      <tr key={t.uuid} class={current.value?.uuid === t.uuid ? 'is-open' : ''}>
                        <td class="col-wid">
                          <span class={widClass(t)}>{ref(t)}</span> <RepoChip slug={t.repo} />
                        </td>
                        <td class="col-title">
                          <a
                            class="row-link"
                            href={hashFor({ task: ref(t) })}
                            aria-current={current.value?.uuid === t.uuid ? 'true' : undefined}
                          >
                            <Title text={t.description} />
                          </a>
                          <span class="row-tags">
                            <RoleTags tags={t.tags} />
                          </span>
                        </td>
                        <td>
                          <StateBadge task={t} />
                        </td>
                        <td>{areaLabel(t.project) ?? '—'}</td>
                        <td>{HORIZON_LABEL[t.horizon] ?? '—'}</td>
                        <td>{PRIORITY_LABEL[t.priority] ?? '—'}</td>
                        <td>{t.claim ? <ClaimChip task={t} /> : '—'}</td>
                        <td class="col-deps">
                          <Deps task={t} />
                        </td>
                        <td class="nowrap muted" title={t.modified}>
                          {ago(t.modified)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <ul class="rows">
                {g.tasks.map((t) => (
                  <li key={t.uuid}>
                    <a
                      class={`row ${current.value?.uuid === t.uuid ? 'is-open' : ''}`}
                      href={hashFor({ task: ref(t) })}
                    >
                      <span class="row-top">
                        <span class={widClass(t)}>{ref(t)}</span>
                        <RepoChip slug={t.repo} />
                        <StateBadge task={t} />
                        {t.priority && (
                          <span class={`prio prio-${t.priority}`}>
                            {PRIORITY_LABEL[t.priority]}
                            <span class="visually-hidden"> priority</span>
                          </span>
                        )}
                      </span>
                      <span class="row-title">
                        <Title text={t.description} />
                      </span>
                      <span class="row-meta">
                        {t.project && <span class="meta">{areaLabel(t.project)}</span>}
                        {t.horizon && <span class="meta">{HORIZON_LABEL[t.horizon]}</span>}
                        <RoleTags tags={t.tags} />
                        <ClaimChip task={t} />
                        <Deps task={t} />
                      </span>
                    </a>
                  </li>
                ))}
              </ul>
            )}
          </section>
        ))
      )}
    </div>
  );
}
