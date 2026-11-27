// Deterministic combat simulator for the combat model in ../model-spec.js
// (MODEL_SPEC is the contract). normalizeModel repairs and validates what the
// AI wrote, simulate runs every rotation as an event-driven fight, statWeights
// re-runs it with one stat raised at a time (common random numbers), and
// abilityTable gives analytic expected values per ability use.
//
// Conventions: every percentage in inputs and outputs is a whole number
// (10 = 10%); chances in the model ("chance") are 0..1. Time is in seconds.

import { WEIGHT_STATS } from '../model-spec.js';

// Classic-style combat rules. Every tunable constant lives here.
export const RULES = Object.freeze({
  // Global cooldown: seconds from the start of a cast. Cast haste shortens a
  // spell's (or heal's) GCD down to GCD_MIN; melee and ranged GCDs are fixed.
  GCD_DEFAULT: 1.5,
  GCD_MIN: 1.0,
  OFF_GCD_TIME: 1.0, // abilityTable: time charged to one use of an off-GCD ability
  // Levels the target is above the player, clamped to 0..MAX_LEVEL_DIFF.
  MAX_LEVEL_DIFF: 3,
  // Attack table (percent), indexed by level difference 0..3.
  MELEE_MISS: [5, 6, 7, 8], // white and yellow melee/ranged miss
  DUAL_WIELD_MISS: 19, // extra white miss while wielding two weapons
  DODGE_BASE: 5, // melee only; attacking from behind: no parry, no block
  DODGE_PER_LEVEL: 0.5,
  GLANCE_BASE: 10, // white melee only
  GLANCE_PER_LEVEL: 10,
  GLANCE_DAMAGE_BASE: 0.95, // damage multiplier = base - perLevel * d
  GLANCE_DAMAGE_PER_LEVEL: 0.1,
  GLANCE_DAMAGE_MIN: 0.5,
  CRIT_SUPPRESSION_PER_LEVEL: 1, // melee/ranged crit lost per level of difference
  CRIT_SUPPRESSION_AT_MAX: 1.8, // extra crit lost at the maximum difference
  SPELL_MISS: [4, 5, 6, 17],
  SPELL_MISS_FLOOR: 1, // spell hit can never remove the last 1%
  // Weapons: one point of weapon DPS per AP_PER_DPS attack power.
  AP_PER_DPS: 14,
  OFF_HAND_DAMAGE: 0.5,
  // Armor: DR = armor / (armor + ARMOR_BASE + ARMOR_PER_LEVEL * L'), where
  // L' = L below ARMOR_HIGH_LEVEL and L + slope * (L - 59) from it.
  ARMOR_BASE: 400,
  ARMOR_PER_LEVEL: 85,
  ARMOR_HIGH_LEVEL: 60,
  ARMOR_HIGH_LEVEL_SLOPE: 4.5,
  ARMOR_CAP: 0.75,
  // A melee or ranged ability that misses or is dodged still costs this
  // fraction of its cost (the rest is refunded). Spells pay in full.
  MISSED_ABILITY_COST: 0.2,
  // "ppm" procs on a trigger without a weapon (spells) use this speed.
  PPM_FALLBACK_SPEED: 2.0,
  // Event loop: while idle and blocked only by a condition (target health,
  // time), decisions are re-checked this often.
  IDLE_POLL: 0.1,
  // "usedOnTarget": how long a use counts, as Forever One Button counts the
  // player's own casts on a target (Engine/Dots.lua DEFAULT_STACKING).
  USED_ON_TARGET_SEC: 30,
  MAX_ACTIONS_PER_DECISION: 32,
  MAX_EVENTS_PER_FIGHT: 500000,
  EPS: 1e-9,
  // Stat weights: how far each stat is raised, and how many standard errors
  // of the paired difference a weight must clear not to be reported as 0.
  WEIGHT_DELTA: {
    attackPower: 100, rangedAttackPower: 100, spellPower: 100, healingPower: 100,
    critPct: 2, rangedCritPct: 2, spellCritPct: 2, hitPct: 2, spellHitPct: 2, hastePct: 2,
  },
  PRIMARY_DELTA: 50,
  NOISE_SIGMAS: 2,
});

// Survival for tanks (see survival() below): how an enemy's melee swing
// resolves against the player. These are WoW Classic's rules, NOT confirmed
// for WoW Forever: Forever may have changed any of them.
export const DEFENSE = Object.freeze({
  SKILL_PER_LEVEL: 5, // weapon skill and defense skill: 5 points per level
  // Each point of the enemy's weapon skill over the player's defense moves
  // this many percent: less miss, dodge, parry and block, more crit.
  PER_SKILL: 0.04,
  MOB_MISS: 5, // % an enemy misses a defender of equal skill
  MOB_CRIT: 5, // % an enemy crits a defender of equal skill
  MOB_CRIT_MULT: 2,
  // Crushing blows: only from an enemy this many levels above the player, with
  // chance = CRUSH_PER_SKILL * (skill difference) - CRUSH_OFFSET percent: 15%
  // for a boss 3 levels above a character with no extra defense, none once
  // defense closes the gap to 7 points.
  CRUSH_MIN_LEVEL_DIFF: 3,
  CRUSH_PER_SKILL: 2,
  CRUSH_OFFSET: 15,
  CRUSH_MULT: 1.5,
  // Health per point of stamina (Classic: 10, ignoring the first 20 points).
  HEALTH_PER_STAMINA: 10,
  // How much of each defensive stat is added to measure what it is worth.
  WORTH: { armor: 100, dodgePct: 1, parryPct: 1, blockPct: 1, blockValue: 10, stamina: 10 },
});

const SCHOOLS = ['physical', 'holy', 'fire', 'nature', 'frost', 'shadow', 'arcane'];
const TYPES = ['melee', 'ranged', 'spell', 'heal'];
const MOD_TYPES = [...TYPES, 'auto'];
const STAT_KEYS = ['attackPower', 'rangedAttackPower', 'spellPower', 'healingPower',
  'critPct', 'rangedCritPct', 'spellCritPct', 'hitPct', 'spellHitPct', 'hastePct'];
const MOD_STATS = ['attackPower', 'attackPowerPct', 'spellPower', 'spellPowerPct', 'critPct', 'spellCritPct',
  'hitPct', 'spellHitPct', 'hastePct', 'castHastePct', 'damagePct', 'critDamagePct',
  'costPct', 'armorIgnorePct', 'targetArmor', 'resourceRegenPct'];
const FLAT_MOD_STATS = ['attackPower', 'spellPower', 'targetArmor'];
const TRIGGERS = ['meleeHit', 'meleeCrit', 'swing', 'rangedHit', 'spellHit', 'spellCrit', 'spellCast',
  'anyHit', 'anyCrit', 'dotTick', 'abilityUse'];
const CHARGE_ON = ['swing', 'ability', 'spell'];
const WEAPON_SLOTS = ['mainHand', 'offHand', 'ranged'];
const FIGHT_KINDS = ['short', 'long'];
const NUM_CONDS = ['resourceAtLeast', 'resourceBelow', 'targetHealthBelow', 'targetHealthAbove',
  'timeAtLeast', 'timeRemainingBelow', 'targetsAtLeast', 'swingTimerAbove'];
// Extra statConversions targets besides player.stats (see statWeights).
const RESOURCE_TARGETS = ['mana', 'regenPerSec', 'mp5'];

// ---------------------------------------------------------------- helpers

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const asObj = (v) => (isObj(v) ? v : {});
const asList = (v) => (Array.isArray(v) ? v : v == null ? [] : [v]);
const quote = (v) => { try { return String(JSON.stringify(v)).slice(0, 40); } catch { return '?'; } };

function toNum(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : NaN;
  if (typeof v === 'string' && v.trim() !== '') return Number(v.trim().replace(/%$/, ''));
  return NaN;
}

function matchEnum(v, list) {
  if (typeof v !== 'string') return null;
  const low = v.trim().toLowerCase();
  return list.find((x) => x.toLowerCase() === low) || null;
}

/** Seeded PRNG: returns a function giving floats in [0, 1). */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// One independent stream per (seed, iteration, source): a stat change moves
// no roll of any other source, so paired runs stay aligned.
function streamSeed(seed, iter, key) {
  let h = Math.imul((seed >>> 0) ^ 0x9e3779b9, 0x85ebca6b) >>> 0;
  h = Math.imul(h ^ (iter + 0x7f4a7c15), 0xc2b2ae35) >>> 0;
  h ^= h >>> 13;
  h = Math.imul(h ^ (key + 0x165667b1), 0x27d4eb2f) >>> 0;
  return (h ^ (h >>> 16)) >>> 0;
}

/** Fraction of physical damage removed by armor, for an attacker of this level. */
export function armorReduction(armor, attackerLevel) {
  const a = Math.max(0, armor);
  const L = attackerLevel;
  const eff = L >= RULES.ARMOR_HIGH_LEVEL ? L + RULES.ARMOR_HIGH_LEVEL_SLOPE * (L - 59) : L;
  return Math.min(RULES.ARMOR_CAP, a / (a + RULES.ARMOR_BASE + RULES.ARMOR_PER_LEVEL * eff));
}

// --------------------------------------------------------- normalization

function reader(problems) {
  const num = (v, def, lo, hi, label) => {
    if (v === undefined || v === null || v === '') return def;
    const n = toNum(v);
    if (Number.isNaN(n)) { problems.push(`${label} is not a number (${quote(v)}): using ${def}`); return def; }
    if (n < lo || n > hi) {
      const c = clamp(n, lo, hi);
      problems.push(`${label} ${n} is out of range: clamped to ${c}`);
      return c;
    }
    return n;
  };
  const bool = (v, def) => {
    if (v === true || v === 'true' || v === 1 || v === '1') return true;
    if (v === false || v === 'false' || v === 0 || v === '0') return false;
    return def;
  };
  return { num, bool };
}

// Finds an id by exact id, then case-insensitive id, then name.
function resolver(list) {
  const exact = new Map(), lower = new Map(), names = new Map();
  for (const e of list) {
    exact.set(e.id, e.id);
    if (!lower.has(e.id.toLowerCase())) lower.set(e.id.toLowerCase(), e.id);
    if (e.name && !names.has(e.name.toLowerCase())) names.set(e.name.toLowerCase(), e.id);
  }
  return (ref) => {
    if (typeof ref !== 'string' && typeof ref !== 'number') return null;
    const s = String(ref).trim();
    return exact.get(s) || lower.get(s.toLowerCase()) || names.get(s.toLowerCase()) || null;
  };
}

// Gives every entry a unique id; drops non-objects and later duplicates.
function withIds(list, kind, problems) {
  const out = [], seen = new Set();
  asList(list).forEach((e, i) => {
    if (!isObj(e)) { problems.push(`${kind} ${i + 1} is not an object: dropped`); return; }
    let id = e.id != null ? String(e.id).trim() : '';
    if (!id && e.name) id = String(e.name).trim().toLowerCase().replace(/[^a-z0-9]+/g, '_');
    if (!id) { id = `${kind}_${i + 1}`; problems.push(`${kind} ${i + 1} has no id: using "${id}"`); }
    if (kind === 'ability' && id === 'auto') { id = 'auto_ability'; problems.push('ability id "auto" is reserved for auto attacks: renamed "auto_ability"'); }
    if (seen.has(id)) { problems.push(`${kind} ids must be unique: "${id}"`); return; }
    seen.add(id);
    out.push({ raw: e, id, name: e.name != null ? String(e.name) : id });
  });
  return out;
}

