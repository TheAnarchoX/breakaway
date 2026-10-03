import { useEffect, useState } from 'preact/hooks';
import { ChevronDown } from 'lucide-preact';
import { HORIZONS, STATES, byEnd, rank, stateOf } from '../lib/model.js';
import { actions, areaList, confirmDialog, lanes, multiRepo, navOrder, visible } from '../lib/store.js';
import { useWidth } from '../lib/media.js';
import { boardFits } from '../lib/layout.js';
import { TaskCard } from '../components/TaskCard.jsx';
import { Segmented } from '../components/ui.jsx';
import { EmptyBoard } from '../components/EmptyBoard.jsx';

const DONE_SHOWN = 8;

async function closeNow() {
  const plan = await actions.closeHorizon(true);
  if (!plan) return;
  const ok = await confirmDialog({
    title: 'Close now?',
    body: `${multiRepo.value ? 'In every repository: ' : ''}${plan.archived} finished ${plan.archived === 1 ? 'task goes' : 'tasks go'} to the archive, ${plan.carriedOver} unfinished ${plan.carriedOver === 1 ? 'stays' : 'stay'} in now, and ${plan.movedUp} ${plan.movedUp === 1 ? 'task moves' : 'tasks move'} up: next becomes now, later becomes next.`,
    confirmLabel: 'Close now',
  });
  if (ok) actions.closeHorizon();
}

/** @returns {{ id: any, label: string, hint?: string }[]} */
function laneList(mode) {
  if (mode === 'horizon')
    return [...HORIZONS.map((h) => ({ id: h.id, label: h.label, hint: h.hint })), { id: null, label: 'No horizon' }];
  if (mode === 'area')
    return [...areaList.value.map((a) => ({ id: a.id, label: a.label })), { id: null, label: 'No area' }];
  return [{ id: 'all', label: 'All tasks' }];
}

function laneOf(t, mode) {
  if (mode === 'horizon') return t.horizon ?? null;
  if (mode === 'area') return t.project ?? null;
  return 'all';
}

export function BoardView() {
  // Every column side by side whenever they fit, however narrow the room the sidebar and a docked
  // task leave: the columns shrink and never scroll sideways. Below that, one column at a time.
  const [measure, width] = useWidth(innerWidth);
  const wide = boardFits(width, STATES.length);
  const mode = lanes.value;
  const [column, setColumn] = useState('ready');
  const [collapsed, setCollapsed] = useState({});
  const [allDone, setAllDone] = useState(false);

  const cells = new Map();
  const counts = Object.fromEntries(STATES.map((s) => [s.id, 0]));
  for (const t of visible.value) {
    const state = stateOf(t);
    if (!(state in counts)) continue;
    counts[state] += 1;
    const key = `${laneOf(t, mode)}|${state}`;
    cells.set(key, [...(cells.get(key) ?? []), t]);
  }
  for (const [key, list] of cells) list.sort(key.endsWith('|done') ? byEnd : rank);
  const laneRows = laneList(mode)
    .map((lane) => ({
      ...lane,
      total: STATES.reduce((n, s) => n + (cells.get(`${lane.id}|${s.id}`)?.length ?? 0), 0),
    }))
    .filter((lane) => lane.total > 0);
  const hide = mode === 'horizon' ? ['horizon'] : mode === 'area' ? ['area'] : [];

  const cellTasks = (lane, state) => {
    const list = cells.get(`${lane.id}|${state}`) ?? [];
    return state === 'done' && !allDone ? list.slice(0, DONE_SHOWN) : list;
  };
  const hiddenDone = laneRows.reduce(
    (n, lane) => n + Math.max(0, (cells.get(`${lane.id}|done`)?.length ?? 0) - DONE_SHOWN),
    0,
  );

  const shownStates = wide ? STATES : STATES.filter((s) => s.id === column);
  useEffect(() => {
    navOrder.value = laneRows.flatMap((lane) => shownStates.flatMap((s) => cellTasks(lane, s.id))).map((t) => t.uuid);
  });

  if (!visible.value.length) return <EmptyBoard />;

  return (
    <div ref={measure} class={`board ${wide ? 'board-wide' : 'board-narrow'}`}>
      <h1 class="visually-hidden">Board</h1>
      {!wide && (
        <div class="board-columns-picker">
          <Segmented
            label="Column"
            options={STATES.map((s) => ({ id: s.id, label: s.label, count: counts[s.id], hint: s.hint }))}
            value={column}
            onChange={setColumn}
          />
        </div>
      )}
      <div class="board-grid" style={{ '--cols': shownStates.length }}>
        {wide && (
          <div class="board-head">
            {STATES.map((s) => (
              <div key={s.id} class={`col-head col-${s.id}`} title={s.hint}>
                <span class={`state-dot dot-${s.id}`} aria-hidden="true" />
                <h2>{s.label}</h2>
                <span class="count">{counts[s.id]}</span>
              </div>
            ))}
          </div>
        )}
        {laneRows.map((lane) => {
          const id = `lane-${lane.id}`;
          const isCollapsed = collapsed[lane.id];
          return (
            <section
              key={lane.id}
              class="lane"
              aria-labelledby={mode === 'none' ? undefined : id}
              aria-label={mode === 'none' ? 'All tasks' : undefined}
            >
              {mode !== 'none' && (
                <div class="lane-head-row">
                  <h2 class="lane-head" id={id}>
                    <button
                      type="button"
                      aria-expanded={!isCollapsed}
                      onClick={() => setCollapsed({ ...collapsed, [lane.id]: !isCollapsed })}
                    >
                      <ChevronDown size={16} aria-hidden="true" class="lane-chevron" />
                      {lane.label}
                      <span class="count">{lane.total}</span>
                      {lane.hint && <span class="lane-hint">{lane.hint}</span>}
                    </button>
                  </h2>
                  {lane.id === 'now' && (
                    <button type="button" class="btn btn-quiet btn-sm" onClick={closeNow}>
                      Close now
                    </button>
                  )}
                </div>
              )}
              {!isCollapsed && (
                <div class="lane-row">
                  {shownStates.map((s) => {
                    const list = cellTasks(lane, s.id);
                    return (
                      <div key={s.id} class={`cell cell-${s.id}`}>
                        {list.length ? (
                          <ul class="cell-list" aria-label={`${s.label}${mode === 'none' ? '' : `, ${lane.label}`}`}>
                            {list.map((t) => (
                              <li key={t.uuid}>
                                <TaskCard task={t} hide={hide} />
                              </li>
                            ))}
                          </ul>
                        ) : (
                          <span class="cell-empty" aria-hidden="true" />
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </section>
          );
        })}
      </div>
      {hiddenDone > 0 && shownStates.some((s) => s.id === 'done') && (
        <p class="board-more">
          <button type="button" class="btn btn-quiet btn-sm" onClick={() => setAllDone(true)}>
            Show {hiddenDone} more finished
          </button>
        </p>
      )}
    </div>
  );
}
