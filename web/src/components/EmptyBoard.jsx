import { activeFilters, filters, loadError, loaded, newTask, setFilter, EMPTY_FILTERS } from '../lib/store.js';

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