function normMods(list, label, R, problems) {
  const out = [];
  asList(list).forEach((m, i) => {
    const where = `${label} modifier ${i + 1}`;
    if (!isObj(m)) { problems.push(`${where} is not an object: dropped`); return; }
    const stat = matchEnum(m.stat, MOD_STATS);
    if (!stat) { problems.push(`${where} has unknown stat ${quote(m.stat)}: dropped`); return; }
    const flat = FLAT_MOD_STATS.includes(stat);
    const value = R.num(m.value, NaN, flat ? -1e5 : -100, flat ? 1e5 : 10000, `${where} value`);
    if (Number.isNaN(value)) { problems.push(`${where} has no value: dropped`); return; }
    const mod = { stat, value };
    if (m.school != null) {
      const s = matchEnum(m.school, SCHOOLS);
      if (s) mod.school = s; else problems.push(`${where} has unknown school ${quote(m.school)}: filter ignored`);
    }
    if (m.types != null) {
      const types = asList(m.types).map((t) => matchEnum(t, MOD_TYPES)).filter(Boolean);
      if (types.length) mod.types = types; else problems.push(`${where} has no valid types: filter ignored`);
    }
    if (m.abilities != null) mod.abilities = asList(m.abilities).map((a) => String(a));
    out.push(mod);
  });
  return out;
}

// Ability filters on modifiers and procs are resolved once abilities are known.
function resolveFilter(ids, findAb, where, problems) {
  if (!ids) return undefined;
  const out = [];
  for (const ref of ids) {
    if (String(ref).toLowerCase() === 'auto') { out.push('auto'); continue; }
    const id = findAb(ref);
    if (id) out.push(id); else problems.push(`${where} filters on unknown ability ${quote(ref)}`);
  }
  return out.length ? out : ['__none__'];
}

function normWeapon(w, label, R, problems) {
  if (w == null || w === false || w === 0) return null;
  if (!isObj(w)) { problems.push(`${label} is not an object: ignored`); return null; }
  const speed = R.num(w.speed, 0, 0, 10, `${label}.speed`);
  if (!(speed > 0)) { problems.push(`${label} has no speed: ignored`); return null; }
  let min = R.num(w.min, 0, 0, 1e5, `${label}.min`);
  let max = R.num(w.max, min, 0, 1e5, `${label}.max`);
  if (max < min) { problems.push(`${label} max is below min: swapped`); [min, max] = [max, min]; }
  return { min, max, speed: Math.max(0.1, speed) };
}

function normDamage(d, label, defWeapon, R, problems) {
  if (d == null || d === false) return null;
  if (typeof d === 'number' || typeof d === 'string') d = { min: d, max: d };
  if (!isObj(d)) { problems.push(`${label} is not an object: ignored`); return null; }
  const min = R.num(d.min, 0, 0, 1e6, `${label}.min`);
  let max = R.num(d.max, min, 0, 1e6, `${label}.max`);
  const out = {
    min: Math.min(min, max), max: Math.max(min, max),
    apCoef: R.num(d.apCoef, 0, 0, 50, `${label}.apCoef`),
    spCoef: R.num(d.spCoef, 0, 0, 50, `${label}.spCoef`),
    weaponPct: R.num(d.weaponPct, 0, 0, 10000, `${label}.weaponPct`),
    weapon: matchEnum(d.weapon, WEAPON_SLOTS) || defWeapon,
    normalizedSpeed: R.num(d.normalizedSpeed, 0, 0, 10, `${label}.normalizedSpeed`),
  };
  max = out.max;
  if (max === 0 && !out.apCoef && !out.spCoef && !out.weaponPct) return null;
  return out;
}

function normDot(d, label, R, problems) {
  if (d == null || d === false) return null;
  if (!isObj(d)) { problems.push(`${label} is not an object: ignored`); return null; }
  const out = {
    tickDamage: R.num(d.tickDamage, 0, 0, 1e6, `${label}.tickDamage`),
    apCoefPerTick: R.num(d.apCoefPerTick, 0, 0, 50, `${label}.apCoefPerTick`),
    spCoefPerTick: R.num(d.spCoefPerTick, 0, 0, 50, `${label}.spCoefPerTick`),
    interval: R.num(d.interval, 3, 0.1, 60, `${label}.interval`),
    duration: R.num(d.duration, 15, 0, 900, `${label}.duration`),
    canCrit: R.bool(d.canCrit, false),
    maxStacks: Math.round(R.num(d.maxStacks, 1, 1, 100, `${label}.maxStacks`)),
  };
  if (!out.tickDamage && !out.apCoefPerTick && !out.spCoefPerTick) { problems.push(`${label} has no tick damage: ignored`); return null; }
  if (Math.floor(out.duration / out.interval + 1e-9) < 1) { problems.push(`${label} duration is shorter than its interval: ignored`); return null; }
  return out;
}

// Conditions keep only known keys; ids are resolved to canonical ids.
function normCond(c, where, refs, R, problems) {
  if (c == null) return null;
  if (!isObj(c)) { problems.push(`${where} is not an object: ignored`); return null; }
  const out = {};
  const ref = (v, key) => {
    const id = refs.any(v);
    if (!id) problems.push(`${where} ${key} references unknown buff ${quote(v)}`);
    return id || String(v);
  };
  for (const [key, v] of Object.entries(c)) {
    if (NUM_CONDS.includes(key)) {
      const n = R.num(v, NaN, -1e6, 1e6, `${where} ${key}`);
      if (!Number.isNaN(n)) out[key] = n;
    } else if (key === 'buffUp' || key === 'buffDown') {
      out[key] = ref(v, key);
    } else if (key === 'buffStacksAtLeast' || key === 'buffRemainsBelow') {
      const o = asObj(v);
      const n = R.num(key === 'buffStacksAtLeast' ? o.n : o.sec, NaN, 0, 1e6, `${where} ${key}`);
      if (o.id == null || Number.isNaN(n)) { problems.push(`${where} ${key} needs an id and a number: ignored`); continue; }
      out[key] = key === 'buffStacksAtLeast' ? { id: ref(o.id, key), n } : { id: ref(o.id, key), sec: n };
    } else if (key === 'cooldownUp' || key === 'cooldownRemainsAbove') {
      const o = key === 'cooldownUp' ? { id: v } : asObj(v);
      const id = refs.ability(o.id);
      if (!id) { problems.push(`${where} ${key} references unknown ability ${quote(o.id)}: ignored`); continue; }
      if (key === 'cooldownUp') out[key] = id;
      else out[key] = { id, sec: R.num(o.sec, 0, 0, 1e6, `${where} ${key}.sec`) };
    } else if (key === 'usedOnTarget') {
      const id = refs.ability(v);
      if (!id) { problems.push(`${where} ${key} references unknown ability ${quote(v)}: ignored`); continue; }
      out[key] = id;
    } else if (key === 'any' || key === 'all') {
      // "all" is not in the spec: the One Button translation (onebutton.js)
      // uses it when two conditions of one action share a key.
      out[key] = asList(v).map((x, i) => normCond(x, `${where} ${key} ${i + 1}`, refs, R, problems)).filter(Boolean);
    } else if (key === 'not') {
      const inner = normCond(v, `${where} not`, refs, R, problems);
      if (inner) out.not = inner;
    } else {
      problems.push(`${where} has unknown key "${key}": ignored`);
    }
  }
  return Object.keys(out).length ? out : null;
}

/**
 * Repairs and validates a combat model. Never throws.
 * @returns {{ model: object, problems: string[], fatal: boolean }}
 */
export function normalizeModel(raw) {
  const problems = [];
  try {
    return normalizeInner(raw, problems);
  } catch (err) {
    problems.push(`model could not be read: ${err && err.message}`);
    return { model: normalizeInner({}, []).model, problems, fatal: true };
  }
}

