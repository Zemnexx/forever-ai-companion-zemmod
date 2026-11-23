// Interactions: the AI reads the character's talents, spells and item effects
// looking for combinations stronger than they look. An idea that changes the
// numbers can carry a patch to the character's combat model, and the
// simulator measures it against the baseline: a claim with a number the AI
// did not make up.
import { num, round, str, strings, text, list } from './json.js';
import { runModel } from './rotation.js';

const MAX_IDEAS = 5;
const CONFIDENCE = ['high', 'medium', 'low'];

// Entries of `added` replace the ones of `base` with the same id.
function mergeById(base, added) {
  const out = list(base).map((x) => ({ ...x }));
  for (const item of list(added)) {
    if (!item || typeof item !== 'object') continue;
    const i = out.findIndex((x) => x.id !== undefined && x.id === item.id);
    if (i >= 0) out[i] = item;
    else out.push(item);
  }
  return out;
}

// The baseline model with an idea's changes applied (a new object).
export function applyIdea(base, patch) {
  const model = JSON.parse(JSON.stringify(base));
  if (!patch || typeof patch !== 'object') return model;
  model.player = model.player || {};
  model.player.modifiers = [...list(model.player.modifiers), ...list(patch.modifiers).filter((m) => m && typeof m === 'object')];
  model.buffs = mergeById(model.buffs, patch.buffs);
  model.procs = mergeById(model.procs, patch.procs);
  model.abilities = mergeById(model.abilities, patch.abilities);
  if (patch.stats && typeof patch.stats === 'object') {
    model.player.stats = { ...(model.player.stats || {}) };
    for (const [stat, delta] of Object.entries(patch.stats)) {
      const d = num(delta);
      if (d !== null) model.player.stats[stat] = (num(model.player.stats[stat]) || 0) + d;
    }
  }
  if (patch.rotation && typeof patch.rotation === 'object' && Array.isArray(patch.rotation.actions)) {
    model.rotations = [patch.rotation];
  }
  return model;
}

// Simulates an idea against the baseline with the same random numbers.
// Returns { base, value, pct, metric } or null when it could not be run.
// metric "tps": the baseline was a tank's, measured on threat per second.
export function measureIdea(base, patch, { iterations = 300, seed = 1, metric } = {}) {
  if (!base || !patch || typeof patch !== 'object' || !Object.keys(patch).length) return null;
  try {
    const tank = metric === 'tps';
    const before = runModel(base, { iterations, seed, weights: false, tank });
    const after = runModel(applyIdea(base, patch), { iterations, seed, weights: false, tank });
    if (before.fatal || after.fatal) return null;
    const b = before.sim.rotations[before.sim.best];
    const a = after.sim.rotations[after.sim.best];
    if (!b || !a || !(b.value > 0)) return null;
    return { base: round(b.value, 1), value: round(a.value, 1), pct: round((a.value / b.value - 1) * 100, 1), metric: b.metric };
  } catch {
    return null;
  }
}

// The data the addon gets. raw: the AI's parsed answer; base: the
// character's stored combat model, when there is one.
export function shapeIdeas(raw, base, opts = {}) {
  const ideas = [];
  for (const idea of list(raw?.ideas)) {
    const title = str(idea?.title, 100);
    const mechanism = text(idea?.mechanism, 900);
    if (!title || !mechanism) continue;
    const confidence = str(idea.confidence, 10).toLowerCase();
    const out = {
      title,
      mechanism,
      needs: {
        talents: strings(idea.needs?.talents, { max: 8, len: 80 }),
        items: strings(idea.needs?.items, { max: 8, len: 80 }),
        spells: strings(idea.needs?.spells, { max: 8, len: 80 }),
      },
      gain: text(idea.gain, 400),
      test: text(idea.test, 500),
      risks: text(idea.risks, 400),
      confidence: CONFIDENCE.includes(confidence) ? confidence : 'low',
    };
    const measured = base ? measureIdea(base, idea.sim, opts) : null;
    if (measured) out.measured = measured;
    ideas.push(out);
    if (ideas.length >= MAX_IDEAS) break;
  }
  return {
    v: 1,
    kind: 'discover',
    summary: text(raw?.summary, 700),
    ideas,
    baseline: base ? true : undefined,
  };
}
