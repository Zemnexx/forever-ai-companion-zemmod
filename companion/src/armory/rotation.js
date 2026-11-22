// Rotations: the AI writes a combat model of the character (model-spec.js)
// and candidate priority lists; the simulator (sim/engine.js) runs them and
// this module turns the results into what the addon shows: the ranked
// rotations as steps to follow, what each stat is worth, and a table of every
// ability's value per use, per second and per point of resource.
import { num, round, str, text, texts, list } from './json.js';
import { abilityTable, normalizeModel, simulate, statWeights } from './sim/engine.js';

const MAX_ROTATIONS = 4;
const MAX_STEPS = 14;
const MAX_TABLE = 14;

// A condition in a few words, for an action the AI left without a note.
const CONDITION_TEXT = {
  resourceAtLeast: (v) => `resource ${v}+`,
  resourceBelow: (v) => `resource under ${v}`,
  buffUp: (v) => `with ${v}`,
  buffDown: (v) => `when ${v} is not up`,
  buffStacksAtLeast: (v) => `at ${v?.n}+ stacks of ${v?.id}`,
  buffRemainsBelow: (v) => `when ${v?.id} has under ${v?.sec}s left`,
  cooldownUp: (v) => `when ${v} is ready`,
  cooldownRemainsAbove: (v) => `while ${v?.id} is over ${v?.sec}s away`,
  targetHealthBelow: (v) => `target under ${v}% health`,
  targetHealthAbove: (v) => `target above ${v}% health`,
  timeAtLeast: (v) => `after ${v}s`,
  timeRemainingBelow: (v) => `last ${v}s of the fight`,
  targetsAtLeast: (v) => `${v}+ targets`,
  swingTimerAbove: (v) => `more than ${v}s before the next swing`,
};
export function describeCondition(cond) {
  if (!cond || typeof cond !== 'object') return '';
  const parts = [];
  for (const [key, value] of Object.entries(cond)) {
    const text = CONDITION_TEXT[key];
    if (text) parts.push(text(Array.isArray(value) ? value.join(', ') : value));
  }
  return parts.join(', ').slice(0, 120);
}

// Normalizes and simulates a model. Never throws on a bad model: the problems
// say what the AI has to fix.
export function runModel(rawModel, { iterations = 300, seed = 1, weights = true } = {}) {
  const { model, problems, fatal } = normalizeModel(rawModel);
  if (fatal) return { model, problems, fatal: true };
  const sim = simulate(model, { iterations, seed });
  if (!sim.rotations.length) return { model, problems: [...problems, 'no rotation could be simulated'], fatal: true };
  const out = { model, problems, fatal: false, sim };
  // sim.best is a place in sim.rotations; each result's `index` is its
  // rotation's place in the model.
  if (weights) out.weights = statWeights(model, { rotation: sim.rotations[sim.best].index, iterations, seed });
  out.table = abilityTable(model);
  return out;
}

// The steps of a rotation as the player reads them. The notes come from the
// AI's own model (the simulator ignores them).
function stepsOf(rawRotation, abilities) {
  const steps = [];
  for (const action of list(rawRotation?.actions)) {
    const ability = abilities.get(str(action?.use, 60));
    if (!ability) continue;
    const step = { spell: ability.name, when: text(action.note, 160) || describeCondition(action.if) || undefined };
    if (num(ability.spellId)) step.spellId = num(ability.spellId);
    steps.push(step);
    if (steps.length >= MAX_STEPS) break;
  }
  return steps;
}

// Where the damage (or healing) came from, one line per name. A model may
// hold the same spell twice (Judgement, and Judgement on a stunned target):
// to the player that is one spell, so their shares are added up.
function breakdownOf(breakdown) {
  const byName = new Map();
  for (const b of list(breakdown)) {
    const name = str(b?.name, 60);
    if (!name) continue;
    const entry = byName.get(name) || { name, share: 0, perMinute: 0 };
    entry.share += Number(b.share) || 0;
    entry.perMinute += Number(b.perMinute) || 0;
    byName.set(name, entry);
  }
  // The simulator gives shares as 0..100.
  return [...byName.values()].filter((b) => b.share >= 1).sort((a, b) => b.share - a.share).slice(0, 8)
    .map((b) => ({ name: b.name, share: round(b.share, 1), perMinute: round(b.perMinute, 1) }));
}

// A stat whose measured worth is nothing, or less than nothing, was not
// measured: it is the dice of the simulation (haste "-0.05" on a 25 second
// fight). Such stats are left out instead of shown as findings.
const WORTH_SHOWING = 0.005;
function measured(perPoint) {
  const out = {};
  for (const [stat, v] of Object.entries(perPoint || {})) if (Number(v) >= WORTH_SHOWING) out[stat] = v;
  return out;
}

