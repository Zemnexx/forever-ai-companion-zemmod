// Calibration: how the character's abilities scale, measured by the addon
// from the character's own tooltips as their stats changed (Calibrate.lua in
// the Armory). The addon fits each tooltip number against attack power,
// spell power and healing power across its readings and sends what it could
// tell (armory_scaling). The AI is told to use those numbers in place of its
// own coefficients; after it answers, compareScaling() checks the model it
// wrote against them, and the result says which abilities agree.
//
// The section comes from the addon, but like every input it is read
// defensively: unknown fields are dropped and numbers are bounded.
import { num, round, str, list } from './json.js';
import { RULES } from './sim/engine.js';

export const SCALING_STATS = ['attackPower', 'rangedAttackPower', 'spellPower', 'healingPower'];
const KINDS = ['damage', 'heal', 'absorb', 'other'];
const STATUSES = ['scales', 'flat', 'ambiguous'];
const SCHOOLS = ['holy', 'fire', 'nature', 'frost', 'shadow', 'arcane'];
const MAX_ABILITIES = 30;
const MAX_EFFECTS = 4;
const MAX_TOTAL = 40;
// The addon needs this many readings for a verdict; fewer is not one.
const MIN_READINGS = 3;
const MAX_PER_POINT = 20;

const bounded = (v, lo, hi) => {
  const n = num(v);
  return n !== null && n >= lo && n <= hi ? n : null;
};
const stat = (v) => (SCALING_STATS.includes(v) ? v : null);
const school = (v) => (SCHOOLS.includes(v) ? v : undefined);

// { spellPower: 0.43 } with known stats and positive, bounded slopes only.
function perPoint(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const out = {};
  for (const [k, v] of Object.entries(raw)) {
    const n = bounded(v, 0, MAX_PER_POINT);
    if (stat(k) && n !== null && n > 0) out[k] = round(n, 4);
  }
  return Object.keys(out).length ? out : null;
}

function shapeEffect(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const status = STATUSES.includes(raw.status) ? raw.status : null;
  const readings = bounded(raw.readings, MIN_READINGS, 1000);
  if (!status || readings === null) return null;
  const e = {
    index: bounded(raw.index, 1, 10) ?? undefined,
    kind: KINDS.includes(raw.kind) ? raw.kind : 'other',
    text: str(raw.text, 60) || undefined,
    value: bounded(raw.value, 0, 1e7) ?? undefined,
    status,
    readings: Math.round(readings),
  };
  if (raw.overTime === true) e.overTime = true;
  const level = bounded(raw.level, 1, 100);
  if (level !== null) e.level = Math.round(level);
  if (status === 'scales') {
    e.perPoint = perPoint(raw.perPoint);
    if (!e.perPoint) return null;
    const base = bounded(raw.base, -1e6, 1e6);
    if (base !== null) e.base = round(base, 1);
    const margin = bounded(raw.margin, 0, MAX_PER_POINT);
    if (margin !== null) e.margin = round(margin, 4);
    const rms = bounded(raw.rms, 0, 1e4);
    if (rms !== null) e.rms = round(rms, 2);
    e.school = school(raw.school);
    if (raw.dropped === 1) e.dropped = 1;
  } else if (status === 'flat') {
    e.tested = [...new Set(list(raw.tested).map(stat).filter(Boolean))];
    if (!e.tested.length) return null;
  } else {
    e.candidates = list(raw.candidates).map((c) => {
      const s = stat(c?.stat);
      const n = bounded(c?.perPoint, 0, MAX_PER_POINT);
      return s && n !== null ? { stat: s, school: school(c.school), perPoint: round(n, 4) } : null;
    }).filter(Boolean).slice(0, 4);
    if (e.candidates.length < 2) return null;
  }
  return e;
}

// The addon's section, validated and bounded, or null when nothing in it can
// be used (an analysis then goes exactly as without it).
export function shapeScaling(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const abilities = [];
  let total = 0;
  for (const a of list(raw.abilities)) {
    const name = str(a?.name, 60);
    if (!name || abilities.length >= MAX_ABILITIES || total >= MAX_TOTAL) continue;
    const effects = list(a.effects).map(shapeEffect).filter(Boolean).slice(0, Math.min(MAX_EFFECTS, MAX_TOTAL - total));
    if (!effects.length) continue;
    const ability = { name, effects };
    const id = bounded(a.id, 1, 1e8);
    if (id !== null) ability.id = Math.round(id);
    const rank = str(a.rank, 30);
    if (rank) ability.rank = rank;
    abilities.push(ability);
    total += effects.length;
  }
  if (!abilities.length) return null;
  const readings = bounded(raw.readings, 0, 1000);
  return { readings: readings === null ? undefined : Math.round(readings), abilities };
}

