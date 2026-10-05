import {
  activeFilters,
  connections,
  filters,
  go,
  loadError,
  loaded,
  newTask,
  repos,
  setFilter,
  EMPTY_FILTERS,
} from '../lib/store.js';

/**
 * What a view shows when it has nothing: still loading, an error, filtered out, or empty.
 * @param {Record<string, any>} props
 */
export function EmptyBoard({ what = 'tasks' }) {
  if (loadError.value && !loaded.value) {
    return (
      <div class="empty">
        <h2>Couldn’t load the board</h2>
        <p class="muted">{loadError.value}</p>
      </div>
    );
  }
  if (!loaded.value)
    return (
      <div class="empty" aria-busy="true">
        <p class="muted">Loading the board…</p>
      </div>
    );
  if (activeFilters.value > 0 || filters.value.done === 'hide') {
    return (
      <div class="empty">
        <h2>Nothing matches</h2>
        <p class="muted">No {what} fit these filters.</p>
        <button type="button" class="btn btn-outline btn-sm" onClick={() => setFilter(EMPTY_FILTERS)}>
          Clear filters
        </button>
      </div>
    );
  }
  // A fresh install that isn't set up yet (WEB-40): Set up the board first, which ends at a first agent's merged pull request.
  if (repos.value.firstRun && !connections.value.data?.setup?.done) {
    return (
      <div class="empty">
        <h2>No {what} yet</h2>
        <p class="muted">
          This board is new. Set it up to connect a repository and its agents, then follow a first agent to a merged
          pull request.
        </p>
        <div class="empty-actions">
          <button type="button" class="btn btn-primary btn-sm" onClick={() => go('connections')}>
            Set up the board
          </button>
          <button
            type="button"
            class="btn btn-outline btn-sm"
            onClick={() => {
              newTask.value = {};
            }}
          >
            New task
          </button>
        </div>
      </div>
    );
  }
  return (
    <div class="empty">
      <h2>No {what} yet</h2>
      <p class="muted">Add the first one, or let an agent add what it finds.</p>
      <button
        type="button"
        class="btn btn-primary btn-sm"
        onClick={() => {
          newTask.value = {};
        }}
      >
        New task
      </button>
    </div>
  );
}
