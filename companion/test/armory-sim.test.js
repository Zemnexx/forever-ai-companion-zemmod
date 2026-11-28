// The Armory combat simulator: hand-computable fights, stat weights, the
// analytic ability table and the repairs normalizeModel makes to sloppy models.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFENSE, RULES, abilityTable, armorReduction, mulberry32, normalizeModel, simulate, statWeights, survival,
} from '../src/armory/sim/engine.js';

const near = (actual, expected, tol, msg) => {
  const err = Math.abs(actual - expected) / Math.max(1e-9, Math.abs(expected));
  assert.ok(err <= tol, `${msg || 'value'}: ${actual} vs ${expected} (${(err * 100).toFixed(2)}% off)`);
};

// A level 60 player against a level 60, 0 armor target; overrides merge in.
function base(over = {}) {
  return {
    kind: 'damage',
    fight: { duration: 180, targets: 1, targetLevel: 60, targetArmor: 0, ...(over.fight || {}) },
    player: {
      level: 60,
      stats: { attackPower: 0, critPct: 0, ...(over.stats || {}) },
      weapons: over.weapons !== undefined ? over.weapons : { mainHand: { min: 100, max: 200, speed: 2 } },
      autoAttack: over.autoAttack || 'melee',
      resource: over.resource || { type: 'none' },
      modifiers: over.modifiers || [],
    },
    abilities: over.abilities || [],
    buffs: over.buffs || [],
    procs: over.procs || [],
    statConversions: over.statConversions || {},
    rotations: over.rotations || [{ name: 'auto', actions: [] }],
    ...(over.kind ? { kind: over.kind } : {}),
  };
}
const entry = (res, id) => res.breakdown.find((b) => b.id === id);
const run = (m, opts) => simulate(normalizeModel(m).model, { iterations: 200, ...opts });

test('mulberry32 is deterministic and in [0, 1)', () => {
  const a = mulberry32(42), b = mulberry32(42), c = mulberry32(43);
  const xs = Array.from({ length: 1000 }, () => a());
  assert.deepEqual(xs.slice(0, 5), Array.from({ length: 5 }, () => b()));
  assert.notEqual(xs[0], c());
  assert.ok(xs.every((x) => x >= 0 && x < 1));
  near(xs.reduce((s, x) => s + x, 0) / xs.length, 0.5, 0.05, 'mean');
});

test('armor reduction: 3700 armor at level 60 is 38.6%, lower levels and the cap', () => {
  near(armorReduction(3700, 60), 3700 / (3700 + 5882.5), 1e-9);
  near(armorReduction(3700, 60), 0.386, 0.002);
  near(armorReduction(3700, 40), 3700 / (3700 + 400 + 85 * 40), 1e-9);
  near(armorReduction(1000, 20), 1000 / (1000 + 400 + 1700), 1e-9);
  assert.equal(armorReduction(1e7, 60), RULES.ARMOR_CAP);
  assert.equal(armorReduction(-50, 60), 0);
});

test('auto attack only vs an equal-level 0 armor target matches the attack table', () => {
  const m = base({ stats: { attackPower: 280 } });
  const r = run(m).rotations[0];
  // avg weapon 150 + 280 / 14 * 2 = 190; 5% miss, 5% dodge, 10% glancing at 95%.
  const perSwing = 190 * (0.80 + 0.10 * 0.95);
  near(r.value, perSwing / 2, 0.02, 'dps');
  assert.equal(r.metric, 'dps');
  near(r.autoAttackShare, 100, 1e-9);
  near(entry(r, 'auto').perMinute, 30, 0.01, 'swings per minute');
});

test('auto attack vs a raid boss: miss, dodge, glancing, crit suppression and armor', () => {
  const m = base({ fight: { targetLevel: 63, targetArmor: 3700 }, stats: { critPct: 10 }, weapons: { mainHand: { min: 200, max: 200, speed: 2 } } });
  const r = run(m, { iterations: 400 }).rotations[0];
  const crit = (10 - 3 - 1.8) / 100;
  const perSwing = 200 * ((1 - 0.08 - 0.065 - 0.40 - crit) + 0.40 * 0.65 + crit * 2) * (1 - armorReduction(3700, 60));
  near(r.value, perSwing / 2, 0.02, 'dps');
});

test('dual wielding adds 19% white miss and the off hand deals half damage', () => {
  const m = base({ weapons: { mainHand: { min: 100, max: 100, speed: 2 }, offHand: { min: 100, max: 100, speed: 2 } } });
  const r = run(m, { iterations: 400 }).rotations[0];
  const perSwing = 100 * (1 - 0.24 - 0.05 - 0.10) + 100 * 0.10 * 0.95;
  near(r.value, (perSwing * 1.5) / 2, 0.02, 'dps');
});

test('a 6 second cooldown instant is used about 30 times in 180 seconds', () => {
  const m = base({
    autoAttack: 'none', weapons: null,
    abilities: [{ id: 'strike', name: 'Strike', type: 'spell', school: 'fire', cooldown: 6, canMiss: false, damage: { min: 100, max: 100 } }],
    rotations: [{ name: 'r', actions: ['strike'] }],
  });
  const r = run(m).rotations[0];
  near(entry(r, 'strike').perMinute * 3, 30, 0.01, 'uses');
  near(r.value, 3000 / 180, 0.01, 'dps');
  assert.ok(r.idlePct > 70, 'idle between cooldowns');
});

test('spell-only rotation: casts = duration / castTime and DPS matches miss and crit', () => {
  const m = base({
    autoAttack: 'none', weapons: null, stats: { spellCritPct: 10 },
    abilities: [{ id: 'bolt', name: 'Frostbolt', type: 'spell', school: 'frost', castTime: 2.5, damage: { min: 400, max: 600 } }],
    rotations: [{ name: 'spam', actions: ['bolt'] }],
  });
  const r = run(m, { iterations: 400 }).rotations[0];
  near(entry(r, 'bolt').perMinute * 3, 180 / 2.5, 0.02, 'casts');
  near(r.value, (500 * 0.96 * (1 + 0.1 * 0.5)) / 2.5, 0.02, 'dps');
  near(entry(r, 'bolt').critPct, 10, 0.15, 'crit %');
  assert.ok(r.idlePct < 1, 'never idle');
});

test('cast haste shortens casts and the spell GCD, but not below 1 second', () => {
  const m = base({
    autoAttack: 'none', weapons: null,
    modifiers: [{ stat: 'castHastePct', value: 100 }],
    abilities: [
      { id: 'bolt', name: 'Bolt', type: 'spell', castTime: 3, canMiss: false, canCrit: false, damage: { min: 100, max: 100 } },
      { id: 'zap', name: 'Zap', type: 'spell', canMiss: false, canCrit: false, damage: { min: 100, max: 100 } },
    ],
    rotations: [{ name: 'bolt', actions: ['bolt'] }, { name: 'zap', actions: ['zap'] }],
  });
  const [bolt, zap] = run(m, { iterations: 5 }).rotations;
  near(bolt.value, 100 / 1.5, 0.02, 'hasted cast');
  near(zap.value, 100 / 1.0, 0.02, 'GCD floored at 1 s');
});