// The comparison with the model --------------------------------------------------

const HEALS = ['heal', 'absorb'];

// The part of a model ability a measured number is about: its periodic part
// for a number over time, else its direct damage, else whichever it has.
function partOf(ability, effect) {
  if (effect.overTime && ability.dot) return 'dot';
  if (ability.damage) return 'damage';
  return ability.dot ? 'dot' : null;
}

const ticksOf = (dot) => Math.max(1, Math.floor(dot.duration / dot.interval + 1e-9));

// How many points of this part one point of `stat` adds in the simulator
// (sim/engine.js): attack power for melee, ranged attack power for ranged,
// healing power for heals, spell power for the rest; a weapon's share of an
// attack adds attack power as a weapon hit does. A periodic part is summed
// over its ticks, as a tooltip states it.
export function modelCoefficient(model, ability, part, s) {
  const heal = ability.type === 'heal' || model.kind === 'healing';
  const ranged = ability.type === 'ranged';
  if (part === 'dot') {
    const d = ability.dot;
    const per = s === 'spellPower' ? (heal ? 0 : d.spCoefPerTick) : s === 'healingPower' ? (heal ? d.spCoefPerTick : 0)
      : s === 'attackPower' ? (ranged ? 0 : d.apCoefPerTick) : (ranged ? d.apCoefPerTick : 0);
    return per * ticksOf(d);
  }
  const d = ability.damage;
  if (s === 'spellPower') return heal ? 0 : d.spCoef;
  if (s === 'healingPower') return heal ? d.spCoef : 0;
  if ((s === 'attackPower') === ranged) return 0;
  let ap = d.apCoef;
  const weapon = model.player?.weapons?.[d.weapon];
  if (d.weaponPct > 0 && weapon) ap += (d.weaponPct / 100) * ((d.normalizedSpeed > 0 ? d.normalizedSpeed : weapon.speed) / RULES.AP_PER_DPS);
  return ap;
}

// What the model says the part does at the model's own stats, to tell which
// of an ability's measured numbers it stands for.
function modelValue(model, ability, part) {
  const stats = model.player?.stats || {};
  let v = part === 'dot' ? ability.dot.tickDamage * ticksOf(ability.dot) : (ability.damage.min + ability.damage.max) / 2;
  for (const s of SCALING_STATS) v += modelCoefficient(model, ability, part, s) * (num(stats[s]) || 0);
  return v;
}

// A measured coefficient and the model's agree when they are this close:
// a little for the rounding in tooltips, more for large coefficients.
export function agree(model, measured, margin = 0) {
  return Math.abs(model - measured) <= Math.max(0.02, 0.15 * Math.abs(measured), 2 * (margin || 0));
}

// Every measured number the AI was given, and what the model it wrote does
// with it: { entries: [ { name, kind, stat, measured, flat, level, model,
// agrees } ] }. "model" is null when no ability of the model stands for that
// number. Nothing in the model is changed here.
export function compareScaling(model, scaling) {
  if (!scaling || !model) return null;
  const abilities = list(model.abilities);
  const entries = [];
  for (const measuredAbility of scaling.abilities) {
    const name = measuredAbility.name.toLowerCase();
    const effects = measuredAbility.effects.filter((e) => e.status !== 'ambiguous');
    // Each model ability with this name (or spell id) stands for the measured
    // number of its kind closest to what it does.
    const matched = new Map();
    for (const a of abilities) {
      if (String(a.name || '').toLowerCase() !== name && !(measuredAbility.id && a.spellId === measuredAbility.id)) continue;
      const heal = a.type === 'heal' || model.kind === 'healing';
      let best = null;
      for (const e of effects) {
        if (HEALS.includes(e.kind) !== heal) continue;
        const part = partOf(a, e);
        if (!part) continue;
        const distance = e.value === undefined ? Infinity : Math.abs(modelValue(model, a, part) - e.value);
        if (!best || distance < best.distance) best = { e, part, distance };
      }
      if (best && !matched.has(best.e)) matched.set(best.e, { a, part: best.part });
    }
    for (const e of effects) {
      const m = matched.get(e);
      const stats = e.status === 'scales' ? Object.entries(e.perPoint) : e.tested.map((s) => [s, 0]);
      for (const [s, measured] of stats) {
        const entry = { name: measuredAbility.name, kind: e.kind, stat: s, measured };
        if (e.status === 'flat') entry.flat = true;
        if (e.level) entry.level = e.level;
        if (m) {
          const coef = modelCoefficient(model, m.a, m.part, s);
          entry.model = round(coef, 3);
          entry.agrees = agree(coef, measured, e.margin);
        } else {
          entry.model = null;
        }
        entries.push(entry);
      }
    }
  }
  return entries.length ? { entries: entries.slice(0, 60) } : null;
}
