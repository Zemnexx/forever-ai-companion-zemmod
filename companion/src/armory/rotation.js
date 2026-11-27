// Rotations: the AI writes a combat model of the character (model-spec.js)
// and candidate priority lists; the simulator (sim/engine.js) runs them and
// this module turns the results into what the addon shows: the ranked
// rotations as steps to follow, what each stat is worth, and a table of every
// ability's value per use, per second and per point of resource.
import { num, round, str, text, texts, list } from './json.js';
import { abilityTable, normalizeModel, simulate, statWeights, survival } from './sim/engine.js';
import { oneButtonFor } from './onebutton.js';

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
  usedOnTarget: (v) => `once ${v} was used on the target`,
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

// Two kinds of fight: "short", an ordinary enemy of the character's level,
// and "long", an elite or a boss. The model's own fight is the one of the
// player's goal; the other kind is derived from it, so every candidate is
// also ranked in the fight the player meets the rest of the time.
export const FIGHT_KINDS = ['short', 'long'];
export const fightKind = (goal) => (goal === 'dungeons' || goal === 'raids' ? 'long' : 'short');
const MAX_TARGET_LEVEL = 63;

/**
 * The other kind of fight than the model's (primary: the normalized
 * fight; level: the player's; goal: the request's). Short: 25 seconds at the
 * character's level. Long: 60 seconds 2 levels above, or with the goal
 * "raids" 180 seconds 3 levels above. Armor follows the target's level (0
 * stays 0); targets and the execute phase stay as they are.
 */
export function otherFight(primary, { level = 60, goal = 'leveling' } = {}) {
  const kind = fightKind(goal) === 'long' ? 'short' : 'long';
  const raid = goal === 'raids';
  const duration = kind === 'short' ? 25 : raid ? 180 : 60;
  const targetLevel = Math.min(MAX_TARGET_LEVEL, level + (kind === 'short' ? 0 : raid ? 3 : 2));
  const armor = num(primary?.targetArmor) || 0;
  const from = num(primary?.targetLevel) || level;
  return {
    kind, duration, targets: primary?.targets ?? 1, targetLevel,
    targetArmor: armor > 0 ? Math.round((armor * targetLevel) / Math.max(1, from)) : 0,
    executePct: primary?.executePct ?? 20,
  };
}
const withoutKind = ({ kind, ...fight }) => fight;

// Normalizes and simulates a model. Never throws on a bad model: the problems
// say what the AI has to fix. tank: rank by threat per second, and estimate
// survival against the model's "enemy" with the defensive numbers the game
// gave (defense: the addon's armory_combat). goal: the request's, which says
// what kind of fight the model's own is (the other kind is simulated too).
export function runModel(rawModel, { iterations = 300, seed = 1, weights = true, tank = false, defense = null, goal = 'leveling' } = {}) {
  const { model, problems, fatal, oneButtonProblems = [] } = normalizeModel(rawModel);
  if (fatal) return { model, problems, fatal: true };
  const metric = tank ? 'tps' : undefined;
  const opts = { iterations, seed, metric };
  const sim = simulate(model, opts);
  if (!sim.rotations.length) return { model, problems: [...problems, 'no rotation could be simulated'], fatal: true };
  const out = { model, problems, oneButtonProblems, fatal: false, sim, opts, kind: fightKind(goal) };
  // The same candidates in the other kind of fight: ranked only, no weights.
  const fight = otherFight(model.fight, { level: model.player.level, goal });
  const otherSim = simulate({ ...model, fight: withoutKind(fight) }, opts);
  if (otherSim.rotations.length) out.other = { fight, sim: otherSim };
  // sim.best is a place in sim.rotations; each result's `index` is its
  // rotation's place in the model.
  if (weights) out.weights = statWeights(model, { rotation: sim.rotations[sim.best].index, iterations, seed, metric });
  out.table = abilityTable(model, { metric });
  if (tank) {
    out.tank = true;
    if (!model.enemy) out.problems = [...problems, '"enemy" is missing: a tank\'s survival cannot be estimated without the enemy\'s melee hit and attack speed'];
    out.survival = survival(defense, model.enemy, { level: model.player.level });
  }
  return out;
}