test('dot ticks floor(duration / interval) times and a buffDown condition keeps it up', () => {
  const m = base({
    autoAttack: 'none', weapons: null,
    abilities: [
      { id: 'corruption', name: 'Corruption', type: 'spell', school: 'shadow', canMiss: false, dot: { tickDamage: 100, interval: 3, duration: 18 } },
      { id: 'filler', name: 'Filler', type: 'spell', canMiss: false, canCrit: false, damage: { min: 1, max: 1 } },
    ],
    rotations: [{ name: 'keep up', actions: [{ use: 'corruption', if: { buffDown: 'corruption' } }, 'filler'] }],
  });
  const r = run(m, { iterations: 3 }).rotations[0];
  assert.ok(r.uptime.corruption > 99, `uptime ${r.uptime.corruption}`);
  const dot = entry(r, 'corruption');
  near(dot.average, 600, 0.02, 'six ticks per application');
  near(dot.perMinute * 3, 10, 0.01, 'applications');
});

test('a buffDown condition keeps a debuff up about 100% of the fight', () => {
  const m = base({
    autoAttack: 'none', weapons: null,
    buffs: [{ id: 'weak', name: 'Weakness', onTarget: true, duration: 10, modifiers: [{ stat: 'damagePct', value: 10 }] }],
    abilities: [
      { id: 'curse', name: 'Curse', type: 'spell', school: 'shadow', canMiss: false, applies: ['weak'] },
      { id: 'bolt', name: 'Bolt', type: 'spell', canCrit: false, canMiss: false, damage: { min: 100, max: 100 } },
    ],
    rotations: [
      { name: 'alone', actions: [{ use: 'curse', if: { buffDown: 'weak' } }] },
      // With a filler, refresh before it runs out (a GCD is 1.5 s).
      { name: 'filler', actions: [{ use: 'curse', if: { buffRemainsBelow: { id: 'weak', sec: 1.5 } } }, 'bolt'] },
    ],
  });
  const [alone, filler] = run(m).rotations;
  assert.ok(alone.uptime.weak > 99.9, `uptime ${alone.uptime.weak}`);
  assert.ok(filler.uptime.weak > 99.9, `uptime ${filler.uptime.weak}`);
  near(entry(filler, 'bolt').average, 110, 0.001, 'the debuff boosts damage');
});

test('energy ticks limit how often an ability can be used', () => {
  const m = base({
    autoAttack: 'none', weapons: null,
    resource: { type: 'energy', max: 100, start: 100, tick: { amount: 20, interval: 2 } },
    abilities: [{ id: 'ss', name: 'Sinister Strike', cost: 40, gcd: 1, canMiss: false, canCrit: false, damage: { min: 100, max: 100 } }],
    rotations: [{ name: 'r', actions: ['ss'] }],
  });
  const r = run(m, { iterations: 5 }).rotations[0];
  const uses = entry(r, 'ss').perMinute * 3;
  // 100 start + 89 ticks of 20 = 1880 energy: 47 uses at most.
  assert.ok(uses >= 45 && uses <= 47, `uses ${uses}`);
  assert.ok(r.resource.starvedPct > 30, 'waiting for energy');
  assert.ok(r.resource.wasted < 20, 'little energy wasted');
  assert.equal(r.resource.emptyAt, null, 'emptyAt is for mana only');
});

test('rage comes from auto attacks that hit (perSwing)', () => {
  const m = base({
    weapons: { mainHand: { min: 100, max: 100, speed: 2 } },
    resource: { type: 'rage', max: 100, perSwing: { perDamage: 0.1 } },
  });
  const r = run(m, { iterations: 300 }).rotations[0];
  const gained = 90 * (0.8 * 10 + 0.1 * 9.5);
  near(r.resource.wasted, gained - 100, 0.03, 'rage over the cap');
});

test('rage pays for abilities and the 20% cost rule on misses', () => {
  const m = base({
    weapons: { mainHand: { min: 100, max: 100, speed: 2 } },
    resource: { type: 'rage', max: 100, perSwing: { perDamage: 0.1 } },
    abilities: [{ id: 'bt', name: 'Bloodthirst', cost: 30, cooldown: 6, damage: { min: 200, max: 200 } }],
    rotations: [{ name: 'r', actions: ['bt'] }],
  });
  const r = run(m).rotations[0];
  const bt = entry(r, 'bt');
  assert.ok(bt.perMinute * 3 > 20 && bt.perMinute * 3 <= 30, `uses ${bt.perMinute * 3}`);
  assert.ok(r.resource.wasted < 400);
  assert.equal(RULES.MISSED_ABILITY_COST, 0.2);
});

test('an execute that requires targetHealthBelow 20 only fires in the last 20% of the fight', () => {
  const m = base({
    autoAttack: 'none', weapons: null,
    abilities: [{ id: 'execute', name: 'Execute', canMiss: false, canCrit: false, damage: { min: 1000, max: 1000 }, requires: { targetHealthBelow: 20 } }],
    rotations: [{ name: 'r', actions: ['execute'] }],
  });
  const r = run(m, { iterations: 2 }).rotations[0];
  const uses = entry(r, 'execute').perMinute * 3;
  assert.ok(uses >= 23 && uses <= 25, `uses ${uses}`); // 36 s / 1.5 s GCD
  assert.ok(r.idlePct > 75 && r.idlePct < 82, `idle ${r.idlePct}`);
});

test('a nextSwing ability replaces white hits and cannot glance', () => {
  const m = base({
    weapons: { mainHand: { min: 100, max: 100, speed: 2 } },
    abilities: [{ id: 'hs', name: 'Heroic Strike', nextSwing: true, canCrit: false, damage: { weaponPct: 100, min: 50, max: 50 } }],
    rotations: [{ name: 'hs', actions: ['hs'] }],
  });
  const r = run(m, { iterations: 300 }).rotations[0];
  assert.equal(entry(r, 'auto'), undefined, 'no white swings left');
  near(entry(r, 'hs').perMinute, 30, 0.01, 'one per swing');
  near(r.value, (150 * 0.90) / 2, 0.02, 'yellow table: miss and dodge only');
});

test('nextSwing falls back to a white hit when it cannot be paid', () => {
  const m = base({
    weapons: { mainHand: { min: 100, max: 100, speed: 2 } },
    resource: { type: 'rage', max: 100, perSwing: { perDamage: 0.1 } },
    abilities: [{ id: 'hs', name: 'Heroic Strike', nextSwing: true, cost: 15, damage: { weaponPct: 100, min: 50, max: 50 } }],
    rotations: [{ name: 'hs', actions: ['hs'] }],
  });
  const r = run(m).rotations[0];
  assert.ok(entry(r, 'hs') && entry(r, 'auto'), 'both kinds of swing');
  near(entry(r, 'hs').perMinute + entry(r, 'auto').perMinute, 30, 0.01, 'one swing every 2 s');
});