function normalizeInner(raw, problems) {
  let src = raw;
  if (typeof src === 'string') { try { src = JSON.parse(src); } catch { problems.push('model is not valid JSON'); } }
  if (!isObj(src)) { if (raw != null && typeof raw !== 'string') problems.push('model is not an object'); src = {}; }
  const R = reader(problems);

  // Player.
  const rp = asObj(src.player);
  const level = Math.round(R.num(rp.level, 60, 1, 63, 'player.level'));
  const rs = asObj(rp.stats);
  const stats = {};
  for (const k of STAT_KEYS) stats[k] = R.num(rs[k], 0, 0, k.endsWith('Pct') ? (k === 'hastePct' ? 500 : 100) : 1e5, `player.stats.${k}`);
  // A sheet without a separate ranged crit value uses the melee one.
  if (!stats.rangedCritPct) stats.rangedCritPct = stats.critPct;
  const rw = asObj(rp.weapons);
  const weapons = {};
  for (const slot of WEAPON_SLOTS) weapons[slot] = normWeapon(rw[slot], `player.weapons.${slot}`, R, problems);
  let autoAttack = matchEnum(rp.autoAttack, ['melee', 'ranged', 'none'])
    || (weapons.mainHand ? 'melee' : weapons.ranged ? 'ranged' : 'none');
  if (autoAttack === 'melee' && !weapons.mainHand) { problems.push('player.autoAttack is "melee" but there is no main-hand weapon: no auto attacks'); autoAttack = 'none'; }
  if (autoAttack === 'ranged' && !weapons.ranged) { problems.push('player.autoAttack is "ranged" but there is no ranged weapon: no auto attacks'); autoAttack = 'none'; }
  if (weapons.offHand && !weapons.mainHand) { problems.push('player.weapons.offHand without a main hand: ignored'); weapons.offHand = null; }

  const rr = asObj(rp.resource);
  const type = matchEnum(rr.type, ['mana', 'rage', 'energy', 'none']) || 'none';
  const max = R.num(rr.max, 100, 0, 1e6, 'player.resource.max');
  const rt = isObj(rr.tick) ? rr.tick : null;
  const tick = rt ? { amount: R.num(rt.amount, 0, 0, 1e5, 'player.resource.tick.amount'), interval: R.num(rt.interval, 2, 0.1, 60, 'player.resource.tick.interval') } : null;
  const rps = isObj(rr.perSwing) ? rr.perSwing : null;
  const perSwing = rps ? {
    perDamage: R.num(rps.perDamage, 0, 0, 100, 'player.resource.perSwing.perDamage'),
    perWeaponSpeed: R.num(rps.perWeaponSpeed, 0, 0, 1000, 'player.resource.perSwing.perWeaponSpeed'),
    flat: R.num(rps.flat, 0, 0, 1000, 'player.resource.perSwing.flat'),
    critMult: R.num(rps.critMult, 1, 0, 10, 'player.resource.perSwing.critMult'),
  } : null;
  const resource = {
    type, max,
    start: Math.min(max, R.num(rr.start, type === 'rage' ? 0 : max, 0, 1e6, 'player.resource.start')),
    regenPerSec: R.num(rr.regenPerSec, 0, 0, 1e5, 'player.resource.regenPerSec'),
    tick: tick && tick.amount > 0 ? tick : null,
    perSwing: perSwing && (perSwing.perDamage || perSwing.perWeaponSpeed || perSwing.flat) ? perSwing : null,
  };
  const rc = asObj(rp.critMultiplier);
  const critMultiplier = {};
  for (const [k, d] of Object.entries({ melee: 2, ranged: 2, spell: 1.5, heal: 1.5 })) critMultiplier[k] = R.num(rc[k], d, 1, 10, `player.critMultiplier.${k}`);
  const playerMods = normMods(rp.modifiers, 'player', R, problems);
  // What turns damage into threat on the player (a stance, Righteous Fury...).
  const threatMultiplier = R.num(rp.threatMultiplier, 1, 0, 20, 'player.threatMultiplier');

  // Fight.
  const rf = asObj(src.fight);
  const fight = {
    duration: R.num(rf.duration, 180, 10, 900, 'fight.duration'),
    targets: Math.round(R.num(rf.targets, 1, 1, 20, 'fight.targets')),
    targetLevel: Math.round(R.num(rf.targetLevel, Math.min(63, level + 3), 1, 63, 'fight.targetLevel')),
    targetArmor: R.num(rf.targetArmor, 3700, 0, 1e5, 'fight.targetArmor'),
    executePct: R.num(rf.executePct, 20, 0, 100, 'fight.executePct'),
  };
  const rawKind = matchEnum(src.kind, ['damage', 'healing']);
  // The enemy a tank has to survive (survival() below); the AI's estimate.
  const re = isObj(src.enemy) ? src.enemy : null;
  const enemy = re ? {
    level: Math.round(R.num(re.level, fight.targetLevel, 1, 63, 'enemy.level')),
    meleeHit: R.num(re.meleeHit, 0, 0, 1e6, 'enemy.meleeHit'),
    attackSpeed: R.num(re.attackSpeed, 2, 0.1, 10, 'enemy.attackSpeed'),
    magicDps: R.num(re.magicDps, 0, 0, 1e6, 'enemy.magicDps'),
  } : null;

  // Buffs (before abilities and procs, which reference them).
  const buffs = withIds(src.buffs, 'buff', problems).map(({ raw: b, id, name }) => ({
    id, name,
    onTarget: R.bool(b.onTarget, false),
    duration: R.num(b.duration, 0, 0, 3600, `buff "${id}" duration`),
    maxStacks: Math.round(R.num(b.maxStacks, 1, 1, 100, `buff "${id}" maxStacks`)),
    charges: Math.round(R.num(b.charges, 0, 0, 1000, `buff "${id}" charges`)),
    chargeOn: matchEnum(b.chargeOn, CHARGE_ON) || 'swing',
    initial: R.bool(b.initial, false),
    modifiers: normMods(b.modifiers, `buff "${id}"`, R, problems),
  }));
  const findBuff = resolver(buffs);

  // Abilities.
  const abEntries = withIds(src.abilities, 'ability', problems);
  const findAb = resolver(abEntries);
  const buffRefs = (list, field, id) => asList(list).map((ref) => {
    const b = findBuff(ref);
    if (!b) problems.push(`buff ${quote(ref)} referenced by ability "${id}" ${field} is not defined`);
    return b;
  }).filter(Boolean);
  const abilities = abEntries.map(({ raw: a, id, name }) => {
    const where = `ability "${id}"`;
    let school = matchEnum(a.school, SCHOOLS);
    const type = matchEnum(a.type, TYPES)
      || (rawKind === 'healing' ? 'heal' : school && school !== 'physical' ? 'spell' : 'melee');
    if (!school) school = type === 'heal' ? 'holy' : type === 'spell' ? 'arcane' : 'physical';
    const ab = {
      id, name, type, school,
      cost: R.num(a.cost, 0, 0, 1e6, `${where} cost`),
      gain: R.num(a.gain, 0, 0, 1e6, `${where} gain`),
      castTime: R.num(a.castTime, 0, 0, 60, `${where} castTime`),
      gcd: R.num(a.gcd, RULES.GCD_DEFAULT, 0, 10, `${where} gcd`),
      cooldown: R.num(a.cooldown, 0, 0, 3600, `${where} cooldown`),
      nextSwing: R.bool(a.nextSwing, false),
      damage: normDamage(a.damage, `${where} damage`, type === 'ranged' ? 'ranged' : 'mainHand', R, problems),
      channelTicks: Math.round(R.num(a.channelTicks, 0, 0, 100, `${where} channelTicks`)),
      dot: normDot(a.dot, `${where} dot`, R, problems),
      canCrit: R.bool(a.canCrit, true),
      canMiss: R.bool(a.canMiss, true),
      ignoresArmor: R.bool(a.ignoresArmor, false),
      maxTargets: Math.round(R.num(a.maxTargets, 1, 1, 20, `${where} maxTargets`)),
      threatMultiplier: R.num(a.threatMultiplier, 1, 0, 50, `${where} threatMultiplier`),
      threat: R.num(a.threat, 0, 0, 1e5, `${where} threat`),
      applies: buffRefs(a.applies, 'applies', id),
      consumes: buffRefs(a.consumes, 'consumes', id),
      requires: null,
      _requires: a.requires,
    };
    if (a.spellId != null && Number.isFinite(toNum(a.spellId))) ab.spellId = toNum(a.spellId);
    if (ab.damage && ab.damage.weaponPct > 0 && !weapons[ab.damage.weapon]) {
      problems.push(`${where} uses ${ab.damage.weapon} weapon damage but there is no such weapon: weapon part ignored`);
      ab.damage.weaponPct = 0;
    }
    if (ab.nextSwing && (!weapons.mainHand || autoAttack !== 'melee')) {
      problems.push(`${where} is "nextSwing" but there are no main-hand auto attacks: it can never be used`);
    }
    if (!ab.damage && !ab.dot && !ab.applies.length && !ab.gain && !ab.threat) problems.push(`${where} has no damage, dot, applies or gain: it does nothing`);
    return ab;
  });
  const kind = rawKind || (abilities.length && abilities.every((a) => a.type === 'heal') ? 'healing' : 'damage');
  if (type === 'none' && abilities.some((a) => a.cost > 0)) problems.push('abilities have a cost but player.resource.type is "none": costs are ignored');

  // References that need every id: modifier filters, conditions, procs.
  const refs = { ability: findAb, any: (r) => findBuff(r) || findAb(r) };
  const fixFilters = (mods, where) => mods.forEach((m) => { if (m.abilities) m.abilities = resolveFilter(m.abilities, findAb, where, problems); });
  fixFilters(playerMods, 'player modifier');
  buffs.forEach((b) => fixFilters(b.modifiers, `buff "${b.id}" modifier`));
  for (const ab of abilities) {
    ab.requires = normCond(ab._requires, `ability "${ab.id}" requires`, refs, R, problems);
    delete ab._requires;
  }

  const procs = [];
  for (const { raw: p, id, name } of withIds(src.procs, 'proc', problems)) {
    const where = `proc "${id}"`;
    const trigger = matchEnum(p.trigger, TRIGGERS);
    if (!trigger) { problems.push(`${where} has unknown trigger ${quote(p.trigger)}: dropped`); continue; }
    let chance = R.num(p.chance, 0, 0, 100, `${where} chance`);
    if (chance > 1) { problems.push(`${where} chance ${chance} read as ${chance}%: use 0..1`); chance /= 100; }
    const e = asObj(p.effect);
    const effect = {
      damage: normDamage(e.damage, `${where} damage`, 'mainHand', R, problems),
      buff: null,
      resource: R.num(e.resource, 0, -1e5, 1e5, `${where} resource`),
      extraAttacks: Math.round(R.num(e.extraAttacks, 0, 0, 10, `${where} extraAttacks`)),
      resetCooldown: null,
    };
    if (effect.damage) {
      const d = asObj(e.damage);
      effect.damage.school = matchEnum(d.school, SCHOOLS) || 'physical';
      effect.damage.canCrit = R.bool(d.canCrit, true);
    }
    if (e.buff != null) { effect.buff = findBuff(e.buff); if (!effect.buff) problems.push(`buff ${quote(e.buff)} referenced by proc "${id}" is not defined`); }
    if (e.resetCooldown != null) { effect.resetCooldown = findAb(e.resetCooldown); if (!effect.resetCooldown) problems.push(`${where} resets unknown ability ${quote(e.resetCooldown)}`); }
    if (effect.extraAttacks && autoAttack !== 'melee') { problems.push(`${where} gives extra attacks but there are no melee auto attacks`); effect.extraAttacks = 0; }
    if (!effect.damage && !effect.buff && !effect.resource && !effect.extraAttacks && !effect.resetCooldown) {
      problems.push(`${where} has no usable effect: dropped`);
      continue;
    }
    const ppm = R.num(p.ppm, 0, 0, 60, `${where} ppm`);
    if (!chance && !ppm) problems.push(`${where} has neither chance nor ppm: it never triggers`);
    procs.push({
      id, name, trigger, chance, ppm, effect,
      icd: R.num(p.icd, 0, 0, 3600, `${where} icd`),
      abilities: p.abilities != null ? resolveFilter(asList(p.abilities), findAb, where, problems) : undefined,
    });
  }

  const statConversions = {};
  for (const [stat, conv] of Object.entries(asObj(src.statConversions))) {
    const c = {};
    for (const [target, v] of Object.entries(asObj(conv))) {
      const t = STAT_KEYS.includes(target) || RESOURCE_TARGETS.includes(target) ? target : null;
      const n = toNum(v);
      if (!t) { problems.push(`statConversions.${stat} has unknown target "${target}": ignored`); continue; }
      if (Number.isFinite(n)) c[t] = n;
    }
    if (Object.keys(c).length) statConversions[stat] = c;
  }

  const actionsOf = (list, label, into) => {
    const actions = [];
    asList(list).forEach((act, ai) => {
      const a = typeof act === 'string' ? { use: act } : asObj(act);
      const id = findAb(a.use);
      if (!id) { into.push(`${label} action ${ai + 1} uses unknown ability ${quote(a.use)}`); return; }
      const cond = normCond(a.if, `${label} action ${ai + 1} condition`, refs, R, into);
      actions.push(cond ? { use: id, if: cond } : { use: id });
    });
    return actions;
  };
  const rotations = [];
  asList(src.rotations).forEach((r, ri) => {
    if (!isObj(r)) { problems.push(`rotation ${ri + 1} is not an object: dropped`); return; }
    const name = r.name != null ? String(r.name) : `Rotation ${ri + 1}`;
    const actions = actionsOf(r.actions, `rotation "${name}"`, problems);
    if (!actions.length && autoAttack === 'none') problems.push(`rotation "${name}" has no usable actions and there are no auto attacks: it does nothing`);
    rotations.push({ name, actions });
  });

  // The AI's lists for Forever One Button, one per kind of fight: not
  // candidates. What is wrong with them is kept apart, so that it never sends
  // a model back by itself (see index.js).
  const oneButtonProblems = [];
  const oneButton = {};
  if (src.oneButton != null && !isObj(src.oneButton)) oneButtonProblems.push('oneButton is not an object: ignored');
  for (const kind of FIGHT_KINDS) {
    const raw = asObj(src.oneButton)[kind];
    if (raw == null) continue;
    const actions = actionsOf(raw, `oneButton.${kind}`, oneButtonProblems);
    if (actions.length) oneButton[kind] = actions;
  }

  let fatal = false;
  if (!rotations.length) { problems.push('no rotations'); fatal = true; }
  if (!abilities.length && autoAttack === 'none') { problems.push('no abilities and no auto attack: nothing to simulate'); fatal = true; }

  const model = {
    version: 1, kind, fight,
    player: { level, stats, weapons, autoAttack, resource, critMultiplier, modifiers: playerMods, threatMultiplier },
    abilities, buffs, procs, statConversions, rotations,
  };
  if (enemy) model.enemy = enemy;
  if (Object.keys(oneButton).length) model.oneButton = oneButton;
  return { model, problems, fatal, oneButtonProblems };
}