// The survival estimate as the addon shows it: rounded, shares of the
// incoming damage in percent, and what each defensive stat is worth.
const SHARE = (part, whole) => (whole > 0 ? round((100 * part) / whole, 1) : 0);
function shapeSurvival(s) {
  if (!s) return undefined;
  const out = {};
  if (s.missing?.length) out.missing = s.missing;
  if (num(s.taken) === null) return out;
  out.enemy = {
    level: s.enemy.level, meleeHit: round(s.enemy.meleeHit, 0), attackSpeed: round(s.enemy.attackSpeed, 2),
    magicDps: s.enemy.magicDps ? round(s.enemy.magicDps, 1) : undefined,
  };
  out.taken = round(s.taken, 1);
  out.incoming = round(s.incoming, 1);
  out.mitigated = SHARE(s.incoming - s.taken, s.incoming);
  out.armor = SHARE(s.armor, s.incoming);
  out.avoided = SHARE(s.avoided, s.incoming);
  out.blocked = SHARE(s.blocked, s.incoming);
  out.armorReduction = round(100 * s.armorReduction, 1);
  if (s.enemy.meleeHit > 0) {
    out.table = {};
    for (const [k, v] of Object.entries(s.table)) out.table[k] = round(v, 1);
  }
  if (num(s.health) !== null) out.health = round(s.health, 0);
  if (num(s.effectiveHealth) !== null) out.effectiveHealth = round(s.effectiveHealth, 0);
  if (num(s.timeToDie) !== null) out.timeToDie = round(s.timeToDie, 1);
  const worth = [];
  for (const [stat, w] of Object.entries(s.worth || {})) {
    const row = { stat, amount: w.amount, taken: round(w.taken, 2) };
    if (num(w.time) !== null) row.time = round(w.time, 2);
    worth.push(row);
  }
  if (worth.length) out.worth = worth;
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

// What to have on before a fight: the player's own buffs, auras, stances. The
// AI names them; only a spell the character really knows (the spellbook the
// addon read) is kept, under the game's own name and with its id, so the
// addon can show its icon and whether it is on right now.
const MAX_BUFFS = 6;
export function shapeBuffs(raw, spells) {
  const known = new Map();
  for (const s of list(spells)) {
    const name = str(s?.name, 80);
    if (name && !known.has(name.toLowerCase())) known.set(name.toLowerCase(), { name, id: num(s.id) });
  }
  const out = [];
  for (const b of list(raw)) {
    const spell = known.get(str(typeof b === 'string' ? b : b?.name, 80).toLowerCase());
    if (!spell || out.some((x) => x.name === spell.name)) continue;
    const buff = { name: spell.name };
    if (spell.id !== null) buff.spellId = spell.id;
    const why = text(b?.why, 160);
    if (why) buff.why = why;
    if (b?.counted === true) buff.counted = true;
    out.push(buff);
    if (out.length >= MAX_BUFFS) break;
  }
  return out;
}

// The best rotation of a simulation, from the model the simulator ran.
const bestOf = (model, sim) => model.rotations?.[sim.rotations[sim.best]?.index ?? sim.best] || null;

/**
 * The One Button list of each fight (onebutton.js): the AI's list for that
 * kind, or the best candidate of that fight, cleaned and measured in that
 * fight. Healing analyses get none: One Button suggests attacks. Returns {
 * primary, other, problems }: problems are what was wrong with the AI's lists
 * (said to the AI only if the model is sent back anyway).
 */
export function oneButtonLists(run, { spells = [], auras = [], context = 'st' } = {}) {
  const out = { primary: null, other: null, problems: [] };
  if (run.model.kind === 'healing') return out;
  out.problems.push(...(run.oneButtonProblems || []));
  const lists = [['primary', run.kind, run.model.fight, run.sim]];
  if (run.other) lists.push(['other', run.other.fight.kind, withoutKind(run.other.fight), run.other.sim]);
  for (const [place, kind, fight, sim] of lists) {
    const measure = (actions) => {
      const measured = simulate({ ...run.model, fight, rotations: [{ name: 'One Button', actions }] }, run.opts);
      return round(measured.rotations[0]?.value ?? 0, 1);
    };
    const made = oneButtonFor(run.model, { kind, best: bestOf(run.model, sim), spells, auras, context, measure });
    out[place] = made.list;
    out.problems.push(...made.problems.map((p) => `oneButton.${kind}: ${p}`));
  }
  return out;
}

// One rotation's result as the addon shows it. source: the AI's rotation
// (for the steps and their notes).
function shapeEntry(r, i, { best, source, abilities, tank }) {
  return {
    name: str(r.name, 80) || `Rotation ${i + 1}`,
    value: round(r.value, 1),
    spread: round(r.stdev, 1),
    // A tank's rotation is ranked by threat; its damage is still worth knowing.
    damage: tank ? round(r.dps, 1) : undefined,
    best: best || undefined,
    steps: stepsOf(source, abilities),
    // The simulator gives shares and percentages as 0..100.
    breakdown: breakdownOf(r.breakdown),
    idle: round(r.idlePct, 1),
    autoAttack: r.autoAttackShare ? round(r.autoAttackShare, 1) : undefined,
    starved: r.resource?.starvedPct ? round(r.resource.starvedPct, 1) : undefined,
    emptyAt: num(r.resource?.emptyAt) !== null ? round(r.resource.emptyAt, 0) : undefined,
  };
}

// The same candidates in the other kind of fight, best first: the best in
// full, the others by their numbers only (the steps are those of the
// primary fight's list).
function shapeOther(run, entryOf, oneButton) {
  const { fight, sim } = run.other;
  const ranked = sim.rotations.map((r, i) => ({ r, i })).sort((a, b) => b.r.value - a.r.value).slice(0, MAX_ROTATIONS);
  const out = {
    kind: fight.kind, duration: fight.duration, targets: fight.targets, targetLevel: fight.targetLevel, targetArmor: fight.targetArmor,
    rotations: ranked.map(({ r, i }, n) => (n === 0 ? entryOf(r, i, true)
      : { name: str(r.name, 80) || `Rotation ${i + 1}`, value: round(r.value, 1), spread: round(r.stdev, 1) })),
  };
  const best = sim.rotations[sim.best];
  if (best && best.index === run.sim.rotations[run.sim.best]?.index) out.sameBest = true;
  if (oneButton) out.oneButton = oneButton;
  return out;
}

// The data the addon gets. raw: the AI's parsed answer ({ summary,
// assumptions, notes, model }); run: runModel()'s result for raw.model.
// context: "aoe" when the analysis was asked for several enemies, else "st"
// (the list a One Button profile fills). auras: the buffs the addon saw on
// the character. lists: oneButtonLists() already made for this run.
export function shapeRotation(raw, run, { spells = [], auras = [], context = 'st', lists = null } = {}) {
  const { model, sim } = run;
  const abilities = new Map(list(model.abilities).map((a) => [a.id, a]));
  const rawRotations = list(raw?.model?.rotations);
  const entryOf = (r, i, best) => {
    const source = rawRotations.find((x) => str(x?.name, 80) === r.name) || rawRotations[r.index ?? i] || model.rotations?.[r.index ?? i];
    return shapeEntry(r, i, { best, source, abilities, tank: run.tank });
  };
  const rotations = sim.rotations.map((r, i) => entryOf(r, i, i === sim.best))
    .sort((a, b) => b.value - a.value).slice(0, MAX_ROTATIONS);

  const data = {
    v: 1,
    kind: 'rotation',
    summary: text(raw?.summary, 700),
    metric: sim.rotations[sim.best]?.metric || (model.kind === 'healing' ? 'hps' : 'dps'),
    rotations,
    fight: {
      kind: run.kind || 'short', duration: model.fight?.duration, targets: model.fight?.targets,
      targetLevel: model.fight?.targetLevel, targetArmor: model.fight?.targetArmor,
    },
    assumptions: texts(raw?.assumptions, { max: 6, len: 400 }),
    notes: texts(raw?.notes, { max: 5, len: 400 }),
  };
  if (run.tank) {
    const shaped = shapeSurvival(run.survival);
    if (shaped) data.survival = shaped;
  }
  const buffs = shapeBuffs(raw?.buffs, spells);
  if (buffs.length) data.buffs = buffs;
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
  // A Forever One Button priority list per fight (onebutton.js).
  const made = lists || oneButtonLists(run, { spells, auras, context });
  if (made.primary) data.oneButton = made.primary;
  if (run.other) data.otherFight = shapeOther(run, entryOf, made.other);
  return data;
}

// What one answer may weigh (index.js) is kept by trimming the other fight
// first: its best candidate's breakdown, then the other candidates, then its
// best candidate's steps, then its One Button lines left out. data is
// changed in place.
export function fitRotation(data, maxBytes) {
  const size = () => JSON.stringify(data).length;
  const other = data.otherFight;
  if (!other || size() <= maxBytes) return data;
  const [best] = other.rotations;
  const steps = [
    () => { if (best?.breakdown) best.breakdown = best.breakdown.slice(0, 3); },
    () => { other.rotations = other.rotations.slice(0, 2); },
    () => { other.rotations = other.rotations.slice(0, 1); },
    () => { if (best) best.steps = best.steps.slice(0, 6); },
    () => { if (other.oneButton) delete other.oneButton.left; },
  ];
  for (const step of steps) {
    step();
    if (size() <= maxBytes) break;
  }
  return data;
}

// What is kept for later requests about the same character (store.js): the
// model with its best rotation only, and the measured weights. For a tank the
// weights are on threat, and what each defensive stat is worth comes along.
export function keepFromRun(run) {
  const best = run.model.rotations?.[run.sim.rotations[run.sim.best]?.index ?? run.sim.best];
  const weights = run.weights ? { metric: run.weights.metric, reference: run.weights.reference, perPoint: measured(run.weights.perPoint) } : null;
  const worth = run.tank ? shapeSurvival(run.survival)?.worth : undefined;
  if (weights && worth) weights.survival = worth;
  // The One Button lists are a by-product: not kept for later requests.
  const { oneButton, ...model } = run.model;
  return {
    model: { ...model, rotations: best ? [best] : [] },
    weights,
    value: run.sim.rotations[run.sim.best]?.value ?? null,
    metric: run.sim.rotations[run.sim.best]?.metric,
  };
}
