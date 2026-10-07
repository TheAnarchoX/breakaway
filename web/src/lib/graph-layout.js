// The Dependencies view's layout (WEB-98): finished work folded into one card a step, the path to a group's
// last task, and an order within each step that crosses fewer arrows. Pure functions over ids, so the tests
// can check them; GraphView turns tasks into ids and draws the result.

/** A step folds its finished tasks into one card once it holds this many. Fewer stay as cards, for context. */
export const FOLD_FROM = 3;
/** How many times the ordering sweeps down and back up the steps. */
export const SWEEPS = 6;

/** The id of a step's folded card. */
export const foldId = (step) => `fold:${step}`;
/** The id of the gap a long arrow passes through on a step it skips. */
const passId = (from, to, step) => `pass:${from}>${to}:${step}`;
export const isFold = (id) => id.startsWith('fold:');
export const isPass = (id) => id.startsWith('pass:');

/**
 * Folds each step's finished tasks into one card, once there are FOLD_FROM of them, except the steps in `unfold`.
 * Arrows to or from a folded task go to or from its card instead, once each.
 * @param {string[][]} steps ids, one list a step
 * @param {[string, string][]} edges [from, to]: `to` waits for `from`
 * @param {{ done: (id: string) => boolean, unfold?: Set<number>, from?: number }} options
 * @returns {{ steps: string[][], edges: [string, string][], folded: Map<string, string[]> }}
 */
export function foldDone(steps, edges, { done, unfold = new Set(), from = FOLD_FROM }) {
  const into = new Map();
  const folded = new Map();
  const out = steps.map((ids, step) => {
    const finished = ids.filter(done);
    if (unfold.has(step) || finished.length < from) return ids;
    const card = foldId(step);
    for (const id of finished) into.set(id, card);
    folded.set(card, finished);
    return [...ids.filter((id) => !done(id)), card];
  });
  const seen = new Set();
  const kept = [];
  for (const [a, b] of edges) {
    const edge = [into.get(a) ?? a, into.get(b) ?? b];
    const key = edge.join('>');
    if (edge[0] === edge[1] || seen.has(key)) continue;
    seen.add(key);
    kept.push(/** @type {[string, string]} */ (edge));
  }
  return { steps: out, edges: kept, folded };
}

/**
 * The path to the group's last task: the longest run of open tasks, each waiting for the one before, that ends
 * where no open task waits any more. Ties go to the earlier id in `order` (the board's rank). Empty when no two
 * open tasks wait for each other.
 * @param {string[]} order every id, by rank
 * @param {[string, string][]} edges
 * @param {(id: string) => boolean} open
 * @returns {string[]} from the first task to the last
 */
export function criticalPath(order, edges, open) {
  const before = new Map();
  for (const [a, b] of edges) {
    if (!open(a) || !open(b)) continue;
    if (!before.has(b)) before.set(b, []);
    before.get(b).push(a);
  }
  const at = new Map(order.map((id, i) => [id, i]));
  const length = new Map();
  const best = new Map();
  const measure = (id, trail = new Set()) => {
    if (length.has(id)) return length.get(id);
    if (trail.has(id)) return 0; // a cycle: Taskwarrior allows one, so don't loop forever
    trail.add(id);
    let most = 0;
    let pick = null;
    for (const a of before.get(id) ?? []) {
      const n = measure(a, trail);
      if (n > most || (n === most && pick !== null && at.get(a) < at.get(pick))) {
        most = n;
        pick = a;
      }
    }
    length.set(id, most + 1);
    best.set(id, pick);
    return most + 1;
  };
  let end = null;
  for (const id of order) if (open(id) && measure(id) > (end === null ? 0 : measure(end))) end = id;
  if (end === null || measure(end) < 2) return [];
  const path = [];
  const onPath = new Set();
  for (let id = end; id !== null && !onPath.has(id); id = best.get(id)) {
    path.unshift(id);
    onPath.add(id);
  }
  return path;
}

/**
 * The steps with a gap added on every step an arrow skips, so the arrow can pass between cards instead of
 * through one, and the arrows as links between neighbouring steps.
 * @param {string[][]} steps
 * @param {[string, string][]} edges
 * @returns {{ steps: string[][], links: [string, string][], routes: Map<string, string[]> }} routes: each edge's
 * gaps, keyed `from>to`
 */