// --------------------------------------------------------------- compile

// A context describes who deals the damage, for modifier filters and stats.
function makeCtx(id, type, school, extra) {
  const spellLike = type === 'spell' || type === 'heal';
  return {
    id, type, school, spellLike,
    heal: !!extra.heal, ranged: !!extra.ranged, armor: !!extra.armor, white: !!extra.white,
    critKind: extra.heal ? 'heal' : spellLike ? 'spell' : extra.ranged ? 'ranged' : 'melee',
    ver: -1, st: null,
  };
}

// metric: "tps" ranks by threat per second (tanks); otherwise the model's
// kind decides between damage and healing per second.
function compile(m, metric) {
  const healMetric = m.kind === 'healing';
  const p = m.player;
  const d = clamp(m.fight.targetLevel - p.level, 0, RULES.MAX_LEVEL_DIFF);
  const buffIdx = new Map(m.buffs.map((b, i) => [b.id, i]));
  const abIdx = new Map(m.abilities.map((a, i) => [a.id, i]));
  const nAb = m.abilities.length;
  const C = {
    m, d, healMetric, nAb, buffIdx, abIdx,
    stats: p.stats, level: p.level, fight: m.fight, weapons: p.weapons, res: p.resource,
    resOn: p.resource.type !== 'none', critMult: p.critMultiplier, baseMods: p.modifiers,
    melee: p.autoAttack === 'melee', rangedAuto: p.autoAttack === 'ranged',
    dualWield: p.autoAttack === 'melee' && !!p.weapons.offHand,
    buffs: m.buffs, chargeLists: { swing: [], ability: [], spell: [] },
    procs: {}, procList: [],
  };
  m.buffs.forEach((b, i) => { if (b.charges > 0) C.chargeLists[b.chargeOn].push(i); });
  C.autoCtx = [
    makeCtx('auto', 'auto', 'physical', { armor: true, white: true }),
    makeCtx('auto', 'auto', 'physical', { armor: true, white: true }),
    makeCtx('auto', 'auto', 'physical', { armor: true, white: true, ranged: true }),
  ];
  C.globalCtx = makeCtx(null, 'none', null, {});
  C.ab = m.abilities.map((a, i) => {
    const heal = a.type === 'heal' || healMetric;
    const ranged = a.type === 'ranged';
    const ctx = makeCtx(a.id, a.type, a.school, { heal, ranged, armor: !heal && a.school === 'physical' && !a.ignoresArmor });
    const dotCtx = makeCtx(a.id, a.type, a.school, { heal, ranged, armor: false });
    const spellLike = ctx.spellLike;
    const w = a.damage ? p.weapons[a.damage.weapon] : ranged ? p.weapons.ranged : p.weapons.mainHand;
    return {
      ...a, idx: i, src: i + 1, heal, spellLike, ctx, dotCtx,
      offGcd: a.gcd === 0 || a.nextSwing,
      dotTicks: a.dot ? Math.floor(a.dot.duration / a.dot.interval + 1e-9) : 0,
      targetsMult: heal ? a.maxTargets : Math.min(a.maxTargets, m.fight.targets),
      selfBuffs: a.applies.map((id) => buffIdx.get(id)).filter((b) => !m.buffs[b].onTarget),
      targetBuffs: a.applies.map((id) => buffIdx.get(id)).filter((b) => m.buffs[b].onTarget),
      consumeIdx: a.consumes.map((id) => buffIdx.get(id)),
      hitKind: spellLike ? 'spell' : ranged ? 'ranged' : 'melee',
      chargeKind: spellLike ? 'spell' : 'ability',
      speed: w ? w.speed : 0,
      requiresFn: compileCond(a.requires, C),
    };
  });
  m.procs.forEach((pr, j) => {
    const dmg = pr.effect.damage;
    const school = dmg ? dmg.school : 'physical';
    const type = school === 'physical' ? 'melee' : 'spell';
    const cp = {
      ...pr, idx: j, src: 1 + nAb + j, heal: healMetric,
      ctx: makeCtx(pr.id, healMetric ? 'heal' : type, school, { heal: healMetric, armor: !healMetric && school === 'physical' }),
      buffIdx: pr.effect.buff != null ? buffIdx.get(pr.effect.buff) : -1,
      resetIdx: pr.effect.resetCooldown != null ? abIdx.get(pr.effect.resetCooldown) : -1,
    };
    C.procList.push(cp);
    (C.procs[pr.trigger] ||= []).push(cp);
  });
  C.rotations = m.rotations.map((r) => ({
    name: r.name,
    actions: r.actions.map((a) => ({ ab: C.ab[abIdx.get(a.use)], cond: compileCond(a.if, C) })),
  }));
  C.nSrc = 1 + nAb + m.procs.length;
  // Threat per point of damage of each source: auto attacks and procs carry
  // the player's multiplier, abilities their own on top of it. Healing makes
  // no threat here (not modelled).
  const pm = p.threatMultiplier ?? 1;
  C.threatMetric = metric === 'tps';
  C.thrMult = new Float64Array(C.nSrc);
  C.thrMult[0] = pm;
  C.ab.forEach((a) => {
    C.thrMult[a.src] = a.heal ? 0 : (a.threatMultiplier ?? 1) * pm;
    a.threatFlat = a.heal ? 0 : (a.threat || 0) * pm * a.targetsMult;
  });
  C.procList.forEach((pr) => { C.thrMult[pr.src] = pr.heal ? 0 : pm; });
  return C;
}

// Conditions become closures over the fight state S.
function compileCond(c, C) {
  if (!c) return null;
  const tests = [];
  const look = (id) => (C.buffIdx.has(id) ? { b: C.buffIdx.get(id) } : C.abIdx.has(id) && C.m.abilities[C.abIdx.get(id)].dot ? { d: C.abIdx.get(id) } : {});
  const up = (L, S) => (L.b !== undefined ? S.bStacks[L.b] > 0 : L.d !== undefined ? S.dLeft[L.d] > 0 : false);
  const stacks = (L, S) => (L.b !== undefined ? S.bStacks[L.b] : L.d !== undefined ? (S.dLeft[L.d] > 0 ? S.dStacks[L.d] : 0) : 0);
  const remains = (L, S) => (!up(L, S) ? 0 : L.b !== undefined ? S.bExp[L.b] - S.t : S.dExp[L.d] - S.t);
  const health = (S) => 100 * (1 - S.t / S.dur);
  for (const [key, v] of Object.entries(c)) {
    switch (key) {
      case 'resourceAtLeast': tests.push((S) => S.res >= v - RULES.EPS); break;
      case 'resourceBelow': tests.push((S) => S.res < v); break;
      case 'targetHealthBelow': tests.push((S) => health(S) < v); break;
      case 'targetHealthAbove': tests.push((S) => health(S) > v); break;
      case 'timeAtLeast': tests.push((S) => S.t >= v - RULES.EPS); break;
      case 'timeRemainingBelow': tests.push((S) => S.dur - S.t < v); break;
      case 'targetsAtLeast': tests.push(() => C.fight.targets >= v); break;
      case 'swingTimerAbove': tests.push((S) => (C.melee ? S.mhNext - S.t : Infinity) > v); break;
      case 'buffUp': { const L = look(v); tests.push((S) => up(L, S)); break; }
      case 'buffDown': { const L = look(v); tests.push((S) => !up(L, S)); break; }
      case 'buffStacksAtLeast': { const L = look(v.id); tests.push((S) => stacks(L, S) >= v.n); break; }
      case 'buffRemainsBelow': { const L = look(v.id); tests.push((S) => remains(L, S) < v.sec); break; }
      case 'cooldownUp': { const i = C.abIdx.get(v); tests.push((S) => S.cd[i] <= S.t + RULES.EPS); break; }
      case 'cooldownRemainsAbove': { const i = C.abIdx.get(v.id); tests.push((S) => S.cd[i] - S.t > v.sec); break; }
      case 'usedOnTarget': { const i = C.abIdx.get(v); tests.push((S) => S.t - S.lastUse[i] < RULES.USED_ON_TARGET_SEC); break; }
      case 'any': { const fs = v.map((x) => compileCond(x, C)).filter(Boolean); tests.push((S) => fs.some((f) => f(S))); break; }
      case 'all': { const fs = v.map((x) => compileCond(x, C)).filter(Boolean); tests.push((S) => fs.every((f) => f(S))); break; }
      case 'not': { const f = compileCond(v, C); if (f) tests.push((S) => !f(S)); break; }
      default: break;
    }
  }
  return (S) => { for (let i = 0; i < tests.length; i++) if (!tests[i](S)) return false; return true; };
}

// ------------------------------------------------------------ fight state

let VERSION = 0; // global, so per-context stat caches never collide across fights

function newState(C, seed, iter) {
  const nAb = C.nAb, nB = C.buffs.length;
  const S = {
    C, t: 0, dur: C.fight.duration, ver: ++VERSION, modsVer: -1, mods: [],
    res: C.resOn ? C.res.start : 0, gcdReady: 0, cast: null, queued: -1,
    mhNext: C.melee ? 0 : Infinity, ohNext: C.dualWield ? 0 : Infinity, rgNext: C.rangedAuto ? 0 : Infinity,
    tickNext: C.resOn && C.res.tick ? C.res.tick.interval : Infinity, wake: Infinity,
    cd: new Float64Array(nAb), used: new Int32Array(nAb), stamp: 0, lastUse: new Float64Array(nAb).fill(-Infinity),
    bStacks: new Int32Array(nB), bExp: new Float64Array(nB), bCharges: new Int32Array(nB),
    bSince: new Float64Array(nB), bUp: new Float64Array(nB),
    dLeft: new Int32Array(nAb), dNext: new Float64Array(nAb), dExp: new Float64Array(nAb), dVal: new Float64Array(nAb),
    dCrit: new Float64Array(nAb), dCritMult: new Float64Array(nAb), dStacks: new Int32Array(nAb),
    dSince: new Float64Array(nAb), dUp: new Float64Array(nAb),
    icd: new Float64Array(C.procList.length),
    total: new Float64Array(C.nSrc), threat: new Float64Array(C.nSrc), count: new Float64Array(C.nSrc), crits: new Float64Array(C.nSrc), critN: new Float64Array(C.nSrc),
    wasted: 0, idle: 0, idleFlag: false, decisions: 0, starved: 0, emptyAt: null,
    rngMH: mulberry32(streamSeed(seed, iter, 1)), rngOH: mulberry32(streamSeed(seed, iter, 2)), rngRG: mulberry32(streamSeed(seed, iter, 3)),
    rngAb: C.ab.map((a, i) => mulberry32(streamSeed(seed, iter, 100 + i))),
    rngDot: C.ab.map((a, i) => mulberry32(streamSeed(seed, iter, 10000 + i))),
    rngProc: C.procList.map((p, j) => mulberry32(streamSeed(seed, iter, 20000 + j))),
  };
  C.buffs.forEach((b, i) => { if (b.initial) applyBuff(S, i, b.duration > 0 ? b.duration : Infinity); });
  return S;
}

