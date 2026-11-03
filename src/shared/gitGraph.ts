/**
 * Lay out a commit graph in lanes, one row per commit, newest first (the
 * order `git log --topo-order` gives). Each row says which column its commit
 * sits in and which lines cross the row: `up` from the row's top edge to its
 * middle, `down` from the middle to the bottom edge, each as [from, to] columns.
 */
export interface GraphRow {
  col: number;
  up: Array<[number, number]>;
  down: Array<[number, number]>;
}

export interface GraphLayout {
  rows: GraphRow[];
  /** Columns the widest row uses. */
  width: number;
}

export function layoutGraph(commits: ReadonlyArray<{ hash: string; parents: readonly string[] }>): GraphLayout {
  // Each lane holds the hash of the commit it's waiting for, or null when free.
  const lanes: Array<string | null> = [];
  const rows: GraphRow[] = [];
  let width = 0;
  const free = () => {
    const i = lanes.indexOf(null);
    return i === -1 ? lanes.length : i;
  };

  for (const commit of commits) {
    const up: Array<[number, number]> = [];
    const down: Array<[number, number]> = [];
    let col = lanes.indexOf(commit.hash);
    const tip = col === -1;
    if (tip) col = free();
    lanes[col] = commit.hash;

    for (let i = 0; i < lanes.length; i++) {
      const waiting = lanes[i];
      if (waiting === null) continue;
      if (waiting === commit.hash) {
        // Lanes from children: the commit's own lane, and branches that merge back here.
        if (i !== col || !tip) up.push([i, col]);
        if (i !== col) lanes[i] = null;
      } else up.push([i, i]);
    }

    const passing = lanes.map((h, i) => (h !== null && i !== col ? i : -1)).filter((i) => i >= 0);
    lanes[col] = null;
    const targets = new Set<number>();
    for (const [k, parent] of commit.parents.entries()) {
      // The first parent carries on straight down, even when another lane already waits for it:
      // the lanes meet at the parent, in the leftmost one, so the main line stays put.
      // Other parents join a lane already waiting for them, or branch out to a free one.
      let lane = k === 0 ? col : lanes.indexOf(parent);
      if (lane === -1) lane = free();
      lanes[lane] = parent;
      if (!targets.has(lane)) {
        targets.add(lane);
        down.push([col, lane]);
      }
    }
    for (const i of passing) down.push([i, i]);

    while (lanes.length && lanes[lanes.length - 1] === null) lanes.pop();
    for (const [a, b] of [...up, ...down]) width = Math.max(width, a + 1, b + 1);
    width = Math.max(width, col + 1);
    rows.push({ col, up, down });
  }
  return { rows, width };
}