// One spell under two conditions is two abilities of the model with one
// name (Judgement, and Judgement on a stunned target). In a table of each
// ability on its own they are told apart by what their ids add to the name.
function tableNames(rows) {
  const count = new Map();
  for (const row of rows) count.set(row.name, (count.get(row.name) || 0) + 1);
  const plain = new Map();
  return rows.map((row) => {
    const name = str(row.name, 60);
    if (count.get(row.name) < 2) return name;
    const words = new Set(name.toLowerCase().split(/[^a-z0-9]+/));
    const extra = String(row.id ?? '').toLowerCase().split(/[^a-z0-9]+/).filter((w) => w && !words.has(w)).join(' ');
    if (extra) return `${name} (${extra})`;
    // The one whose id says nothing more is the spell as such; a second such one is numbered.
    const n = (plain.get(row.name) || 0) + 1;
    plain.set(row.name, n);
    return n > 1 ? `${name} (${n})` : name;
  });
}

// The data the addon gets. raw: the AI's parsed answer ({ summary,
// assumptions, notes, model }); run: runModel()'s result for raw.model.
export function shapeRotation(raw, run) {
  const { model, sim } = run;
  const abilities = new Map(list(model.abilities).map((a) => [a.id, a]));
  const rawRotations = list(raw?.model?.rotations);
  const rotations = sim.rotations.map((r, i) => {
    const source = rawRotations.find((x) => str(x?.name, 80) === r.name) || rawRotations[r.index ?? i] || model.rotations?.[r.index ?? i];
    return {
      name: str(r.name, 80) || `Rotation ${i + 1}`,
      value: round(r.value, 1),
      spread: round(r.stdev, 1),
      best: i === sim.best || undefined,
      steps: stepsOf(source, abilities),
      // The simulator gives shares and percentages as 0..100.
      breakdown: breakdownOf(r.breakdown),
      idle: round(r.idlePct, 1),
      autoAttack: r.autoAttackShare ? round(r.autoAttackShare, 1) : undefined,
      starved: r.resource?.starvedPct ? round(r.resource.starvedPct, 1) : undefined,
      emptyAt: num(r.resource?.emptyAt) !== null ? round(r.resource.emptyAt, 0) : undefined,
    };
  }).sort((a, b) => b.value - a.value).slice(0, MAX_ROTATIONS);

  const data = {
    v: 1,
    kind: 'rotation',
    summary: text(raw?.summary, 700),
    metric: sim.rotations[sim.best]?.metric || (model.kind === 'healing' ? 'hps' : 'dps'),
    rotations,
    fight: {
      duration: model.fight?.duration, targets: model.fight?.targets,
      targetLevel: model.fight?.targetLevel, targetArmor: model.fight?.targetArmor,
    },
    assumptions: texts(raw?.assumptions, { max: 6, len: 400 }),
    notes: texts(raw?.notes, { max: 5, len: 400 }),
  };
  if (run.problems.length) data.modelIssues = run.problems.length;
  const worth = measured(run.weights?.perPoint);
  if (Object.keys(worth).length) {
    const perPoint = {};
    const normalized = {};
    for (const [stat, v] of Object.entries(worth)) perPoint[stat] = round(v, 3);
    for (const [stat, v] of Object.entries(run.weights.normalized || {})) if (stat in worth) normalized[stat] = round(v, 2);
    data.weights = { reference: run.weights.reference, perPoint, normalized };
  }
  const rows = list(run.table).filter((row) => row.perUse > 0)
    .sort((a, b) => b.perSecond - a.perSecond).slice(0, MAX_TABLE);
  const names = tableNames(rows);
  const table = rows
    .map((row, i) => ({
      name: names[i], perUse: round(row.perUse, 0), perSecond: round(row.perSecond, 1),
      perResource: num(row.perResource) !== null ? round(row.perResource, 2) : undefined,
      castTime: num(row.castTime) ? round(row.castTime, 2) : undefined,
    }));
  if (table.length) data.table = table;
  return data;
}

// What is kept for later requests about the same character (store.js): the
// model with its best rotation only, and the measured weights.
export function keepFromRun(run) {
  const best = run.model.rotations?.[run.sim.rotations[run.sim.best]?.index ?? run.sim.best];
  return {
    model: { ...run.model, rotations: best ? [best] : [] },
    weights: run.weights ? { metric: run.weights.metric, reference: run.weights.reference, perPoint: measured(run.weights.perPoint) } : null,
    value: run.sim.rotations[run.sim.best]?.value ?? null,
  };
}
