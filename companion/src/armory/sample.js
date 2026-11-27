// Test mode ("echo" provider): Armory results made without an AI, from the
// character's own data, so the round trip from the game to the app and back
// can be checked for free. They go through the same checks and the same
// simulator as real answers, and say that they are a test.
import { list, num, str } from './json.js';
import { shapeBuild, talentIndex, validateOrder } from './talents.js';
import { SLOTS, shapeGear } from './gear.js';
import { runModel, shapeRotation } from './rotation.js';
import { shapeIdeas } from './discover.js';

// The chosen tree first (by name), row by row, then the other trees.
function sampleOrder(index, spec) {
  const wanted = str(spec, 80).toLowerCase();
  const trees = [...index.trees].sort((a, b) => {
    const am = wanted && a.name.toLowerCase().includes(wanted) ? 0 : 1;
    const bm = wanted && b.name.toLowerCase().includes(wanted) ? 0 : 1;
    return am - bm;
  });
  const order = [];
  for (const tree of trees) {
    const talents = [...tree.talents].sort((a, b) => a.row - b.row || a.id - b.id);
    for (const talent of talents) for (let i = 0; i < talent.max; i++) order.push(talent.id);
  }
  return order;
}

function sampleTalents({ ctx, profile }) {
  const index = talentIndex(ctx.armory_talents);
  const checked = validateOrder(index, sampleOrder(index, profile.spec));
  return shapeBuild(index, {
    name: 'Test build',
    summary: 'A legal build made without an AI: the first talents of each tree in order. Choose an AI in the companion app for a real recommendation.',
    notes: ['This only shows that Forever AI Armory and the app can talk to each other.'],
  }, checked);
}

function sampleGear({ ctx }) {
  // Something equippable from the bags per slot, so links and scores can be seen.
  const taken = new Set();
  const slots = [];
  for (const item of list(ctx.inventory)) {
    const slot = SLOTS.find((s) => !taken.has(s) && list(item?.slots).includes(s));
    if (!slot || !item.name) continue;
    taken.add(slot);
    slots.push({ slot, picks: [{
      name: item.name, itemId: item.itemId, why: 'In your bags (test mode: not a recommendation).',
      source: { type: 'world', where: 'Your bags' }, confidence: 'high',
    }] });
    if (slots.length >= 4) break;
  }
  const weights = {};
  for (const item of list(ctx.gear)) {
    for (const key of Object.keys(item?.stats || {})) if (Object.keys(weights).length < 6) weights[key] = 1;
  }
  return shapeGear({
    summary: 'Test mode: items from your bags and equal stat weights, made without an AI.',
    weights, weightsNote: 'Every stat counts the same in test mode.', slots,
    next: ['Choose an AI in the companion app to get a real gear plan.'],
  });
}

// A spell of the character for the placeholder ability to be named after, so
// that its One Button lists name a real spell: the first one that is not
// passive, or none.
function borrowed(ctx) {
  const spell = list(ctx.armory_spells).find((s) => s && !s.passive && str(s.name, 80) && num(s.id));
  return spell ? { name: str(spell.name, 80), spellId: num(spell.id) } : null;
}