function rebuildMods(S) {
  const C = S.C, out = [];
  for (const m of C.baseMods) out.push(m, 1);
  for (let i = 0; i < C.buffs.length; i++) {
    const n = S.bStacks[i];
    if (n > 0) for (const m of C.buffs[i].modifiers) out.push(m, n);
  }
  S.mods = out;
  S.modsVer = S.ver;
}

// Effective stats and attack table for one context under the active
// modifiers. Cached until a buff changes.
function stats(S, ctx) {
  if (ctx.ver === S.ver) return ctx.st;
  if (S.modsVer !== S.ver) rebuildMods(S);
  const C = S.C, base = C.stats, mods = S.mods;
  let apF = 0, apM = 1, spF = 0, spM = 1, crit = 0, hit = 0, dmg = 1, critDmg = 0, cost = 1;
  let ign = 0, armF = 0, castHaste = 0, haste = 0, regen = 0;
  for (let i = 0; i < mods.length; i += 2) {
    const m = mods[i], n = mods[i + 1], v = m.value;
    if (m.school && m.school !== ctx.school) continue;
    if (m.types && !m.types.includes(ctx.type)) continue;
    if (m.abilities && !m.abilities.includes(ctx.id)) continue;
    switch (m.stat) {
      case 'attackPower': apF += v * n; break;
      case 'attackPowerPct': apM *= (1 + v / 100) ** n; break;
      case 'spellPower': spF += v * n; break;
      case 'spellPowerPct': spM *= (1 + v / 100) ** n; break;
      case 'critPct': if (!ctx.spellLike) crit += v * n; break;
      case 'spellCritPct': if (ctx.spellLike) crit += v * n; break;
      case 'hitPct': if (!ctx.spellLike) hit += v * n; break;
      case 'spellHitPct': if (ctx.spellLike) hit += v * n; break;
      case 'hastePct': haste += v * n; break;
      case 'castHastePct': castHaste += v * n; break;
      case 'damagePct': dmg *= (1 + v / 100) ** n; break;
      case 'critDamagePct': critDmg += v * n; break;
      case 'costPct': cost *= (1 + v / 100) ** n; break;
      case 'armorIgnorePct': ign += v * n; break;
      case 'targetArmor': armF += v * n; break;
      case 'resourceRegenPct': regen += v * n; break;
      default: break;
    }
  }
  const d = C.d;
  crit += ctx.spellLike ? base.spellCritPct : ctx.ranged ? base.rangedCritPct : base.critPct;
  hit += ctx.spellLike ? base.spellHitPct : base.hitPct;
  let miss, dodge = 0, glance = 0, critChance;
  if (ctx.spellLike) {
    miss = ctx.heal ? 0 : Math.max(RULES.SPELL_MISS_FLOOR, RULES.SPELL_MISS[d] - hit);
    critChance = crit;
  } else {
    // The dual-wield penalty only hits white swings.
    miss = Math.max(0, RULES.MELEE_MISS[d] + (ctx.white && !ctx.ranged && C.dualWield ? RULES.DUAL_WIELD_MISS : 0) - hit);
    if (!ctx.ranged) dodge = RULES.DODGE_BASE + RULES.DODGE_PER_LEVEL * d;
    if (ctx.white && !ctx.ranged) glance = RULES.GLANCE_BASE + RULES.GLANCE_PER_LEVEL * d;
    critChance = crit - RULES.CRIT_SUPPRESSION_PER_LEVEL * d - (d === RULES.MAX_LEVEL_DIFF ? RULES.CRIT_SUPPRESSION_AT_MAX : 0);
  }
  let armorMult = 1;
  if (ctx.armor) {
    const armor = Math.max(0, (C.fight.targetArmor + armF) * (1 - clamp(ign, 0, 100) / 100));
    armorMult = 1 - armorReduction(armor, C.level);
  }
  const baseCrit = C.critMult[ctx.critKind];
  ctx.st = {
    ap: Math.max(0, ((ctx.ranged ? base.rangedAttackPower : base.attackPower) + apF) * apM),
    sp: Math.max(0, ((ctx.heal ? base.healingPower : base.spellPower) + spF) * spM),
    miss: clamp(miss, 0, 100), dodge, glance, crit: clamp(critChance, 0, 100),
    dmgMult: Math.max(0, dmg), critMult: 1 + (baseCrit - 1) * (1 + critDmg / 100),
    costMult: Math.max(0, cost), armorMult,
    castHaste: Math.max(-90, castHaste), haste: Math.max(-90, base.hastePct + haste),
    regenMult: Math.max(0, 1 + regen / 100),
    glanceMult: clamp(RULES.GLANCE_DAMAGE_BASE - RULES.GLANCE_DAMAGE_PER_LEVEL * d, RULES.GLANCE_DAMAGE_MIN, 1),
  };
  ctx.ver = S.ver;
  return ctx.st;
}

// ------------------------------------------------------- resource, buffs

function gainRes(S, amount) {
  const C = S.C;
  if (!C.resOn || !(amount > 0)) { if (C.resOn && amount < 0) S.res = Math.max(0, S.res + amount); return; }
  const room = C.res.max - S.res;
  if (amount > room) { S.wasted += amount - Math.max(0, room); S.res = C.res.max; } else S.res += amount;
}

const costOf = (S, a) => (S.C.resOn ? a.cost * stats(S, a.ctx).costMult : 0);
const canPay = (S, a) => S.res >= costOf(S, a) - RULES.EPS;
function pay(S, amount) { if (S.C.resOn) S.res = Math.max(0, S.res - amount); }

function applyBuff(S, i, durationOverride) {
  const b = S.C.buffs[i];
  if (S.bStacks[i] > 0) S.bStacks[i] = Math.min(b.maxStacks, S.bStacks[i] + 1);
  else { S.bStacks[i] = 1; S.bSince[i] = S.t; }
  S.bExp[i] = durationOverride !== undefined ? durationOverride : b.duration > 0 ? S.t + b.duration : Infinity;
  S.bCharges[i] = b.charges;
  S.ver = ++VERSION;
}

function removeBuff(S, i) {
  if (S.bStacks[i] <= 0) return;
  S.bUp[i] += Math.min(S.t, S.dur) - S.bSince[i];
  S.bStacks[i] = 0;
  S.ver = ++VERSION;
}

// Charges: "swing" per auto attack, "ability" per melee/ranged ability,
// "spell" per spell or heal cast. Consumed after the event resolves.
function useCharges(S, kind) {
  const list = S.C.chargeLists[kind];
  for (let k = 0; k < list.length; k++) {
    const i = list[k];
    if (S.bStacks[i] > 0 && --S.bCharges[i] <= 0) removeBuff(S, i);
  }
}

// Threat comes from the same hits as damage: no roll of its own, so it never
// moves the dice of a damage or healing run.
function record(S, src, amount, crit, eligible) {
  S.total[src] += amount;
  S.threat[src] += amount * S.C.thrMult[src];
  if (eligible) { S.critN[src]++; if (crit) S.crits[src]++; }
}

// ----------------------------------------------------------------- procs

function fireProcs(S, trig, srcId, speed, fromExtra) {
  const list = S.C.procs[trig];
  if (!list) return;
  for (const p of list) {
    if (p.abilities && !p.abilities.includes(srcId)) continue;
    if (fromExtra && p.effect.extraAttacks > 0) continue; // extra attacks cannot chain
    const rng = S.rngProc[p.idx];
    const roll = rng();
    if (S.icd[p.idx] > S.t + RULES.EPS) continue;
    const chance = p.ppm > 0 ? p.ppm * (speed || RULES.PPM_FALLBACK_SPEED) / 60 : p.chance;
    if (roll >= chance) continue;
    S.icd[p.idx] = S.t + p.icd;
    S.count[p.src]++;
    const e = p.effect;
    if (e.damage) {
      // Proc damage cannot miss and triggers nothing further.
      const st = stats(S, p.ctx);
      const rCrit = rng(), rDmg = rng();
      const crit = e.damage.canCrit && rCrit * 100 < st.crit;
      let v = rollDamage(S.C, e.damage, st, rDmg) * st.dmgMult * st.armorMult;
      if (crit) v *= st.critMult;
      record(S, p.src, v, crit, e.damage.canCrit);
    }
    if (p.buffIdx >= 0) applyBuff(S, p.buffIdx);
    if (e.resource) gainRes(S, e.resource);
    if (p.resetIdx >= 0) S.cd[p.resetIdx] = S.t;
    for (let k = 0; k < e.extraAttacks; k++) swing(S, 0, true);
  }
}

function fireHit(S, kind, crit, srcId, speed, fromExtra) {
  if (kind === 'melee') { fireProcs(S, 'meleeHit', srcId, speed, fromExtra); if (crit) fireProcs(S, 'meleeCrit', srcId, speed, fromExtra); }
  else if (kind === 'ranged') fireProcs(S, 'rangedHit', srcId, speed, fromExtra);
  else { fireProcs(S, 'spellHit', srcId, speed, fromExtra); if (crit) fireProcs(S, 'spellCrit', srcId, speed, fromExtra); }
  fireProcs(S, 'anyHit', srcId, speed, fromExtra);
  if (crit) fireProcs(S, 'anyCrit', srcId, speed, fromExtra);
}

// --------------------------------------------------------------- damage

// Base of one hit: roll(min..max) + AP*apCoef + SP*spCoef + weaponPct% of a
// weapon hit (normalizedSpeed replaces the speed in its attack power part).
function rollDamage(C, d, st, r) {
  let v = d.min + r * (d.max - d.min) + st.ap * d.apCoef + st.sp * d.spCoef;
  if (d.weaponPct > 0) {
    const w = C.weapons[d.weapon];
    if (w) {
      const speed = d.normalizedSpeed > 0 ? d.normalizedSpeed : w.speed;
      v += (d.weaponPct / 100) * (w.min + r * (w.max - w.min) + (st.ap / RULES.AP_PER_DPS) * speed);
    }
  }
  return v;
}

const weaponHit = (w, ap, r) => w.min + r * (w.max - w.min) + (ap / RULES.AP_PER_DPS) * w.speed;

// One hit of an ability that already landed.
function abilityHit(S, a, rCrit, rDmg, fromExtra) {
  const st = stats(S, a.ctx);
  const crit = a.canCrit && rCrit * 100 < st.crit;
  let v = rollDamage(S.C, a.damage, st, rDmg) * st.dmgMult * st.armorMult * a.targetsMult;
  if (crit) v *= st.critMult;
  record(S, a.src, v, crit, a.canCrit);
  fireHit(S, a.hitKind, crit, a.id, a.speed, fromExtra);
}

// Yellow attacks and spells roll hit first; heals and canMiss=false land.
function lands(S, a, rLand) {
  if (!a.canMiss || a.heal) return true;
  const st = stats(S, a.ctx);
  return rLand * 100 >= st.miss + st.dodge;
}

function applyDot(S, a) {
  const st = stats(S, a.dotCtx), d = a.dot, i = a.idx;
  if (S.dLeft[i] > 0) S.dStacks[i] = Math.min(d.maxStacks, S.dStacks[i] + 1);
  else { S.dStacks[i] = 1; S.dSince[i] = S.t; }
  // Modifiers and crit are snapshotted at application; a refresh restarts the tick timer.
  S.dVal[i] = (d.tickDamage + st.ap * d.apCoefPerTick + st.sp * d.spCoefPerTick) * st.dmgMult;
  S.dCrit[i] = d.canCrit ? st.crit : 0;
  S.dCritMult[i] = st.critMult;
  S.dLeft[i] = a.dotTicks;
  S.dNext[i] = S.t + d.interval;
  S.dExp[i] = S.t + a.dotTicks * d.interval;
}