test('procs respect their internal cooldown', () => {
  const m = base({
    procs: [{ id: 'zap', name: 'Lightning', trigger: 'meleeHit', chance: 1, icd: 10, effect: { damage: { min: 100, max: 100, school: 'nature', canCrit: false } } }],
  });
  const r = run(m).rotations[0];
  const zap = entry(r, 'zap');
  assert.ok(zap.perMinute <= 6.4 && zap.perMinute >= 5.5, `procs/min ${zap.perMinute}`);
  near(zap.average, 100, 1e-9);
});

test('ppm procs: chance = ppm * speed / 60, extra attacks and buffs', () => {
  const m = base({
    weapons: { mainHand: { min: 100, max: 100, speed: 3 } },
    buffs: [{ id: 'crusader', name: 'Crusader', duration: 15, modifiers: [{ stat: 'attackPower', value: 100 }] }],
    procs: [
      { id: 'wf', name: 'Windfury', trigger: 'meleeHit', chance: 0.2, effect: { extraAttacks: 1 } },
      { id: 'cr', name: 'Crusader', trigger: 'meleeHit', ppm: 1, effect: { buff: 'crusader' } },
    ],
  });
  const plain = run(base({ weapons: { mainHand: { min: 100, max: 100, speed: 3 } } }), { iterations: 300 }).rotations[0];
  const r = run(m, { iterations: 300 }).rotations[0];
  const swingsPerMin = entry(r, 'auto').perMinute;
  assert.ok(swingsPerMin > entry(plain, 'auto').perMinute * 1.1, 'extra attacks add swings');
  assert.ok(entry(r, 'cr').perMinute > 0.5 && entry(r, 'cr').perMinute < 1.1, `crusader ${entry(r, 'cr').perMinute}`);
  assert.ok(r.uptime.crusader > 10 && r.uptime.crusader < 30, `uptime ${r.uptime.crusader}`);
});

test('buff charges are consumed by swings', () => {
  const m = base({
    stats: { critPct: 30 },
    buffs: [{ id: 'flurry', name: 'Flurry', duration: 15, charges: 3, chargeOn: 'swing', modifiers: [{ stat: 'hastePct', value: 30 }] }],
    procs: [{ id: 'fl', name: 'Flurry', trigger: 'meleeCrit', chance: 1, effect: { buff: 'flurry' } }],
  });
  const r = run(m).rotations[0];
  assert.ok(r.uptime.flurry > 20 && r.uptime.flurry < 90, `uptime ${r.uptime.flurry}`);
  assert.ok(entry(r, 'auto').perMinute > 31, 'haste adds swings');
});

test('maxTargets multiplies damage up to fight.targets', () => {
  const mk = (targets, maxTargets) => base({
    autoAttack: 'none', weapons: null, fight: { targets },
    abilities: [{ id: 'nova', name: 'Nova', type: 'spell', canMiss: false, canCrit: false, maxTargets, damage: { min: 100, max: 100 } }],
    rotations: [{ name: 'r', actions: ['nova'] }],
  });
  const one = run(mk(1, 20), { iterations: 2 }).rotations[0].value;
  const twenty = run(mk(20, 20), { iterations: 2 }).rotations[0].value;
  const capped = run(mk(20, 5), { iterations: 2 }).rotations[0].value;
  near(twenty / one, 20, 1e-6);
  near(capped / one, 5, 1e-6);
});

test('mana: emptyAt marks when the wanted spell first cannot be paid', () => {
  const m = base({
    autoAttack: 'none', weapons: null,
    resource: { type: 'mana', max: 1000, start: 1000 },
    abilities: [{ id: 'bolt', name: 'Bolt', type: 'spell', cost: 100, canMiss: false, damage: { min: 100, max: 100 } }],
    rotations: [{ name: 'r', actions: ['bolt'] }],
  });
  const r = run(m, { iterations: 2 }).rotations[0];
  near(r.resource.emptyAt, 15, 0.01); // ten casts, one per 1.5 s GCD
  assert.ok(r.resource.starvedPct > 0); // decision points where only mana was missing
  assert.ok(r.idlePct > 90);
});

test('statWeights: attack power and crit count for a melee model, spell power is skipped', () => {
  const m = base({
    fight: { targetLevel: 63, targetArmor: 3700 },
    stats: { attackPower: 1000, critPct: 20, hitPct: 3 },
    weapons: { mainHand: { min: 150, max: 250, speed: 3.6 } },
    resource: { type: 'rage', max: 100, perSwing: { perDamage: 0.05 } },
    abilities: [{ id: 'bt', name: 'Bloodthirst', cost: 30, cooldown: 6, damage: { apCoef: 0.45 } }],
    statConversions: { strength: { attackPower: 2 } },
    rotations: [{ name: 'r', actions: ['bt'] }],
  });
  const w = statWeights(normalizeModel(m).model, { iterations: 200 });
  assert.equal(w.metric, 'dps');
  assert.equal(w.reference, 'attackPower');
  assert.equal(w.normalized.attackPower, 1);
  assert.ok(w.perPoint.attackPower > 0);
  assert.ok(w.perPoint.critPct > 0);
  assert.ok(w.perPoint.hitPct > 0);
  assert.ok(!('spellPower' in w.perPoint), 'spellPower skipped');
  assert.ok(!('intellect' in w.perPoint), 'no conversion: skipped');
  near(w.normalized.strength, 2, 0.02, 'strength gives 2 AP');
});

test('statWeights: hit is worth 0 once miss is capped', () => {
  const m = base({ stats: { attackPower: 500, hitPct: 9 }, weapons: { mainHand: { min: 100, max: 200, speed: 2.5 } } });
  const w = statWeights(normalizeModel(m).model, { iterations: 100 });
  assert.equal(w.perPoint.hitPct, 0);
  assert.ok(w.perPoint.attackPower > 0);
});

test('statWeights for a caster uses spell power as the reference', () => {
  const m = base({
    autoAttack: 'none', weapons: null, stats: { spellPower: 500, spellCritPct: 10 },
    abilities: [{ id: 'bolt', name: 'Bolt', type: 'spell', school: 'fire', castTime: 3, damage: { min: 500, max: 600, spCoef: 1 } }],
    rotations: [{ name: 'r', actions: ['bolt'] }],
  });
  const w = statWeights(normalizeModel(m).model, { iterations: 200 });
  assert.equal(w.reference, 'spellPower');
  near(w.perPoint.spellPower, 0.95 / 3 * (1 + 0.1 * 0.5), 0.05, 'one SP = coefficient / cast time');
  assert.ok(w.perPoint.spellCritPct > 0 && w.perPoint.spellHitPct > 0);
  assert.ok(!('attackPower' in w.perPoint) && !('hastePct' in w.perPoint));
});

test('determinism: same seed same result, different seed slightly different', () => {
  const m = normalizeModel(base({ stats: { attackPower: 500, critPct: 20 } })).model;
  const a = simulate(m, { iterations: 50, seed: 7 });
  const b = simulate(m, { iterations: 50, seed: 7 });
  const c = simulate(m, { iterations: 50, seed: 8 });
  assert.deepEqual(a, b);
  assert.notEqual(a.rotations[0].value, c.rotations[0].value);
  near(a.rotations[0].value, c.rotations[0].value, 0.05, 'same ballpark');
});