// A model with the character's auto attack (or a plain bolt for a caster),
// with a One Button list for each kind of fight.
function sampleModel(ctx) {
  const combat = ctx.armory_combat || {};
  const level = num(ctx.character?.level) || 60;
  const weapon = combat.mainHand && num(combat.mainHand.max) ? combat.mainHand : null;
  const fight = { duration: 60, targets: 1, targetLevel: level, targetArmor: weapon ? level * 60 : 0 };
  const named = borrowed(ctx);
  if (weapon) {
    // The sheet's damage includes attack power; the simulator adds it itself.
    const attackPower = num(combat.attackPower) || 0;
    const speed = num(weapon.speed) || 2;
    const own = (v) => Math.max(1, Math.round(((num(v) || 1) - (attackPower / 14) * speed) * 10) / 10);
    return {
      version: 1, kind: 'damage', fight,
      player: {
        level, autoAttack: 'melee',
        stats: { attackPower, critPct: num(combat.critPct) || 5, hitPct: num(combat.hitPct) || 0 },
        weapons: { mainHand: { min: own(weapon.min), max: Math.max(own(weapon.max), own(weapon.min) + 1), speed } },
        resource: { type: 'none', max: 0, start: 0 },
      },
      abilities: [{ id: 'strike', name: 'Test strike', ...named, type: 'melee', school: 'physical', cost: 0, gcd: 1.5, cooldown: 6, damage: { weaponPct: 100 } }],
      rotations: [
        { name: 'Auto attack only', actions: [] },
        { name: 'Auto attack and a strike', actions: [{ use: 'strike', note: 'on cooldown' }] },
      ],
      // Two different lists, the long one with a condition only One Button lists have.
      oneButton: { short: [{ use: 'strike' }], long: [{ use: 'strike', if: { not: { usedOnTarget: 'strike' } } }] },
    };
  }
  return {
    version: 1, kind: 'damage', fight,
    player: {
      level, autoAttack: 'none',
      stats: { spellPower: num(combat.spellPower) || 0, spellCritPct: num(combat.spellCritPct) || 5 },
      resource: { type: 'mana', max: num(combat.resourceMax) || 2000, start: num(combat.resourceMax) || 2000, regenPerSec: 5 },
    },
    abilities: [{ id: 'bolt', name: 'Test bolt', ...named, type: 'spell', school: 'fire', cost: 60, castTime: 2.5, gcd: 1.5, damage: { min: 180, max: 220, spCoef: 0.71 } }],
    rotations: [{ name: 'Bolt', actions: [{ use: 'bolt', note: 'always' }] }],
    oneButton: { short: [{ use: 'bolt' }], long: [{ use: 'bolt' }] },
  };
}

// For a tank: made-up threat numbers and an enemy of the character's level
// that hits for a placeholder amount, so the survival estimate can be seen.
function tankModel(model, level) {
  const out = { ...model, player: { ...model.player, threatMultiplier: 1.3 } };
  out.abilities = model.abilities.map((a) => ({ ...a, threatMultiplier: 1.5, threat: 50 }));
  out.enemy = { level, meleeHit: Math.max(20, level * 8), attackSpeed: 2 };
  return out;
}

function sampleRotation({ ctx, profile, iterations }) {
  const tank = profile?.role === 'tank';
  const plain = sampleModel(ctx);
  const model = tank ? tankModel(plain, plain.player.level) : plain;
  const run = runModel(model, { iterations, tank, defense: tank ? ctx.armory_combat : null, goal: profile?.goal });
  if (run.fatal) throw new Error(run.problems.join('; ') || 'the test model could not be simulated');
  const assumptions = ['The abilities are placeholders, not your spells.'];
  const name = model.abilities[0].name;
  if (!/^Test /.test(name)) assumptions.push(`The placeholder ability borrows the name of your ${name}, so that its One Button lists can be tried.`);
  if (tank) assumptions.push('The threat numbers and the enemy are placeholders too: the enemy hits for 8 damage per level every 2 seconds.');
  return shapeRotation({
    summary: 'Test mode: a made-up model simulated for real, without an AI. The numbers only show that the simulator runs.',
    assumptions,
    model,
  }, run, { spells: ctx.armory_spells, auras: list(ctx.armory_auras), context: profile?.aoe ? 'aoe' : 'st' });
}

function sampleIdeas() {
  return shapeIdeas({
    summary: 'Test mode: this is a placeholder made without an AI.',
    ideas: [{
      title: 'Test idea', mechanism: 'Nothing was analysed: the app is in test mode and only shows that results reach the game.',
      gain: 'None.', test: 'Choose an AI in the companion app and ask again.', risks: 'None.', confidence: 'low',
    }],
  }, null);
}

export function sampleResult(kind, args) {
  const data = { talents: sampleTalents, gear: sampleGear, rotation: sampleRotation, discover: sampleIdeas }[kind](args);
  data.test = true;
  data.asked = { spec: args.profile.spec, goal: args.profile.goal, role: args.profile.role, level: num(args.ctx.character?.level) ?? undefined };
  return data;
}