function dotTick(S, a) {
  const i = a.idx;
  const crit = S.rngDot[i]() * 100 < S.dCrit[i];
  const v = S.dVal[i] * S.dStacks[i] * (crit ? S.dCritMult[i] : 1);
  record(S, a.src, v, crit, a.dot.canCrit);
  fireProcs(S, 'dotTick', a.id, a.speed, false);
  if (--S.dLeft[i] <= 0) { S.dUp[i] += Math.min(S.t, S.dur) - S.dSince[i]; S.dLeft[i] = 0; }
  else S.dNext[i] += a.dot.interval;
}

// Everything that follows a use once its hit roll is known: charges,
// consumed buffs, applied buffs and dots, resource gain, use procs.
function afterUse(S, a, landed) {
  S.lastUse[a.idx] = S.t;
  useCharges(S, a.chargeKind);
  for (const b of a.consumeIdx) removeBuff(S, b);
  for (const b of a.selfBuffs) applyBuff(S, b);
  if (landed) {
    for (const b of a.targetBuffs) applyBuff(S, b);
    if (a.dot) applyDot(S, a);
    // Flat threat of an ability that landed (Sunder Armor's, a taunt's bonus).
    if (a.threatFlat) S.threat[a.src] += a.threatFlat;
  }
  if (a.gain) gainRes(S, a.gain);
  fireProcs(S, 'abilityUse', a.id, a.speed, false);
  if (a.spellLike) fireProcs(S, 'spellCast', a.id, a.speed, false);
}

// Resolves an instant use or a finished cast. Instant melee/ranged
// abilities pay after the hit roll (a miss costs MISSED_ABILITY_COST).
function resolve(S, a, payNow) {
  const r = S.rngAb[a.idx];
  const rLand = r(), rCrit = r(), rDmg = r();
  const landed = lands(S, a, rLand);
  if (payNow) pay(S, costOf(S, a) * (landed || a.spellLike ? 1 : RULES.MISSED_ABILITY_COST));
  S.count[a.src]++;
  if (landed && a.damage) abilityHit(S, a, rCrit, rDmg, false);
  afterUse(S, a, landed);
}

// ---------------------------------------------------------- auto attacks

function swingInterval(S, hand) {
  const w = hand === 0 ? S.C.weapons.mainHand : hand === 1 ? S.C.weapons.offHand : S.C.weapons.ranged;
  return w.speed / Math.max(0.1, 1 + stats(S, S.C.autoCtx[hand]).haste / 100);
}

// One auto attack. A queued "nextSwing" ability replaces a main-hand swing
// when it can be paid when the swing lands: a yellow attack that cannot glance.
function swing(S, hand, fromExtra) {
  const C = S.C;
  const w = hand === 0 ? C.weapons.mainHand : hand === 1 ? C.weapons.offHand : C.weapons.ranged;
  const r = hand === 0 ? S.rngMH : hand === 1 ? S.rngOH : S.rngRG;
  const rTable = r(), rCrit = r(), rDmg = r();
  if (hand === 0 && !fromExtra && S.queued >= 0) {
    const a = C.ab[S.queued];
    S.queued = -1;
    if (canPay(S, a)) {
      const landed = lands(S, a, rTable);
      pay(S, costOf(S, a) * (landed ? 1 : RULES.MISSED_ABILITY_COST));
      S.cd[a.idx] = S.t + a.cooldown;
      S.count[a.src]++;
      if (landed && a.damage) abilityHit(S, a, rCrit, rDmg, false);
      useCharges(S, 'swing');
      fireProcs(S, 'swing', a.id, w.speed, false);
      afterUse(S, a, landed);
      return;
    }
  }
  const ctx = C.autoCtx[hand], st = stats(S, ctx);
  S.count[0]++;
  // White attack table: one roll over miss, dodge, glancing, crit, hit.
  const roll = rTable * 100;
  let edge = st.miss, outcome = 'miss';
  if (roll >= edge) {
    if (roll < (edge += st.dodge)) outcome = 'dodge';
    else if (roll < (edge += st.glance)) outcome = 'glance';
    else if (roll < edge + st.crit) outcome = 'crit';
    else outcome = 'hit';
  }
  const landed = outcome !== 'miss' && outcome !== 'dodge';
  let v = 0;
  if (landed) {
    v = weaponHit(w, st.ap, rDmg) * (hand === 1 ? RULES.OFF_HAND_DAMAGE : 1) * st.dmgMult * st.armorMult;
    if (outcome === 'glance') v *= st.glanceMult;
    if (outcome === 'crit') v *= st.critMult;
    record(S, 0, v, outcome === 'crit', true);
    const ps = C.res.perSwing;
    if (ps) gainRes(S, (ps.perDamage * v + ps.perWeaponSpeed * w.speed + ps.flat) * (outcome === 'crit' ? ps.critMult : 1));
  } else {
    record(S, 0, 0, false, true);
  }
  useCharges(S, 'swing');
  fireProcs(S, 'swing', 'auto', w.speed, fromExtra);
  if (landed) fireHit(S, hand === 2 ? 'ranged' : 'melee', outcome === 'crit', 'auto', w.speed, fromExtra);
}

// A cast with a cast time stops melee swings (they restart from its end)
// and delays the next auto shot until it ends.
function holdSwings(S, end) {
  if (S.C.melee) {
    S.mhNext = end + swingInterval(S, 0);
    if (S.C.dualWield) S.ohNext = end + swingInterval(S, 1);
  }
  if (S.C.rangedAuto) S.rgNext = Math.max(S.rgNext, end);
}

// ------------------------------------------------------------- decisions

function startUse(S, a) {
  if (a.nextSwing) { S.queued = a.idx; return; }
  const st = stats(S, a.ctx);
  const castTime = a.castTime / Math.max(0.1, 1 + st.castHaste / 100);
  if (a.gcd > 0) {
    const g = a.spellLike ? Math.max(Math.min(RULES.GCD_MIN, a.gcd), a.gcd / Math.max(0.1, 1 + st.castHaste / 100)) : a.gcd;
    S.gcdReady = S.t + g;
  }
  S.cd[a.idx] = S.t + a.cooldown;
  if (a.channelTicks > 0) {
    // A channel rolls hit once at its start; each tick then rolls its own crit and damage.
    pay(S, costOf(S, a));
    const r = S.rngAb[a.idx];
    const rLand = r(); r(); r();
    const landed = lands(S, a, rLand);
    S.count[a.src]++;
    afterUse(S, a, landed);
    if (castTime <= 0) { for (let k = 0; k < a.channelTicks; k++) channelHit(S, a, landed); return; }
    const step = castTime / a.channelTicks;
    S.cast = { a, channel: true, landed, left: a.channelTicks, step, next: S.t + step, end: S.t + castTime };
    holdSwings(S, S.t + castTime);
  } else if (castTime > 0) {
    pay(S, costOf(S, a)); // casts pay in full when they start
    S.cast = { a, channel: false, end: S.t + castTime };
    holdSwings(S, S.t + castTime);
  } else {
    resolve(S, a, true);
  }
}

function channelHit(S, a, landed) {
  const r = S.rngAb[a.idx];
  const rCrit = r(), rDmg = r();
  if (landed && a.damage) abilityHit(S, a, rCrit, rDmg, false);
}

// At a decision point (not casting), walk the actions in order and use the
// first usable one; off-GCD abilities may be used too, each at most once.
function decide(S, rot) {
  S.idleFlag = false;
  S.wake = Infinity;
  if (S.cast) return;
  const C = S.C, t = S.t, EPS = RULES.EPS;
  const gcdFreeAtStart = t >= S.gcdReady - EPS;
  S.stamp++;
  let usedGcd = false, starved = false, wake = Infinity, condBlocked = false;
  for (let n = 0; n < RULES.MAX_ACTIONS_PER_DECISION && !S.cast; n++) {
    const gcdFree = S.t >= S.gcdReady - EPS;
    let pick = null;
    for (const act of rot.actions) {
      const a = act.ab;
      if (a.offGcd) { if (S.used[a.idx] === S.stamp) continue; }
      else if (!gcdFree) continue;
      if (a.nextSwing && (S.queued >= 0 || !C.melee)) continue;
      if (S.cd[a.idx] > t + EPS) { if (S.cd[a.idx] < wake) wake = S.cd[a.idx]; continue; }
      if ((a.requiresFn && !a.requiresFn(S)) || (act.cond && !act.cond(S))) { condBlocked = true; continue; }
      if (!canPay(S, a)) {
        if (!a.offGcd && gcdFree) {
          starved = true;
          if (C.res.type === 'mana' && S.emptyAt === null) S.emptyAt = t;
        }
        const regen = C.res.regenPerSec * stats(S, C.globalCtx).regenMult;
        if (regen > 0) wake = Math.min(wake, t + (costOf(S, a) - S.res) / regen + 1e-6);
        continue;
      }
      pick = act;
      break;
    }
    if (!pick) break;
    startUse(S, pick.ab);
    if (pick.ab.offGcd) S.used[pick.ab.idx] = S.stamp; else usedGcd = true;
  }
  if (gcdFreeAtStart) S.decisions++;
  if (gcdFreeAtStart && !usedGcd) {
    S.idleFlag = true;
    if (starved) S.starved++;
    if (condBlocked) wake = Math.min(wake, t + RULES.IDLE_POLL);
  }
  if (wake > t + EPS) S.wake = wake;
}

// ------------------------------------------------------------- the fight

function nextTime(S) {
  const C = S.C, t = S.t;
  let tn = Math.min(S.mhNext, S.ohNext, S.rgNext, S.tickNext, S.wake);
  if (S.cast) tn = Math.min(tn, S.cast.channel ? S.cast.next : S.cast.end);
  else if (S.gcdReady > t + RULES.EPS) tn = Math.min(tn, S.gcdReady);
  for (let i = 0; i < C.buffs.length; i++) if (S.bStacks[i] > 0 && S.bExp[i] < tn) tn = S.bExp[i];
  for (let i = 0; i < C.nAb; i++) if (S.dLeft[i] > 0 && S.dNext[i] < tn) tn = S.dNext[i];
  return tn;
}

function advance(S, tn) {
  const dt = tn - S.t;
  if (dt > 0) {
    if (S.C.resOn && S.C.res.regenPerSec > 0) gainRes(S, S.C.res.regenPerSec * stats(S, S.C.globalCtx).regenMult * dt);
    if (S.idleFlag) S.idle += dt;
  }
  S.t = tn;
}

function processEvents(S) {
  const C = S.C, t = S.t + RULES.EPS;
  const c = S.cast;
  if (c && !c.channel && c.end <= t) { S.cast = null; resolve(S, c.a, false); }
  else if (c && c.channel && c.next <= t) {
    channelHit(S, c.a, c.landed);
    if (--c.left <= 0) S.cast = null; else c.next += c.step;
  }
  for (let i = 0; i < C.buffs.length; i++) if (S.bStacks[i] > 0 && S.bExp[i] <= t) removeBuff(S, i);
  for (let i = 0; i < C.nAb; i++) if (S.dLeft[i] > 0 && S.dNext[i] <= t) dotTick(S, C.ab[i]);
  if (S.tickNext <= t) {
    gainRes(S, C.res.tick.amount * stats(S, C.globalCtx).regenMult);
    S.tickNext += C.res.tick.interval;
  }
  if (S.mhNext <= t) { swing(S, 0, false); S.mhNext = S.t + swingInterval(S, 0); }
  if (S.ohNext <= t) { swing(S, 1, false); S.ohNext = S.t + swingInterval(S, 1); }
  if (S.rgNext <= t) { swing(S, 2, false); S.rgNext = S.t + swingInterval(S, 2); }
}