test('abilityTable analytic values match the simulation within 3%', () => {
  const m = normalizeModel(base({
    fight: { targetLevel: 63, targetArmor: 3700 },
    autoAttack: 'none', stats: { attackPower: 1000, critPct: 20, hitPct: 2 },
    weapons: { mainHand: { min: 150, max: 250, speed: 3.6 } },
    modifiers: [{ stat: 'damagePct', value: 10, abilities: ['ms'] }],
    abilities: [
      { id: 'ms', name: 'Mortal Strike', cooldown: 6, damage: { weaponPct: 100, min: 160, max: 160, normalizedSpeed: 3.3 } },
      { id: 'rend', name: 'Rend', canCrit: false, canMiss: false, dot: { tickDamage: 30, apCoefPerTick: 0.02, interval: 3, duration: 21 } },
    ],
    rotations: [{ name: 'ms', actions: ['ms'] }, { name: 'rend', actions: [{ use: 'rend', if: { buffDown: 'rend' } }] }],
  })).model;
  const table = abilityTable(m);
  const r = simulate(m, { iterations: 400 }).rotations;
  const ms = table.find((x) => x.id === 'ms');
  near(entry(r[0], 'ms').average, ms.perUse, 0.03, 'mortal strike');
  // Rend never misses here and is reapplied as it ends: a tick every 3 s, 59 in 180 s.
  const rendTick = table.find((x) => x.id === 'rend').perUse / 7;
  near(r[1].value * 180, rendTick * 59, 0.03, 'rend');
  near(ms.perSecond, ms.perUse / 1.5, 1e-9);
  assert.equal(ms.perResource, null, 'no cost');
});

test('healing model: metric hps, healing power, and perResource for mana efficiency', () => {
  const m = normalizeModel({
    kind: 'healing',
    fight: { duration: 120 },
    player: { level: 60, stats: { healingPower: 500, spellCritPct: 10 }, autoAttack: 'none', resource: { type: 'mana', max: 100000, regenPerSec: 0 } },
    abilities: [
      { id: 'gh', name: 'Greater Heal', type: 'heal', castTime: 3, cost: 700, damage: { min: 2000, max: 2400, spCoef: 0.857 } },
      { id: 'fh', name: 'Flash Heal', type: 'heal', castTime: 1.5, cost: 380, damage: { min: 800, max: 960, spCoef: 0.43 } },
    ],
    rotations: [{ name: 'gh', actions: ['gh'] }, { name: 'fh', actions: ['fh'] }],
  }).model;
  const table = abilityTable(m);
  const gh = table.find((x) => x.id === 'gh');
  const avg = (2200 + 500 * 0.857) * (1 + 0.1 * 0.5);
  near(gh.perUse, avg, 1e-9, 'heals never miss');
  near(gh.perResource, avg / 700, 1e-9);
  near(gh.perSecond, avg / 3, 1e-9);
  const r = simulate(m, { iterations: 200 });
  assert.equal(r.rotations[0].metric, 'hps');
  near(r.rotations[0].value, avg / 3, 0.03, 'hps');
  assert.equal(r.rotations[0].autoAttackShare, 0);
  const w = statWeights(m, { iterations: 100, rotation: 0 });
  assert.equal(w.metric, 'hps');
  assert.equal(w.reference, 'healingPower');
  assert.ok(!('spellPower' in w.perPoint));
});

test('best picks the better of two rotations', () => {
  const m = base({
    autoAttack: 'none', weapons: null,
    abilities: [
      { id: 'weak', name: 'Weak', type: 'spell', canMiss: false, damage: { min: 100, max: 100 } },
      { id: 'strong', name: 'Strong', type: 'spell', canMiss: false, damage: { min: 300, max: 300 } },
    ],
    rotations: [{ name: 'weak', actions: ['weak'] }, { name: 'strong', actions: ['strong'] }],
  });
  const r = run(m, { iterations: 10 });
  assert.equal(r.best, 1);
  assert.equal(r.rotations.length, 2);
  const only = run(m, { iterations: 10, rotation: 0 });
  assert.equal(only.rotations.length, 1);
  assert.equal(only.rotations[0].name, 'weak');
});

test('casting resets the melee swing timer', () => {
  const m = base({
    weapons: { mainHand: { min: 100, max: 100, speed: 2 } },
    abilities: [{ id: 'slam', name: 'Slam', castTime: 1.5, cooldown: 5, damage: { min: 1, max: 1 } }],
    rotations: [{ name: 'slam', actions: ['slam'] }],
  });
  const r = run(m, { iterations: 2 }).rotations[0];
  // Every 5 s: a 1.5 s cast, then a full 2 s timer; the next Slam resets it again
  // before a second swing can land, so one swing per cycle.
  near(entry(r, 'auto').perMinute, 12, 0.02, 'swings per minute');
  const free = run({ ...m, abilities: [{ ...m.abilities[0], castTime: 0 }] }, { iterations: 2 }).rotations[0];
  near(entry(free, 'auto').perMinute, 30, 0.01, 'instants do not touch the swing timer');
});

test('normalizeModel: coerces strings, fills defaults and clamps absurd values', () => {
  const { model, problems, fatal } = normalizeModel({
    fight: { duration: '2000', targets: 50, targetLevel: '70' },
    player: { level: '60', stats: { attackPower: '1200', critPct: 150, hitPct: -4 }, weapons: { mainHand: { min: '100', max: 50, speed: '2.6' } } },
    abilities: [{ id: 'bt', damage: { apCoef: '0.45' }, cost: '-30' }],
    procs: [{ id: 'p', trigger: 'meleeHit', chance: 20, effect: { resource: 5 } }],
    rotations: [{ actions: ['bt'] }],
  });
  assert.equal(fatal, false);
  assert.equal(model.fight.duration, 900);
  assert.equal(model.fight.targets, 20);
  assert.equal(model.fight.targetLevel, 63);
  assert.equal(model.player.stats.attackPower, 1200);
  assert.equal(model.player.stats.critPct, 100);
  assert.equal(model.player.stats.hitPct, 0);
  assert.deepEqual(model.player.weapons.mainHand, { min: 50, max: 100, speed: 2.6 });
  assert.equal(model.player.autoAttack, 'melee');
  assert.equal(model.abilities[0].cost, 0);
  assert.equal(model.abilities[0].gcd, 1.5);
  assert.equal(model.abilities[0].damage.apCoef, 0.45);
  assert.equal(model.procs[0].chance, 0.2);
  assert.equal(model.rotations[0].name, 'Rotation 1');
  assert.ok(problems.some((p) => /fight.duration 2000 is out of range/.test(p)));
  assert.ok(problems.some((p) => /chance 20/.test(p)));
  // Normalizing twice changes nothing.
  assert.deepEqual(normalizeModel(model).model, model);
});

