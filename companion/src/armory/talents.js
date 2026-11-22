// Talent builds: the AI proposes the order in which to spend every point,
// and this module replays that order under the game's own rules (points per
// row, prerequisites, max ranks) with the trees the addon read from the game.
// Only points the game would accept reach the player.
import { num, str, strings, list } from './json.js';

export const DEFAULT_POINTS_AT_CAP = 51; // one per level from 10 to 60
const POINTS_PER_ROW = 5;

// The trees as sent by the addon ("armory_talents"), indexed by talent id.
export function talentIndex(section) {
  const byId = new Map();
  const trees = [];
  for (const t of list(section?.trees)) {
    if (!t || typeof t !== 'object') continue;
    const tree = { id: num(t.id) ?? trees.length + 1, name: str(t.name, 60) || `Tree ${trees.length + 1}`, talents: [] };
    for (const raw of list(t.talents)) {
      const id = num(raw?.id);
      const max = num(raw?.max);
      if (id === null || !max || max < 1 || byId.has(id)) continue;
      const talent = {
        id, name: str(raw.name, 80) || `#${id}`, row: Math.max(1, num(raw.row) ?? 1), max,
        rank: Math.min(Math.max(0, num(raw.rank) ?? 0), max), requires: num(raw.requires), tree,
      };
      tree.talents.push(talent);
      byId.set(id, talent);
    }
    trees.push(tree);
  }
  const pointsAtCap = Math.min(Math.max(num(section?.pointsAtCap) ?? DEFAULT_POINTS_AT_CAP, 1), 80);
  return { byId, trees, pointsAtCap };
}

// Why this point can't be spent now, or null when the game would allow it.
function blocked(talent, ranks, treePoints, byId) {
  if ((ranks.get(talent.id) || 0) >= talent.max) return `"${talent.name}" already has ${talent.max}/${talent.max} points`;
  const need = (talent.row - 1) * POINTS_PER_ROW;
  const have = treePoints.get(talent.tree) || 0;
  if (have < need) return `"${talent.name}" (row ${talent.row}) needs ${need} points in ${talent.tree.name} first, and only ${have} are spent there at that point`;
  const req = talent.requires !== null && byId.get(talent.requires);
  if (req && (ranks.get(req.id) || 0) < req.max) return `"${talent.name}" needs "${req.name}" at ${req.max}/${req.max} first`;
  return null;
}

// Replays `order` (talent ids, one per point). A point that isn't legal yet
// waits and is tried again after each point that is: an order with two
// points swapped is still the build the AI meant. Returns the legal order and
// what was wrong.
export function validateOrder(index, order, { limit = index.pointsAtCap } = {}) {
  const { byId } = index;
  const ranks = new Map();
  const treePoints = new Map();
  const placed = [];
  const problems = [];
  let waiting = [];
  let reordered = 0;

  const spend = (talent) => {
    ranks.set(talent.id, (ranks.get(talent.id) || 0) + 1);
    treePoints.set(talent.tree, (treePoints.get(talent.tree) || 0) + 1);
    placed.push(talent.id);
  };
  // Points that were waiting and are legal now, in the order they were given.
  const retry = () => {
    for (let moved = true; moved && placed.length < limit;) {
      moved = false;
      for (let i = 0; i < waiting.length && placed.length < limit; i++) {
        if (!blocked(waiting[i].talent, ranks, treePoints, byId)) {
          spend(waiting.splice(i, 1)[0].talent);
          reordered++;
          moved = true;
          i--;
        }
      }
    }
  };

  let extra = 0;
  for (const entry of list(order)) {
    const id = num(typeof entry === 'object' && entry !== null ? entry.id : entry);
    const talent = id !== null ? byId.get(id) : null;
    if (!talent) {
      problems.push(`there is no talent with id ${JSON.stringify(entry)}`);
      continue;
    }
    if (placed.length >= limit) { extra++; continue; }
    const why = blocked(talent, ranks, treePoints, byId);
    if (why) {
      waiting.push({ talent, why });
    } else {
      spend(talent);
      retry();
    }
  }
  // Points still waiting never became legal: they are left out.
  for (const w of waiting) problems.push(w.why);
  waiting = [];
  if (extra) problems.push(`the order has ${extra} more points than the ${limit} a character has`);
  if (placed.length < limit) problems.push(`only ${placed.length} of ${limit} points are placed`);
  return { order: placed, problems, ranks, treePoints, reordered };
}

// "31/20/0": points per tree, in the trees' order.
export function distribution(index, treePoints) {
  return index.trees.map((t) => treePoints.get(t) || 0).join('/');
}

// The data the addon gets for a build. `raw`: the AI's parsed answer.
export function shapeBuild(index, raw, checked) {
  const keyTalents = [];
  for (const k of list(raw?.keyTalents)) {
    const talent = index.byId.get(num(k?.id));
    if (talent && checked.ranks.get(talent.id) && keyTalents.length < 6) {
      keyTalents.push({ id: talent.id, name: talent.name, why: str(k.why, 240) });
    }
  }
  const respec = str(raw?.respec, 400);
  return {
    v: 1,
    kind: 'talents',
    name: str(raw?.name, 80),
    summary: str(raw?.summary, 600),
    spec: distribution(index, checked.treePoints),
    order: checked.order,
    keyTalents,
    notes: strings(raw?.notes, { max: 5, len: 300 }),
    respec: respec && !/^(null|none|no)$/i.test(respec) ? respec : undefined,
    points: index.pointsAtCap,
  };
}

// What the AI gets about the trees: everything the addon read.
export function talentsForPrompt(section) {
  if (!section || typeof section !== 'object') return null;
  return section;
}

// Just the talents taken, with what they do (rotation and gear requests).
export function takenTalents(section) {
  const out = [];
  for (const tree of list(section?.trees)) {
    const taken = list(tree?.talents).filter((t) => (num(t?.rank) || 0) > 0)
      .map((t) => ({ name: t.name, rank: `${t.rank}/${t.max}`, desc: t.desc }));
    if (taken.length) out.push({ tree: tree.name, points: tree.points, talents: taken });
  }
  return out.length ? out : null;
}