function runFight(C, rot, seed, iter) {
  const S = newState(C, seed, iter);
  for (let guard = 0; guard < RULES.MAX_EVENTS_PER_FIGHT; guard++) {
    decide(S, rot);
    const tn = nextTime(S);
    if (!(tn < S.dur)) { advance(S, S.dur); break; }
    advance(S, Math.max(S.t, tn));
    processEvents(S);
  }
  for (let i = 0; i < C.buffs.length; i++) removeBuff(S, i);
  for (let i = 0; i < C.nAb; i++) if (S.dLeft[i] > 0) S.dUp[i] += S.dur - S.dSince[i];
  return S;
}

const srcIsHeal = (C, src) => (src === 0 ? false : src <= C.nAb ? C.ab[src - 1].heal : C.healMetric);

// Runs one rotation for every iteration and aggregates the results.
function runRotation(C, ri, iterations, seed) {
  const rot = C.rotations[ri], dur = C.fight.duration;
  const total = new Float64Array(C.nSrc), count = new Float64Array(C.nSrc), crits = new Float64Array(C.nSrc), critN = new Float64Array(C.nSrc);
  const threat = new Float64Array(C.nSrc);
  const bUp = new Float64Array(C.buffs.length), dUp = new Float64Array(C.nAb);
  const values = new Float64Array(iterations), threatValues = new Float64Array(iterations);
  let wasted = 0, idle = 0, decisions = 0, starved = 0, emptySum = 0, emptyN = 0, damageSum = 0;
  for (let it = 0; it < iterations; it++) {
    const S = runFight(C, rot, seed, it);
    let v = 0, th = 0, dmg = 0;
    for (let s = 0; s < C.nSrc; s++) {
      total[s] += S.total[s]; count[s] += S.count[s]; crits[s] += S.crits[s]; critN[s] += S.critN[s];
      threat[s] += S.threat[s];
      th += S.threat[s];
      if (srcIsHeal(C, s) === C.healMetric) v += S.total[s];
      if (!srcIsHeal(C, s)) dmg += S.total[s];
    }
    values[it] = v / dur;
    threatValues[it] = th / dur;
    damageSum += dmg / dur;
    for (let i = 0; i < bUp.length; i++) bUp[i] += S.bUp[i];
    for (let i = 0; i < dUp.length; i++) dUp[i] += S.dUp[i];
    wasted += S.wasted; idle += S.idle; decisions += S.decisions; starved += S.starved;
    if (S.emptyAt !== null) { emptySum += S.emptyAt; emptyN++; }
  }
  const meanOf = (xs) => xs.reduce((x, y) => x + y, 0) / iterations;
  const sdOf = (xs, m) => (iterations > 1 ? Math.sqrt(xs.reduce((x, y) => x + (y - m) ** 2, 0) / (iterations - 1)) : 0);
  const mean = meanOf(values), sd = sdOf(values, mean);
  const tps = meanOf(threatValues), tpsSd = sdOf(threatValues, tps);
  let grand = 0;
  for (let s = 0; s < C.nSrc; s++) if (srcIsHeal(C, s) === C.healMetric) grand += total[s];
  const minutes = (dur / 60) * iterations;
  const breakdown = [];
  for (let s = 0; s < C.nSrc; s++) {
    if (srcIsHeal(C, s) !== C.healMetric || (total[s] <= 0 && count[s] <= 0)) continue;
    const e = s === 0 ? { id: 'auto', name: 'Auto attack' } : s <= C.nAb ? C.ab[s - 1] : C.procList[s - 1 - C.nAb];
    breakdown.push({
      id: e.id, name: e.name,
      share: grand > 0 ? (100 * total[s]) / grand : 0,
      perMinute: count[s] / minutes,
      average: count[s] > 0 ? total[s] / count[s] : 0,
      critPct: critN[s] > 0 ? (100 * crits[s]) / critN[s] : 0,
    });
  }
  breakdown.sort((x, y) => y.share - x.share);
  const uptime = {};
  C.buffs.forEach((b, i) => { uptime[b.id] = (100 * bUp[i]) / (dur * iterations); });
  C.ab.forEach((a, i) => { if (a.dot) uptime[a.id] = (100 * dUp[i]) / (dur * iterations); });
  const result = {
    name: rot.name, index: ri, value: mean, stdev: sd, metric: C.healMetric ? 'hps' : 'dps',
    breakdown, uptime,
    resource: { wasted: wasted / iterations, starvedPct: decisions > 0 ? (100 * starved) / decisions : 0, emptyAt: emptyN ? emptySum / emptyN : null },
    idlePct: (100 * idle) / (dur * iterations),
    autoAttackShare: !C.healMetric && grand > 0 ? (100 * total[0]) / grand : 0,
    tps, dps: damageSum / iterations,
  };
  if (!C.threatMetric) return { result, values };
  // A tank's rotations are ranked by threat; the breakdown says where the threat comes from.
  result.value = tps;
  result.stdev = tpsSd;
  result.metric = 'tps';
  result.breakdown = threatBreakdown(C, threat, count, minutes);
  result.autoAttackShare = tps > 0 ? (100 * threat[0]) / (tps * dur * iterations) : 0;
  return { result, values: threatValues };
}

function threatBreakdown(C, threat, count, minutes) {
  let grand = 0;
  for (let s = 0; s < C.nSrc; s++) grand += threat[s];
  const out = [];
  for (let s = 0; s < C.nSrc; s++) {
    if (threat[s] <= 0) continue;
    const e = s === 0 ? { id: 'auto', name: 'Auto attack' } : s <= C.nAb ? C.ab[s - 1] : C.procList[s - 1 - C.nAb];
    out.push({ id: e.id, name: e.name, share: grand > 0 ? (100 * threat[s]) / grand : 0, perMinute: count[s] / minutes });
  }
  return out.sort((x, y) => y.share - x.share);
}

function readOpts(opts) {
  const o = asObj(opts);
  const it = Math.round(toNum(o.iterations));
  const sd = Math.round(toNum(o.seed));
  return { iterations: Number.isFinite(it) ? clamp(it, 1, 100000) : 300, seed: Number.isFinite(sd) ? sd : 1, o, metric: o.metric === 'tps' ? 'tps' : null };
}

/**
 * Simulates every rotation (or only index `rotation`). `best` indexes the
 * returned `rotations` array; each result also carries its model `index`.
 */
export function simulate(model, opts = {}) {
  try {
    const { model: m } = normalizeModel(model);
    const { iterations, seed, o, metric } = readOpts(opts);
    const C = compile(m, metric);
    let idx = C.rotations.map((_, i) => i);
    const ri = Math.round(toNum(o.rotation));
    if (o.rotation != null && Number.isFinite(ri)) idx = ri >= 0 && ri < C.rotations.length ? [ri] : [];
    const rotations = idx.map((i) => runRotation(C, i, iterations, seed).result);
    let best = -1;
    rotations.forEach((r, i) => { if (best < 0 || r.value > rotations[best].value) best = i; });
    return { rotations, best };
  } catch (err) {
    return { rotations: [], best: -1, error: String(err && err.message) };
  }
}

// ------------------------------------------------------------ stat weights

// Whether raising a stat can change anything in this model.
function relevantStats(m) {
  const healMetric = m.kind === 'healing';
  const ab = m.abilities.map((a) => ({ ...a, heal: a.type === 'heal' || healMetric }));
  const dmgAb = ab.filter((a) => !a.heal);
  const uses = (list, f) => list.some(f);
  const ap = (a) => (a.damage && (a.damage.apCoef > 0 || a.damage.weaponPct > 0)) || (a.dot && a.dot.apCoefPerTick > 0);
  const sp = (a) => (a.damage && a.damage.spCoef > 0) || (a.dot && a.dot.spCoefPerTick > 0);
  const crits = (a) => (a.damage && a.canCrit) || (a.dot && a.dot.canCrit);
  const melee = dmgAb.filter((a) => a.type === 'melee'), ranged = dmgAb.filter((a) => a.type === 'ranged');
  const spells = dmgAb.filter((a) => a.type === 'spell'), heals = ab.filter((a) => a.heal);
  const procDmg = healMetric ? [] : m.procs.filter((p) => p.effect.damage);
  const physProc = procDmg.filter((p) => p.effect.damage.school === 'physical');
  const magicProc = procDmg.filter((p) => p.effect.damage.school !== 'physical');
  const auto = !healMetric && m.player.autoAttack;
  const hasRanged = !!m.player.weapons.ranged;
  const R = {
    attackPower: auto === 'melee' || uses(melee, ap) || uses(procDmg, (p) => p.effect.damage.apCoef > 0),
    rangedAttackPower: hasRanged && (auto === 'ranged' || uses(ranged, ap)),
    spellPower: uses(spells, sp) || uses(melee, sp) || uses(procDmg, (p) => p.effect.damage.spCoef > 0),
    healingPower: uses(heals, sp) || (healMetric && uses(m.procs, (p) => p.effect.damage && p.effect.damage.spCoef > 0)),
    critPct: auto === 'melee' || uses(melee, crits) || uses(physProc, (p) => p.effect.damage.canCrit),
    rangedCritPct: hasRanged && (auto === 'ranged' || uses(ranged, crits)),
    spellCritPct: uses(spells, crits) || uses(heals, crits) || uses(magicProc, (p) => p.effect.damage.canCrit),
    hitPct: auto === 'melee' || auto === 'ranged' || uses([...melee, ...ranged], (a) => a.canMiss),
    spellHitPct: uses(spells, (a) => a.canMiss),
    hastePct: auto === 'melee' || auto === 'ranged',
  };
  return R;
}

// Copies the model with one stat raised (primary stats through statConversions).
function raised(m, stat, delta) {
  const c = structuredClone(m);
  const s = c.player.stats;
  if (STAT_KEYS.includes(stat)) { s[stat] += delta; return c; }
  for (const [target, per] of Object.entries(m.statConversions[stat] || {})) {
    const v = per * delta;
    if (STAT_KEYS.includes(target)) s[target] += v;
    else if (target === 'mana') { const r = c.player.resource; if (r.start >= r.max) r.start += v; r.max += v; }
    else if (target === 'regenPerSec') c.player.resource.regenPerSec += v;
    else if (target === 'mp5') c.player.resource.regenPerSec += v / 5;
  }
  return c;
}

/**
 * Value of one point of each stat for one rotation, from paired runs with
 * common random numbers. Weights inside the noise are reported as 0;
 * irrelevant stats are left out.
 */