test('normalizeModel: reports each kind of bad input in words an AI can act on', () => {
  const { model, problems, fatal } = normalizeModel({
    player: { weapons: { mainHand: { min: 1, max: 2, speed: 2 } }, modifiers: [{ stat: 'luck', value: 5 }] },
    abilities: [
      { id: 'a', damage: { min: 10, max: 10 }, applies: ['ghost'] },
      { id: 'a', damage: { min: 1, max: 1 } },
      { id: 'idle', name: 'Idle' },
    ],
    procs: [{ id: 'p', trigger: 'sometimes', chance: 1, effect: { resource: 1 } }],
    rotations: [{ name: 'X', actions: ['a', { use: 'a' }, { use: 'foo' }, { use: 'a', if: { buffUp: 'nope', wobble: 1 } }] }],
  });
  assert.equal(fatal, false);
  const has = (re) => assert.ok(problems.some((p) => re.test(p)), `missing ${re}: ${problems.join(' | ')}`);
  has(/rotation "X" action 3 uses unknown ability "foo"/);
  has(/ability ids must be unique: "a"/);
  has(/ability "idle" has no damage, dot, applies or gain: it does nothing/);
  has(/buff "ghost" referenced by ability "a" applies is not defined/);
  has(/unknown stat "luck"/);
  has(/unknown trigger "sometimes"/);
  has(/unknown buff "nope"/);
  has(/unknown key "wobble"/);
  assert.equal(model.abilities.length, 2);
  assert.equal(model.rotations[0].actions.length, 3);
  assert.equal(model.procs.length, 0);
});

test('normalizeModel: fatal when there is nothing to simulate', () => {
  const empty = normalizeModel({});
  assert.equal(empty.fatal, true);
  assert.ok(empty.problems.includes('no rotations'));
  assert.ok(empty.problems.some((p) => /no abilities and no auto attack/.test(p)));
  assert.deepEqual(simulate(empty.model), { rotations: [], best: -1 });
  const noRot = normalizeModel(base({ rotations: [] }));
  assert.equal(noRot.fatal, true);
  assert.equal(normalizeModel(base()).fatal, false, 'auto attack alone is enough');
});

test('never throws on junk, and odd models still finish', () => {
  const junk = [null, undefined, 42, 'not json', '{"rotations":5}', [], [1, 2], { player: 7 }, { abilities: 'x', rotations: [null, 'x', { actions: 'bt' }] },
    { player: { stats: null, weapons: { mainHand: 'sword' }, resource: { type: 'mana', tick: 'x', perSwing: [] } }, buffs: [5, { id: 1 }], procs: { id: 'p' } },
    { fight: { duration: -5, targets: 'many' }, abilities: [{ id: 'x', damage: 'lots', dot: { duration: 0 }, requires: 'always' }], rotations: [{ actions: [{ use: 'x', if: [] }] }] }];
  for (const j of junk) {
    const n = normalizeModel(j);
    assert.ok(n.model && Array.isArray(n.problems));
    assert.ok(Array.isArray(simulate(j, { iterations: 2 }).rotations));
    assert.ok(statWeights(j, { iterations: 2 }).perPoint);
    assert.ok(Array.isArray(abilityTable(j)));
  }
  // A rotation that can never act, a spammed free off-GCD ability,
  // a 0 duration buff and 20 targets all finish.
  const odd = base({
    fight: { targets: 20 },
    buffs: [{ id: 'forever', name: 'Forever', duration: 0, modifiers: [{ stat: 'damagePct', value: 5 }] }],
    abilities: [
      { id: 'never', name: 'Never', damage: { min: 1, max: 1 }, requires: { targetHealthBelow: -1 } },
      { id: 'free', name: 'Free', gcd: 0, maxTargets: 20, damage: { min: 1, max: 1 }, applies: ['forever'] },
    ],
    rotations: [{ name: 'never', actions: ['never'] }, { name: 'free', actions: ['free', 'free'] }],
  });
  const r = run(odd, { iterations: 3 });
  assert.equal(r.rotations.length, 2);
  assert.ok(r.rotations[0].idlePct > 99);
  const free = entry(r.rotations[1], 'free');
  assert.ok(free.perMinute > 0 && free.perMinute < 1000, `free uses/min ${free.perMinute}`);
  assert.ok(r.rotations[1].uptime.forever > 99);
});

test('performance: a typical 8-ability, 180 s model with 300 iterations is fast', (t) => {
  const m = normalizeModel(base({
    fight: { targetLevel: 63, targetArmor: 3700 },
    stats: { attackPower: 1400, critPct: 25, hitPct: 6, hastePct: 0 },
    weapons: { mainHand: { min: 120, max: 220, speed: 2.7 }, offHand: { min: 80, max: 150, speed: 2.4 } },
    resource: { type: 'rage', max: 100, perSwing: { perDamage: 0.035, critMult: 2 } },
    buffs: [
      { id: 'flurry', name: 'Flurry', duration: 15, charges: 3, chargeOn: 'swing', modifiers: [{ stat: 'hastePct', value: 30 }] },
      { id: 'sunder', name: 'Sunder Armor', onTarget: true, duration: 30, maxStacks: 5, modifiers: [{ stat: 'targetArmor', value: -450 }] },
      { id: 'enrage', name: 'Enrage', duration: 12, charges: 12, chargeOn: 'swing', modifiers: [{ stat: 'damagePct', value: 25 }] },
      { id: 'br', name: 'Battle Shout', duration: 120, initial: true, modifiers: [{ stat: 'attackPower', value: 230 }] },
    ],
    abilities: [
      { id: 'bt', name: 'Bloodthirst', cost: 30, cooldown: 6, damage: { apCoef: 0.45 } },
      { id: 'ww', name: 'Whirlwind', cost: 25, cooldown: 10, maxTargets: 4, damage: { weaponPct: 100, normalizedSpeed: 2.4 } },
      { id: 'hs', name: 'Heroic Strike', cost: 15, nextSwing: true, damage: { weaponPct: 100, min: 138, max: 138 } },
      { id: 'ex', name: 'Execute', cost: 15, damage: { min: 600, max: 600 }, requires: { targetHealthBelow: 20 } },
      { id: 'sa', name: 'Sunder Armor', cost: 15, applies: ['sunder'] },
      { id: 'bs', name: 'Battle Shout', cost: 10, applies: ['br'] },
      { id: 'hamstring', name: 'Hamstring', cost: 10, damage: { min: 45, max: 45 } },
      { id: 'br2', name: 'Bloodrage', gcd: 0, cooldown: 60, gain: 20 },
    ],
    procs: [
      { id: 'fl', name: 'Flurry', trigger: 'meleeCrit', chance: 1, effect: { buff: 'flurry' } },
      { id: 'en', name: 'Enrage', trigger: 'meleeCrit', chance: 0.5, effect: { buff: 'enrage' } },
      { id: 'cr', name: 'Crusader', trigger: 'meleeHit', ppm: 1, effect: { damage: { min: 100, max: 100, school: 'holy' } } },
    ],
    rotations: [{
      name: 'fury',
      actions: ['br2', { use: 'sa', if: { not: { buffStacksAtLeast: { id: 'sunder', n: 5 } } } }, { use: 'bs', if: { buffRemainsBelow: { id: 'br', sec: 3 } } },
        'ex', 'bt', 'ww', { use: 'hs', if: { resourceAtLeast: 50 } }, { use: 'hamstring', if: { resourceAtLeast: 60 } }],
    }],
  })).model;
  const t0 = performance.now();
  const r = simulate(m, { iterations: 300 });
  const ms = performance.now() - t0;
  assert.ok(ms < 5000, `took ${ms} ms`);
  assert.ok(r.rotations[0].value > 0);
  assert.ok(r.rotations[0].uptime.sunder > 80, `sunder ${r.rotations[0].uptime.sunder}`);
  t.diagnostic(`300 iterations took ${ms.toFixed(0)} ms`);
});