export function layered(steps, edges) {
  const stepOf = new Map();
  steps.forEach((ids, step) => {
    for (const id of ids) stepOf.set(id, step);
  });
  const out = steps.map((ids) => [...ids]);
  const links = [];
  const routes = new Map();
  for (const [a, b] of edges) {
    const from = stepOf.get(a);
    const to = stepOf.get(b);
    if (from === undefined || to === undefined || to <= from) continue; // a cycle's back edge is drawn straight
    const gaps = [];
    let prev = a;
    for (let step = from + 1; step < to; step += 1) {
      const gap = passId(a, b, step);
      out[step].push(gap);
      gaps.push(gap);
      links.push([prev, gap]);
      prev = gap;
    }
    links.push([prev, b]);
    routes.set(`${a}>${b}`, gaps);
  }
  return { steps: out, links, routes };
}

/**
 * How many pairs of links cross between neighbouring steps, laid out in this order.
 * @param {string[][]} steps
 * @param {[string, string][]} links between neighbouring steps
 */
export function crossings(steps, links) {
  const pos = new Map();
  const stepOf = new Map();
  steps.forEach((ids, step) => {
    ids.forEach((id, i) => {
      pos.set(id, i);
      stepOf.set(id, step);
    });
  });
  const between = steps.map(() => []);
  for (const [a, b] of links) {
    const s = stepOf.get(a);
    if (s === undefined || stepOf.get(b) !== s + 1) continue;
    between[s].push([pos.get(a), pos.get(b)]);
  }
  let count = 0;
  for (const pairs of between)
    for (let i = 0; i < pairs.length; i += 1)
      for (let j = i + 1; j < pairs.length; j += 1) {
        const [a1, b1] = pairs[i];
        const [a2, b2] = pairs[j];
        if ((a1 - a2) * (b1 - b2) < 0) count += 1;
      }
  return count;
}

/**
 * Orders each step so fewer arrows cross: sweeps down and up the steps, moving each card to the average place of
 * the cards it links to on the step it was just compared with; the order it came in (the board's rank) breaks
 * ties, then swaps neighbouring cards where that alone helps. Keeps the best order seen, so it never crosses
 * more than the order it was given.
 * @param {string[][]} steps
 * @param {[string, string][]} links between neighbouring steps
 * @param {number} [sweeps]
 * @returns {string[][]}
 */
export function orderSteps(steps, links, sweeps = SWEEPS) {
  const before = new Map();
  const after = new Map();
  for (const [a, b] of links) {
    if (!after.has(a)) after.set(a, []);
    after.get(a).push(b);
    if (!before.has(b)) before.set(b, []);
    before.get(b).push(a);
  }
  const given = new Map();
  for (const ids of steps)
    ids.forEach((id, i) => {
      given.set(id, i);
    });
  let current = steps.map((ids) => [...ids]);
  let best = current;
  let fewest = crossings(current, links);
  const reorder = (step, neighbour, by) => {
    const pos = new Map(current[neighbour].map((id, i) => [id, i]));
    const ids = current[step];
    const key = new Map(
      ids.map((id, i) => {
        const near = (by.get(id) ?? []).filter((n) => pos.has(n));
        // A card with no link that way keeps its place, scaled to the neighbour's length.
        const place = near.length
          ? near.reduce((sum, n) => sum + pos.get(n), 0) / near.length
          : (i * Math.max(1, current[neighbour].length - 1)) / Math.max(1, ids.length - 1);
        return [id, place];
      }),
    );
    current[step] = [...ids].sort((a, b) => key.get(a) - key.get(b) || given.get(a) - given.get(b));
  };
  const keep = () => {
    const count = crossings(current, links);
    if (count < fewest) {
      fewest = count;
      best = current.map((ids) => [...ids]);
    }
    return count;
  };
  for (let sweep = 0; sweep < sweeps && fewest > 0; sweep += 1) {
    current = current.map((ids) => [...ids]);
    for (let step = 1; step < current.length; step += 1) reorder(step, step - 1, before);
    keep();
    for (let step = current.length - 2; step >= 0; step -= 1) reorder(step, step + 1, after);
    keep();
  }
  // Then swap neighbouring cards wherever that alone crosses fewer arrows, until no swap helps.
  current = best.map((ids) => [...ids]);
  for (let pass = 0, swapped = true; swapped && pass < sweeps && fewest > 0; pass += 1) {
    swapped = false;
    for (const ids of current)
      for (let i = 0; i + 1 < ids.length; i += 1) {
        [ids[i], ids[i + 1]] = [ids[i + 1], ids[i]];
        const count = crossings(current, links);
        if (count < fewest) {
          fewest = count;
          swapped = true;
        } else [ids[i], ids[i + 1]] = [ids[i + 1], ids[i]];
      }
  }
  return current;
}