export function statWeights(model, opts = {}) {
  try {
    const { model: m, fatal } = normalizeModel(model);
    const { iterations, seed, o, metric: rank } = readOpts(opts);
    const metric = rank || (m.kind === 'healing' ? 'hps' : 'dps');
    if (fatal || !m.rotations.length) return { metric, base: 0, perPoint: {}, normalized: {}, reference: null };
    const C = compile(m, rank);
    let ri = Math.round(toNum(o.rotation));
    let base;
    if (o.rotation != null && Number.isFinite(ri) && ri >= 0 && ri < C.rotations.length) base = runRotation(C, ri, iterations, seed);
    else {
      ri = -1;
      C.rotations.forEach((_, i) => { const r = runRotation(C, i, iterations, seed); if (!base || r.result.value > base.result.value) { base = r; ri = i; } });
    }
    const rel = relevantStats(m);
    const stats = Array.isArray(o.stats) ? o.stats : WEIGHT_STATS;
    const perPoint = {};
    for (const stat of stats) {
      let delta = RULES.WEIGHT_DELTA[stat];
      if (delta === undefined) {
        const conv = m.statConversions[stat];
        if (!conv || !Object.keys(conv).some((t) => !STAT_KEYS.includes(t) || rel[t])) continue;
        delta = RULES.PRIMARY_DELTA;
      } else if (!rel[stat]) continue;
      const run = runRotation(compile(raised(m, stat, delta), rank), ri, iterations, seed);
      const n = iterations;
      const diffs = run.values.map((v, i) => v - base.values[i]);
      const mean = diffs.reduce((x, y) => x + y, 0) / n;
      const sd = n > 1 ? Math.sqrt(diffs.reduce((x, y) => x + (y - mean) ** 2, 0) / (n - 1)) : 0;
      const noise = RULES.NOISE_SIGMAS * sd / Math.sqrt(n);
      perPoint[stat] = Math.abs(mean) <= Math.max(noise, 1e-9 * Math.max(1, base.result.value)) ? 0 : mean / delta;
    }
    const order = metric === 'hps' ? ['healingPower']
      : m.player.autoAttack === 'ranged' ? ['rangedAttackPower', 'attackPower', 'spellPower']
        : m.player.autoAttack === 'melee' ? ['attackPower', 'rangedAttackPower', 'spellPower']
          : ['spellPower', 'attackPower', 'rangedAttackPower'];
    const reference = order.find((s) => perPoint[s] > 0) || null;
    const normalized = {};
    if (reference) for (const [s, v] of Object.entries(perPoint)) normalized[s] = v / perPoint[reference];
    return { metric, base: base.result.value, perPoint, normalized, reference, rotation: ri };
  } catch (err) {
    return { metric: 'dps', base: 0, perPoint: {}, normalized: {}, reference: null, error: String(err && err.message) };
  }
}

// ------------------------------------------------------------ ability table

// Expected value of one use, no RNG: hit chance, crit, armor, all channel
// ticks and the dot's full duration, at the model's stats with permanent
// modifiers and initial buffs.
function expectedUse(S, a) {
  const C = S.C, st = stats(S, a.ctx);
  const land = !a.canMiss || a.heal ? 1 : clamp(1 - (st.miss + st.dodge) / 100, 0, 1);
  let v = 0;
  if (a.damage) {
    const d = a.damage;
    let avg = (d.min + d.max) / 2 + st.ap * d.apCoef + st.sp * d.spCoef;
    const w = d.weaponPct > 0 ? C.weapons[d.weapon] : null;
    if (w) avg += (d.weaponPct / 100) * ((w.min + w.max) / 2 + (st.ap / RULES.AP_PER_DPS) * (d.normalizedSpeed > 0 ? d.normalizedSpeed : w.speed));
    const critF = a.canCrit ? 1 + (clamp(st.crit, 0, 100) / 100) * (st.critMult - 1) : 1;
    v += avg * st.dmgMult * st.armorMult * a.targetsMult * critF * land * Math.max(1, a.channelTicks);
  }
  if (a.dot) {
    const ds = stats(S, a.dotCtx), d = a.dot;
    const per = (d.tickDamage + ds.ap * d.apCoefPerTick + ds.sp * d.spCoefPerTick) * ds.dmgMult;
    const critF = d.canCrit ? 1 + (clamp(ds.crit, 0, 100) / 100) * (ds.critMult - 1) : 1;
    v += per * a.dotTicks * critF * land;
  }
  return v;
}

/**
 * Analytic per-use, per-second and per-resource values of every ability.
 * With opts.metric "tps" the values are threat instead of damage.
 */
export function abilityTable(model, opts = {}) {
  try {
    const { model: m } = normalizeModel(model);
    const { metric } = readOpts(opts);
    const C = compile(m, metric);
    const S = newState(C, 1, 0);
    return C.ab.map((a) => {
      const st = stats(S, a.ctx);
      const haste = Math.max(0.1, 1 + st.castHaste / 100);
      const castTime = a.castTime / haste;
      const gcd = a.gcd > 0 && !a.nextSwing ? (a.spellLike ? Math.max(Math.min(RULES.GCD_MIN, a.gcd), a.gcd / haste) : a.gcd) : RULES.OFF_GCD_TIME;
      let perUse = expectedUse(S, a);
      if (C.threatMetric) {
        const land = !a.canMiss || a.heal ? 1 : clamp(1 - (st.miss + st.dodge) / 100, 0, 1);
        perUse = perUse * C.thrMult[a.src] + a.threatFlat * land;
      }
      const cost = C.resOn ? a.cost * st.costMult : 0;
      return { id: a.id, name: a.name, perUse, perSecond: perUse / Math.max(castTime, gcd), perResource: cost > 0 ? perUse / cost : null, castTime };
    });
  } catch {
    return [];
  }
}

// --------------------------------------------------------------- survival

// The player's defensive numbers as the addon read them from the game
// (armory_combat), each a finite number or left out.
const DEFENSE_INPUTS = ['armor', 'maxHealth', 'dodgePct', 'parryPct', 'blockPct', 'blockValue', 'defense'];
function defenseOf(raw, level) {
  const src = asObj(raw);
  const out = { level: Number.isFinite(toNum(src.level)) && toNum(src.level) > 0 ? toNum(src.level) : level };
  for (const k of DEFENSE_INPUTS) {
    const v = toNum(src[k]);
    if (Number.isFinite(v) && v >= 0) out[k] = v;
  }
  return out;
}

// One enemy swing against the player: the chance (percent) of each outcome
// on Classic's single-roll table, in its order. What is left is a plain hit.
function attackTable(d, enemy, useBlock) {
  const R = DEFENSE;
  const defense = d.defense !== undefined ? d.defense : R.SKILL_PER_LEVEL * d.level;
  const skill = R.SKILL_PER_LEVEL * enemy.level - defense;
  // The sheet's dodge, parry and block are against an enemy of the player's
  // own level; each level above takes SKILL_PER_LEVEL * PER_SKILL off them.
  const levelShift = R.PER_SKILL * R.SKILL_PER_LEVEL * (enemy.level - d.level);
  const wanted = {
    miss: R.MOB_MISS - R.PER_SKILL * skill,
    dodge: (d.dodgePct || 0) - levelShift,
    parry: (d.parryPct || 0) - levelShift,
    block: useBlock ? (d.blockPct || 0) - levelShift : 0,
    crit: R.MOB_CRIT + R.PER_SKILL * skill,
    crush: enemy.level - d.level >= R.CRUSH_MIN_LEVEL_DIFF ? R.CRUSH_PER_SKILL * skill - R.CRUSH_OFFSET : 0,
  };
  const table = {};
  let left = 100;
  for (const [k, v] of Object.entries(wanted)) {
    table[k] = Math.min(left, Math.max(0, v));
    left -= table[k];
  }
  table.hit = left;
  return table;
}

// The expected numbers per second, split so that avoided + armor + blocked +
// taken add up to the incoming damage (avoided swings counted as plain hits).
function survivalNumbers(d, enemy, useBlock) {
  const melee = enemy.meleeHit > 0;
  const table = attackTable(d, enemy, useBlock);
  const p = (k) => table[k] / 100;
  const dr = armorReduction(d.armor || 0, enemy.level);
  const perSec = melee ? enemy.meleeHit / enemy.attackSpeed : 0;
  const landing = perSec * (p('hit') + p('block') + DEFENSE.MOB_CRIT_MULT * p('crit') + DEFENSE.CRUSH_MULT * p('crush'));
  const afterArmor = enemy.meleeHit * (1 - dr);
  const blocked = melee ? (p('block') * Math.min(afterArmor, d.blockValue || 0)) / enemy.attackSpeed : 0;
  const avoided = perSec * (p('miss') + p('dodge') + p('parry'));
  const armor = landing * dr;
  const meleeTaken = landing * (1 - dr) - blocked;
  const incoming = avoided + armor + blocked + meleeTaken + enemy.magicDps;
  const taken = meleeTaken + enemy.magicDps;
  const out = { table, armorReduction: dr, incoming, taken, avoided, armor, blocked };
  if (d.maxHealth > 0 && taken > 0) {
    out.timeToDie = d.maxHealth / taken;
    out.effectiveHealth = (d.maxHealth * incoming) / taken;
  }
  return out;
}

/**
 * What a tank can expect to take from one enemy, analytically: the attack
 * table, damage taken per second, how much is mitigated and how, effective
 * health and seconds to die with no healing, and what each defensive stat
 * is worth (finite differences on the same formula). defense: the game's
 * numbers (armor, maxHealth, dodgePct, parryPct, blockPct, blockValue,
 * defense, level); enemy: the model's normalized "enemy". A missing input is
 * listed in `missing` and its part left out; nothing is guessed except the
 * defense skill, taken as SKILL_PER_LEVEL per level when the game gave none.
 */
export function survival(rawDefense, enemy, { level = 60 } = {}) {
  try {
    if (!enemy || !(enemy.meleeHit > 0 || enemy.magicDps > 0)) return { missing: ['enemy'] };
    const d = defenseOf(rawDefense, level);
    const missing = [];
    const melee = enemy.meleeHit > 0;
    if (melee) {
      for (const k of ['armor', 'dodgePct', 'parryPct', 'blockPct']) if (d[k] === undefined) missing.push(k);
      if (d.defense === undefined) missing.push('defense');
    }
    // A block of unknown size is left out: blocks then count as hits.
    const useBlock = d.blockPct > 0 && d.blockValue !== undefined;
    if (melee && d.blockPct > 0 && d.blockValue === undefined) missing.push('blockValue');
    if (d.maxHealth === undefined) missing.push('maxHealth');
    const base = survivalNumbers(d, enemy, useBlock);
    const worth = {};
    const known = {
      armor: melee && d.armor !== undefined,
      dodgePct: melee && d.dodgePct !== undefined,
      parryPct: melee && d.parryPct !== undefined,
      blockPct: melee && useBlock,
      blockValue: melee && useBlock,
      stamina: d.maxHealth !== undefined,
    };
    for (const [stat, amount] of Object.entries(DEFENSE.WORTH)) {
      if (!known[stat]) continue;
      const more = { ...d };
      if (stat === 'stamina') more.maxHealth += amount * DEFENSE.HEALTH_PER_STAMINA;
      else more[stat] += amount;
      const after = survivalNumbers(more, enemy, useBlock);
      const w = { amount, taken: base.taken - after.taken };
      if (base.timeToDie !== undefined && after.timeToDie !== undefined) w.time = after.timeToDie - base.timeToDie;
      worth[stat] = w;
    }
    return { enemy: { ...enemy }, ...base, health: d.maxHealth, worth, missing };
  } catch (err) {
    return { missing: ['enemy'], error: String(err && err.message) };
  }
}