// ------------------------------------------------------------------ tanks

// Auto attacks and one strike that cannot miss, with threat fields.
function threatModel(over = {}) {
  const m = base({
    stats: { attackPower: 280 },
    abilities: [{ id: 'strike', name: 'Strike', type: 'spell', school: 'holy', cooldown: 6, canMiss: false, canCrit: false,
      damage: { min: 100, max: 100 }, threatMultiplier: 2, threat: 100 }],
    rotations: [{ name: 'r', actions: ['strike'] }],
    ...over,
  });
  m.player.threatMultiplier = 1.5;
  return m;
}

test('threat comes from the same hits as damage, with the multipliers and the flat threat', () => {
  const m = threatModel();
  const dmg = run(m).rotations[0];
  const thr = run(m, { metric: 'tps' }).rotations[0];
  // The same dice: the damage of a threat run is the damage run's, to the last digit.
  assert.equal(thr.dps, dmg.value);
  assert.equal(dmg.metric, 'dps');
  assert.equal(thr.metric, 'tps');
  const uses = entry(dmg, 'strike').perMinute * 3;
  near(uses, 30, 0.01, 'uses');
  const autoDps = (dmg.value * entry(dmg, 'auto').share) / 100;
  const strikeDps = (dmg.value * entry(dmg, 'strike').share) / 100;
  // (damage * ability multiplier + flat) * player multiplier.
  const expected = 1.5 * autoDps + 1.5 * (2 * strikeDps + (100 * uses) / 180);
  near(thr.value, expected, 1e-9, 'tps');
  near(thr.tps, thr.value, 1e-12);
  const shares = thr.breakdown.reduce((n, b) => n + b.share, 0);
  near(shares, 100, 1e-9, 'threat shares');
  near(entry(thr, 'strike').share, (100 * 1.5 * (2 * strikeDps + (100 * uses) / 180)) / expected, 1e-9, 'the strike\'s share of the threat');
  // Without any threat fields a damage run is exactly what it was.
  const plain = base({ stats: { attackPower: 280 }, abilities: [{ id: 'strike', name: 'Strike', type: 'spell', school: 'holy', cooldown: 6, canMiss: false, canCrit: false, damage: { min: 100, max: 100 } }], rotations: [{ name: 'r', actions: ['strike'] }] });
  assert.equal(run(plain).rotations[0].value, dmg.value);
  // Defaults: threat equals damage.
  near(run(plain, { metric: 'tps' }).rotations[0].value, dmg.value, 1e-12, 'multiplier 1, flat 0');
});

test('a tank\'s rotations are ranked by threat, a damage dealer\'s by damage', () => {
  const m = base({
    autoAttack: 'none', weapons: null,
    abilities: [
      { id: 'big', name: 'Big Hit', type: 'spell', school: 'fire', canMiss: false, canCrit: false, damage: { min: 300, max: 300 } },
      { id: 'taunt', name: 'Threat Strike', type: 'spell', school: 'fire', canMiss: false, canCrit: false, damage: { min: 100, max: 100 }, threat: 400 },
    ],
    rotations: [{ name: 'Damage', actions: ['big'] }, { name: 'Threat', actions: ['taunt'] }],
  });
  const dps = run(m);
  const tps = run(m, { metric: 'tps' });
  assert.equal(dps.rotations[dps.best].name, 'Damage');
  assert.equal(tps.rotations[tps.best].name, 'Threat');
  near(tps.rotations[1].value, 500 / 1.5, 1e-9, 'threat per second');
  near(tps.rotations[1].dps, 100 / 1.5, 1e-9, 'its damage per second still comes along');
  // The ability table counts threat too.
  const table = abilityTable(m, { metric: 'tps' });
  near(table.find((r) => r.id === 'taunt').perUse, 500, 1e-9);
  near(abilityTable(m).find((r) => r.id === 'taunt').perUse, 100, 1e-9);
  // Stat weights for a tank are measured on threat.
  const w = statWeights(threatModel(), { metric: 'tps', iterations: 200 });
  assert.equal(w.metric, 'tps');
  assert.ok(w.perPoint.attackPower > 0);
  near(w.base, run(threatModel(), { metric: 'tps' }).rotations[0].value, 1e-9);
});

test('normalizeModel reads threat and the enemy, with defaults and bounds', () => {
  const { model, problems } = normalizeModel({
    ...threatModel(),
    enemy: { meleeHit: '1200', attackSpeed: 0, magicDps: -5 },
  });
  assert.equal(model.player.threatMultiplier, 1.5);
  assert.equal(model.abilities[0].threatMultiplier, 2);
  assert.equal(model.abilities[0].threat, 100);
  assert.deepEqual(model.enemy, { level: 60, meleeHit: 1200, attackSpeed: 0.1, magicDps: 0 });
  assert.ok(problems.some((p) => /enemy\.attackSpeed/.test(p)));
  const plain = normalizeModel(base()).model;
  assert.equal(plain.player.threatMultiplier, 1);
  assert.equal(plain.enemy, undefined);
  // An ability that only makes threat does something.
  const sunder = normalizeModel(base({ abilities: [{ id: 'sunder', name: 'Sunder Armor', threat: 260 }], rotations: [{ name: 'r', actions: ['sunder'] }] }));
  assert.ok(!sunder.problems.some((p) => /does nothing/.test(p)));
});

// A level 60 tank against a level 63 boss, worked out by hand:
//   skill difference 315 - 300 = 15, so 0.6% moves on each line of the table:
//   miss 5 - 0.6 = 4.4, dodge 10 - 0.6 = 9.4, parry 8 - 0.6 = 7.4, block 6 - 0.6 = 5.4,
//   crit 5 + 0.6 = 5.6, crushing 2 * 15 - 15 = 15, hit 100 - 47.2 = 52.8.
//   Armor: 5000 / (5000 + 400 + 85 * (63 + 4.5 * 4)) = 5000 / 12285 = 40.70%.
//   Per second: 1000 / 2 = 500 swung. Avoided 500 * 0.212 = 106.
//   Landing before armor 500 * (0.528 + 0.054 + 2 * 0.056 + 1.5 * 0.15) = 459.5; armor takes 187.02 of it.
//   Blocked 0.054 * 50 / 2 = 1.35. Taken 459.5 * 7285 / 12285 - 1.35 + 20 magic = 291.13.
//   Incoming 106 + 187.02 + 1.35 + 271.13 + 20 = 585.5 (= 500 * 1.131 + 20).
//   Time to die 6000 / 291.13 = 20.61 s; effective health 6000 * 585.5 / 291.13 = 12067.
const TANK = { level: 60, armor: 5000, maxHealth: 6000, dodgePct: 10, parryPct: 8, blockPct: 6, blockValue: 50, defense: 300 };
const BOSS = { level: 63, meleeHit: 1000, attackSpeed: 2, magicDps: 20 };

test('survival against a boss three levels above matches the numbers worked out by hand', () => {
  const s = survival(TANK, BOSS);
  const t = s.table;
  for (const [k, v] of Object.entries({ miss: 4.4, dodge: 9.4, parry: 7.4, block: 5.4, crit: 5.6, crush: 15, hit: 52.8 })) near(t[k], v, 1e-9, k);
  near(s.armorReduction, 5000 / 12285, 1e-12, 'armor');
  near(s.avoided, 106, 1e-9, 'avoided');
  near(s.armor, 459.5 * 5000 / 12285, 1e-9, 'armor per second');
  near(s.blocked, 1.35, 1e-9, 'blocked');
  near(s.taken, (459.5 * 7285) / 12285 - 1.35 + 20, 1e-9, 'taken');
  near(s.taken, 291.13, 1e-4);
  near(s.incoming, 585.5, 1e-9, 'incoming');
  near(s.timeToDie, 20.61, 1e-3, 'time to die');
  near(s.effectiveHealth, 12067, 1e-4, 'effective health');
  assert.deepEqual(s.missing, []);
  // +1% dodge turns 1% of plain hits into dodges: 0.01 * 1000 * 7285 / 12285 / 2 less per second.
  near(s.worth.dodgePct.taken, (0.01 * 1000 * 7285) / 12285 / 2, 1e-9, 'dodge');
  near(s.worth.parryPct.taken, s.worth.dodgePct.taken, 1e-9, 'parry, the same here');
  // +10 block value: 10 more off each block, 5.4% of the swings every 2 seconds.
  near(s.worth.blockValue.taken, (0.054 * 10) / 2, 1e-9, 'block value');
  // +10 stamina is health, not less damage.
  assert.equal(s.worth.stamina.taken, 0);
  near(s.worth.stamina.time, (10 * DEFENSE.HEALTH_PER_STAMINA) / s.taken, 1e-9, 'stamina');
  assert.ok(s.worth.armor.taken > 0 && s.worth.armor.time > 0);
  assert.ok(s.worth.blockPct.taken > 0);
});

test('survival leaves out what the game did not give, and says so', () => {
  // An enemy of the character's level: no crushing blows, nothing moves.
  const even = survival(TANK, { level: 60, meleeHit: 100, attackSpeed: 2, magicDps: 0 });
  assert.equal(even.table.crush, 0);
  near(even.table.miss, 5, 1e-9);
  near(even.table.dodge, 10, 1e-9);
  // Only armor and health known.
  const bare = survival({ armor: 2000, maxHealth: 3000 }, BOSS, { level: 60 });
  assert.deepEqual(bare.missing, ['dodgePct', 'parryPct', 'blockPct', 'defense']);
  assert.equal(bare.table.dodge, 0);
  assert.deepEqual(Object.keys(bare.worth), ['armor', 'stamina']);
  // A block chance without a block value: blocks are left out and counted as hits.
  const noValue = survival({ ...TANK, blockValue: undefined }, BOSS);
  assert.ok(noValue.missing.includes('blockValue'));
  assert.equal(noValue.table.block, 0);
  assert.equal(noValue.worth.blockPct, undefined);
  // No health: no time to die.
  const noHealth = survival({ ...TANK, maxHealth: undefined }, BOSS);
  assert.ok(noHealth.missing.includes('maxHealth'));
  assert.equal(noHealth.timeToDie, undefined);
  assert.equal(noHealth.worth.stamina, undefined);
  // No enemy: nothing to estimate.
  assert.deepEqual(survival(TANK, null), { missing: ['enemy'] });
  assert.deepEqual(survival(TANK, { level: 63, meleeHit: 0, attackSpeed: 2, magicDps: 0 }), { missing: ['enemy'] });
  // Enough defense takes crushing blows off the table.
  near(survival({ ...TANK, defense: 308 }, BOSS).table.crush, 0, 1e-9, 'crush at 308 defense');
  // A table fuller than 100% leaves nothing to hit.
  const wall = survival({ ...TANK, dodgePct: 60, parryPct: 40 }, BOSS);
  near(wall.table.hit, 0, 1e-9);
  near(Object.values(wall.table).reduce((a, b) => a + b, 0), 100, 1e-9);
});

test('usedOnTarget: the ability was used less than 30 seconds ago in this fight', () => {
  // Mark once at the start (its cooldown outlasts the fight); Hit only while Mark counts.
  const abilities = [
    { id: 'mark', name: 'Mark', type: 'spell', school: 'holy', canMiss: false, cooldown: 900, damage: { min: 1, max: 1 } },
    { id: 'hit', name: 'Hit', type: 'spell', school: 'holy', canMiss: false, canCrit: false, damage: { min: 100, max: 100 } },
  ];
  const m = base({
    autoAttack: 'none', weapons: null, fight: { duration: 60 }, abilities,
    rotations: [
      { name: 'never used', actions: [{ use: 'hit', if: { usedOnTarget: 'mark' } }] },
      { name: 'used at the start', actions: ['mark', { use: 'hit', if: { usedOnTarget: 'mark' } }] },
      { name: 'until used', actions: [{ use: 'hit', if: { not: { usedOnTarget: 'mark' }, timeAtLeast: 0 } }, 'mark'] },
    ],
  });
  const [never, used, until] = run(m, { iterations: 5 }).rotations;
  assert.equal(entry(never, 'hit'), undefined, 'never used: false');
  // Hit from 1.5 s (after Mark's global cooldown) while Mark is under 30 seconds old
  // (10 seconds after it: yes; 40 seconds after it: no): 1.5, 3, ... 28.5.
  assert.equal(entry(used, 'hit').perMinute, 19);
  assert.equal(entry(until, 'hit').perMinute, 40, 'Mark never used: its "not" holds all fight');
  const { problems } = normalizeModel(base({ abilities, rotations: [{ name: 'r', actions: [{ use: 'hit', if: { usedOnTarget: 'nothing' } }] }] }));
  assert.ok(problems.some((p) => /usedOnTarget references unknown ability "nothing": ignored/.test(p)), problems.join(' | '));
});

test('usedOnTarget with times: a run of uses, each less than 30 seconds after the one before', () => {
  const abilities = [
    { id: 'mark', name: 'Mark', type: 'spell', school: 'holy', canMiss: false, damage: { min: 1, max: 1 } },
    { id: 'hit', name: 'Hit', type: 'spell', school: 'holy', canMiss: false, canCrit: false, damage: { min: 100, max: 100 } },
  ];
  // Mark every "every" seconds (its "not usedWithin"), Hit while the condition holds.
  const spaced = (name, every, used) => ({ name, actions: [
    { use: 'mark', if: { not: { usedWithin: { id: 'mark', sec: every } } } }, { use: 'hit', if: { usedOnTarget: used } },
  ] });
  const m = base({
    autoAttack: 'none', weapons: null, fight: { duration: 60 }, abilities,
    rotations: [
      spaced('twice, 25 apart', 25, { id: 'mark', times: 2 }),
      spaced('twice, 35 apart', 35, { id: 'mark', times: 2 }),
      spaced('once, 35 apart', 35, { id: 'mark', times: 1 }),
      // Marked for the first 15 seconds only: the run ends 30 seconds after its last use.
      { name: 'run ends', actions: [{ use: 'mark', if: { not: { timeAtLeast: 15 } } }, { use: 'hit', if: { usedOnTarget: { id: 'mark', times: 2 } } }] },
    ],
  });
  assert.deepEqual(normalizeModel(m).model.rotations.map((r) => r.actions[1].if.usedOnTarget), [{ id: 'mark', times: 2 }, { id: 'mark', times: 2 }, 'mark', { id: 'mark', times: 2 }],
    'one use reads as the plain string form');
  const [twice, broken, once, ends] = run(m, { iterations: 5 }).rotations;
  // Mark at 0 and 25: Hit from 26.5 to the end, but for Mark again at 50.
  assert.equal(entry(twice, 'hit').perMinute, 22);
  assert.equal(entry(broken, 'hit'), undefined, 'a 35 second gap starts the run again: never two');
  // Once: 1.5 to 28.5, then 36.5 to the end (Mark at 35).
  assert.equal(entry(once, 'hit').perMinute, 35);
  // Mark at 0, 1.5 ... 13.5; Hit from 15 while the last Mark is under 30 seconds old: 15 ... 42.
  assert.equal(entry(ends, 'hit').perMinute, 19);
});

test('usedWithin: the ability was used less than so many seconds ago, never when it was not used', () => {
  const abilities = [
    { id: 'mark', name: 'Mark', type: 'spell', school: 'holy', canMiss: false, cooldown: 900, damage: { min: 1, max: 1 } },
    { id: 'hit', name: 'Hit', type: 'spell', school: 'holy', canMiss: false, canCrit: false, damage: { min: 100, max: 100 } },
  ];
  const within = (sec) => ({ use: 'hit', if: { usedWithin: { id: 'mark', sec } } });
  const m = base({
    autoAttack: 'none', weapons: null, fight: { duration: 60 }, abilities,
    rotations: [
      { name: 'just inside', actions: ['mark', within(9.1)] },
      { name: 'just outside', actions: ['mark', within(9)] },
      { name: 'never used', actions: [within(30)] },
      { name: 'not within', actions: [{ use: 'hit', if: { not: { usedWithin: { id: 'mark', sec: 30 } }, timeAtLeast: 0 } }, 'mark'] },
    ],
  });
  const [inside, outside, never, notWithin] = run(m, { iterations: 5 }).rotations;
  // Mark at 0, Hit at 1.5, 3 ... 9: the use at 9 is 9 seconds after Mark.
  assert.equal(entry(inside, 'hit').perMinute, 6);
  assert.equal(entry(outside, 'hit').perMinute, 5, 'exactly 9 seconds after is no longer within 9');
  assert.equal(entry(never, 'hit'), undefined, 'never used: false');
  assert.equal(entry(notWithin, 'hit').perMinute, 40, 'never used: its "not" holds all fight');
});

test('usedOnTarget and usedWithin are checked: unknown abilities, times and seconds out of range', () => {
  const abilities = [{ id: 'hit', name: 'Hit', type: 'spell', damage: { min: 100, max: 100 } }];
  const cond = (c) => ({ name: 'r', actions: [{ use: 'hit', if: c }] });
  const { model, problems } = normalizeModel(base({ autoAttack: 'none', weapons: null, abilities, rotations: [
    cond({ usedOnTarget: { id: 'nothing', times: 2 } }), cond({ usedWithin: { id: 'nothing', sec: 5 } }),
    cond({ usedOnTarget: { id: 'hit', times: 6 } }), cond({ usedOnTarget: { id: 'hit', times: 0 } }),
    cond({ usedWithin: { id: 'hit', sec: 0 } }), cond({ usedWithin: { id: 'hit', sec: 301 } }), cond({ usedWithin: { id: 'hit' } }),
  ] }));
  const said = problems.join(' | ');
  for (const p of [
    /action 1 condition usedOnTarget references unknown ability "nothing": ignored/,
    /action 1 condition usedWithin references unknown ability "nothing": ignored/,
    /usedOnTarget\.times 6 is out of range: clamped to 5/,
    /usedOnTarget\.times 0 is out of range: clamped to 1/,
    /usedWithin\.sec 0 is out of range: clamped to 1/,
    /usedWithin\.sec 301 is out of range: clamped to 300/,
    /usedWithin needs an id and a number: ignored/,
  ]) assert.match(said, p);
  assert.deepEqual(model.rotations.map((r) => r.actions[0].if ?? null), [
    null, null, { usedOnTarget: { id: 'hit', times: 5 } }, { usedOnTarget: 'hit' },
    { usedWithin: { id: 'hit', sec: 1 } }, { usedWithin: { id: 'hit', sec: 300 } }, null,
  ]);
});

test('the One Button lists of a model are kept apart from its candidates and its problems', () => {
  const abilities = [{ id: 'hit', name: 'Hit', type: 'spell', damage: { min: 100, max: 100 } }];
  const out = normalizeModel(base({
    autoAttack: 'none', weapons: null, abilities, rotations: [{ name: 'r', actions: ['hit'] }],
  }));
  assert.equal(out.model.oneButton, undefined);
  const withLists = normalizeModel({
    ...base({ autoAttack: 'none', weapons: null, abilities, rotations: [{ name: 'r', actions: ['hit'] }] }),
    oneButton: { short: ['Hit', { use: 'missing' }], long: [{ use: 'hit', if: { usedOnTarget: 'hit', madeUp: 1 } }], other: ['hit'] },
  });
  assert.deepEqual(withLists.model.oneButton, { short: [{ use: 'hit' }], long: [{ use: 'hit', if: { usedOnTarget: 'hit' } }] });
  assert.equal(withLists.model.rotations.length, 1, 'not a candidate');
  assert.deepEqual(withLists.problems, [], 'nothing in them counts as a problem of the model');
  assert.deepEqual(withLists.oneButtonProblems, [
    'oneButton.short action 2 uses unknown ability "missing"',
    'oneButton.long action 1 condition has unknown key "madeUp": ignored',
  ]);
  assert.equal(simulate(withLists.model, { iterations: 2 }).rotations.length, 1);
});
