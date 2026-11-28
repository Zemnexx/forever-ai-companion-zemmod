// The best rotation of an analysis as a Forever One Button priority list
// (src/armory/onebutton.js): every condition of the model mapped to One
// Button's gates, or named in "left" when it could not be carried over.
import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanRotation, oneButtonList } from '../src/armory/onebutton.js';
import { normalizeModel, simulate } from '../src/armory/sim/engine.js';
import { oneButtonLists, runModel, shapeRotation } from '../src/armory/rotation.js';

// One Button's gate types and their fields, copied from SCHEMA in
// ForeverOneButton/Core/Profiles.lua (Forever One Button 1.1.4-zm7). Kept
// here by hand so the test does not read the other repository: change it
// with that file.
const ONE_BUTTON_SCHEMA = {
  power: ['res', 'op', 'n', 'ispct'],
  buff: ['id', 'dur', 'neg'],
  cd: ['id', 'neg'],
  stack: ['id', 'op', 'n', 'tgt'],
  targets: ['op', 'n'],
  health: ['op', 'pct'],
  execute: ['op', 'pct'],
  resource: ['res', 'op', 'n'],
  known: ['id', 'neg'],
  stealth: ['neg'],
  near: ['n'],
  totem: ['slot', 'neg'],
  swing: ['op', 'n', 'ranged'],
  dot: ['id'],
  starved: [],
  tick: ['op', 'n'],
  unconfirmed: [],
  any: ['g'],
  all: ['g'],
};
const OPS = ['>=', '>', '<=', '<', '=', '!='];

// Every gate, at every depth, is one One Button's sanitizer keeps as it is.
function assertSchema(gates, depth = 1) {
  assert.ok(Array.isArray(gates), 'gates is an array');
  assert.ok(gates.length <= 12, 'at most 12 gates per entry or group');
  for (const g of gates) {
    const fields = ONE_BUTTON_SCHEMA[g.t];
    assert.ok(fields, `known gate type ${g.t}`);
    for (const [k, v] of Object.entries(g)) {
      if (k === 't') continue;
      assert.ok(fields.includes(k), `${g.t} has field ${k}`);
      if (typeof v === 'boolean') assert.equal(v, true, 'flags only as true');
      if (k === 'op') assert.ok(OPS.includes(v), `op ${v}`);
      if (k === 'id') assert.ok(Number.isInteger(v) && v > 0, 'spell id');
    }
    if (g.t === 'any' || g.t === 'all') {
      assert.ok(depth < 3, 'groups nest at most to depth 3');
      assert.ok(g.g.length > 0);
      assertSchema(g.g, depth + 1);
    }
  }
}
function assertOneButton(ob) {
  assert.equal(ob.v, 1);
  assert.ok(['st', 'aoe'].includes(ob.context));
  if ('source' in ob) {
    // A list of an analysis: who wrote it, and its simulated value.
    assert.ok(['ai', 'best'].includes(ob.source));
    assert.equal('rotation' in ob, ob.source === 'best', 'the candidate\'s name only for "best"');
    assert.ok(typeof ob.value === 'number' && ob.value >= 0);
  }
  if ('rotation' in ob) assert.ok(typeof ob.rotation === 'string' && ob.rotation.length <= 80);
  assert.ok(ob.list.length > 0 && ob.list.length <= 60);
  for (const e of ob.list) {
    assert.deepEqual(Object.keys(e).sort(), ['gates', 'id', 'name']);
    assertSchema(e.gates);
  }
  if ('left' in ob) {
    assert.ok(ob.left.length > 0 && ob.left.length <= 8);
    for (const line of ob.left) assert.ok(line.length <= 160 && !/[{}"]/.test(line), line);
    assert.equal(new Set(ob.left).size, ob.left.length, 'no line twice');
  }
}

const SPELLS = [
  { name: 'Seal of Command', id: 20920, rank: 'Rank 3' },
  { name: 'Seal of the Crusader', id: 20305, rank: 'Rank 5' },
  { name: 'Judgement', id: 20271 },
  { name: 'Crusader Strike', id: 35395 },
  { name: 'Hammer of Wrath', id: 24239 },
  { name: 'Consecration', id: 20924 },
  { name: 'Exorcism', id: 10314 },
  { name: 'Holy Light', id: 19943 },
  { name: 'Shadow Word: Pain', id: 589 },
  { name: 'Hex Mark', id: 5001 },
  { name: 'Seal of Righteousness', id: 20293 },
  { name: 'Holy Strike', id: 1310001 },
];

// A small model with one ability and buff of each kind; the rotation is given per test.
function model(actions, extra = {}) {
  return normalizeModel({
    version: 1, kind: 'damage',
    fight: { duration: 60, targets: 1 },
    player: {
      level: 60, autoAttack: 'melee', stats: { attackPower: 1000 },
      weapons: { mainHand: { min: 200, max: 300, speed: 3.5 } },
      resource: { type: 'mana', max: 5000, start: 5000, regenPerSec: 10 },
    },
    abilities: [
      { id: 'soc', name: 'Seal of Command', spellId: 20375, type: 'spell', school: 'holy', cost: 65, gcd: 1.5, cooldown: 0, applies: ['soc_buff'] },
      { id: 'sotc', name: 'Seal of the Crusader', type: 'spell', school: 'holy', cost: 40, gcd: 1.5, applies: ['sotc_buff'] },
      { id: 'judge', name: 'Judgement', type: 'spell', school: 'holy', cost: 50, gcd: 0, cooldown: 8, damage: { min: 100, max: 100 }, consumes: ['soc_buff'], applies: ['jotc'] },
      { id: 'cs', name: 'Crusader Strike', type: 'melee', cost: 30, gcd: 1.5, cooldown: 6, damage: { weaponPct: 100 } },
      { id: 'how', name: 'Hammer of Wrath', type: 'spell', school: 'holy', cost: 300, gcd: 1.5, cooldown: 6, damage: { min: 300, max: 300 }, requires: { targetHealthBelow: 20 } },
      { id: 'cons', name: 'Consecration', type: 'spell', school: 'holy', cost: 500, gcd: 1.5, cooldown: 8, dot: { tickDamage: 50, interval: 1, duration: 8 }, maxTargets: 5 },
      { id: 'exo', name: 'Exorcism', type: 'spell', school: 'holy', cost: 200, gcd: 1.5, cooldown: 0, damage: { min: 400, max: 400 } },
      { id: 'made', name: 'Made Up Strike', spellId: 99999, type: 'melee', cost: 10, gcd: 1.5, damage: { weaponPct: 50 } },
      // A DoT One Button tracks itself (589 is in its DoT table), and an
      // effect on the target it does not track.
      { id: 'swp', name: 'Shadow Word: Pain', type: 'spell', school: 'shadow', cost: 100, gcd: 1.5, dot: { tickDamage: 40, interval: 3, duration: 18 } },
      { id: 'hex', name: 'Hex Mark', type: 'spell', school: 'shadow', cost: 20, gcd: 1.5, damage: { min: 10, max: 10 }, applies: ['hexed'] },
      { id: 'byid', name: 'Crusader Strike (rank 2)', spellId: 35395, type: 'melee', cost: 30, gcd: 1.5, cooldown: 6, damage: { weaponPct: 110 } },
    ],
    buffs: [
      { id: 'soc_buff', name: 'Seal of Command', duration: 30 },
      { id: 'sotc_buff', name: 'Crusader Power', duration: 30 },
      { id: 'jotc', name: 'Judgement of the Crusader', onTarget: true, duration: 10 },
      { id: 'vengeance', name: 'Vengeance', duration: 8, maxStacks: 3 },
      { id: 'combo', name: 'Combo Points', maxStacks: 5 },
      { id: 'hexed', name: 'Hexed', onTarget: true, duration: 20, maxStacks: 3 },
    ],
    rotations: [{ name: 'Test rotation', actions }],
    ...extra,
  }).model;
}
const translate = (actions, opts = {}) => {
  const m = model(actions, opts.model);
  return oneButtonList(m, m.rotations[0], opts.spells || SPELLS, opts.context);
};
const gatesOf = (actions, opts) => translate(actions, opts).list[0].gates;

test('spell ids come from the character: a name match wins over the model\'s spellId', () => {
  const ob = translate([{ use: 'soc' }, { use: 'made' }, { use: 'byid' }]);
  assertOneButton(ob);
  assert.deepEqual(ob.list[0], { id: 20920, name: 'Seal of Command', gates: [] }, 'the model said 20375, the character has 20920');
  assert.equal(ob.list[1].id, 35395, 'no name match: the model\'s spellId is the character\'s Crusader Strike');
  assert.equal(ob.list[1].name, 'Crusader Strike', 'the game\'s name');
  assert.equal(ob.list.length, 2, 'Made Up Strike is not in the spell list');
  assert.ok(ob.left.some((l) => /^Made Up Strike was left out/.test(l)), ob.left.join(' | '));
  assert.equal(translate([{ use: 'made' }]), null, 'nothing translated: no list');
});

test('resources: above the cost becomes a power gate, at or below the cost needs none', () => {
  assert.deepEqual(gatesOf([{ use: 'exo', if: { resourceAtLeast: 1000 } }]), [{ t: 'power', res: 'mana', op: '>=', n: 1000 }]);
  assert.deepEqual(gatesOf([{ use: 'exo', if: { resourceAtLeast: 200 } }]), [], 'One Button checks the cost itself');
  assert.deepEqual(gatesOf([{ use: 'exo', if: { resourceBelow: 3000 } }]), [{ t: 'power', res: 'mana', op: '<', n: 3000 }]);
  const none = { player: { level: 60, autoAttack: 'melee', weapons: { mainHand: { min: 1, max: 2, speed: 2 } }, resource: { type: 'none' } } };
  assert.deepEqual(gatesOf([{ use: 'exo', if: { resourceAtLeast: 1000 } }], { model: none }), [], 'no resource: nothing to ask');
});

test('a player buff is named by its spell, with its duration, or by the ability that applies it', () => {
  assert.deepEqual(gatesOf([{ use: 'soc', if: { buffDown: 'soc_buff' } }]), [{ t: 'buff', id: 20920, dur: 30, neg: true }]);
  assert.deepEqual(gatesOf([{ use: 'judge', if: { buffUp: 'soc_buff' } }]), [{ t: 'buff', id: 20920, dur: 30 }]);
  // "Crusader Power" is no spell of the character: the ability that applies it names it.
  assert.deepEqual(gatesOf([{ use: 'exo', if: { buffUp: 'sotc_buff' } }]), [{ t: 'buff', id: 20305, dur: 30 }]);
  // Vengeance has neither: Crusader Strike has a cooldown, so it stays without the condition.
  const ob = translate([{ use: 'cs', if: { buffUp: 'vengeance' } }]);
  assert.deepEqual(ob.list[0].gates, []);
  assert.deepEqual(ob.left, ['Crusader Strike is suggested without checking for Vengeance being up, which One Button cannot do.']);
});

test('an effect on the target: kept up by its own ability as a dot, otherwise counted as a stack', () => {
  assert.deepEqual(gatesOf([{ use: 'judge', if: { buffDown: 'jotc' } }]), [{ t: 'dot', id: 20271 }]);
  assert.deepEqual(gatesOf([{ use: 'cons', if: { buffDown: 'cons' } }]), [{ t: 'dot', id: 20924 }], 'an ability\'s dot by its id');
  assert.deepEqual(gatesOf([{ use: 'exo', if: { buffUp: 'jotc' } }]), [{ t: 'stack', id: 20271, op: '>=', n: 1, tgt: true }]);
  // A target stack gate names rank 1 of the spell (Consecration 20924 is a
  // higher rank of 26573), the one id One Button counts it under.
  assert.deepEqual(gatesOf([{ use: 'exo', if: { buffDown: 'cons' } }]), [{ t: 'stack', id: 26573, op: '<', n: 1, tgt: true }]);
  assert.deepEqual(gatesOf([{ use: 'exo', if: { buffStacksAtLeast: { id: 'jotc', n: 2 } } }]), [{ t: 'stack', id: 20271, op: '>=', n: 2, tgt: true }]);
});

test('a buff on the player: only what the player casts, and never its stacks', () => {
  // The stacks of a buff on the player are hidden in a fight, even of a seal
  // the player casts: Judgement has a cooldown, so it stays without the condition.
  const ob = translate([{ use: 'judge', if: { buffStacksAtLeast: { id: 'soc_buff', n: 2 } } }]);
  assert.deepEqual(ob.list[0].gates, []);
  assert.deepEqual(ob.left, ['Judgement is suggested without checking for Seal of Command\'s stacks, hidden in a fight, which One Button cannot do.']);
  // A buff only the addon saw: not even whether it is up.
  const m = model([{ use: 'cs', if: { buffUp: 'vengeance' } }, { use: 'exo', if: { not: { buffDown: 'vengeance' } } }, { use: 'soc' }]);
  const seen = cleanRotation(m, m.rotations[0], SPELLS, { auras: [{ name: 'vengeance', id: 20050 }] });
  assert.deepEqual(seen.list.map((e) => [e.name, e.gates]), [['Crusader Strike', []], ['Seal of Command', []]]);
  assert.deepEqual(seen.left, [
    'Exorcism was left out: One Button cannot check for Vengeance, hidden in a fight, and without it the spell would always come first.',
    'Crusader Strike is suggested without checking for Vengeance, hidden in a fight, which One Button cannot do.',
  ]);
  assert.deepEqual(seen.actions, [{ use: 'cs' }, { use: 'soc' }], 'simulated without it');
});

test('combo points are One Button\'s own resource', () => {
  assert.deepEqual(gatesOf([{ use: 'exo', if: { buffStacksAtLeast: { id: 'combo', n: 5 } } }]), [{ t: 'resource', res: 'combo_points', op: '>=', n: 5 }]);
  assert.deepEqual(gatesOf([{ use: 'exo', if: { buffUp: 'combo' } }]), [{ t: 'resource', res: 'combo_points', op: '>=', n: 1 }]);
  assert.deepEqual(gatesOf([{ use: 'exo', if: { buffDown: 'combo' } }]), [{ t: 'resource', res: 'combo_points', op: '<', n: 1 }]);
  assert.deepEqual(gatesOf([{ use: 'exo', if: { not: { buffStacksAtLeast: { id: 'combo', n: 3 } } } }]), [{ t: 'resource', res: 'combo_points', op: '<', n: 3 }]);
});

test('time left on a buff and on a cooldown is approximated, and said so', () => {
  const ob = translate([{ use: 'soc', if: { buffRemainsBelow: { id: 'soc_buff', sec: 3 } } }, { use: 'exo', if: { cooldownRemainsAbove: { id: 'cs', sec: 2 } } }]);
  assert.deepEqual(ob.list[0].gates, [{ t: 'buff', id: 20920, dur: 30, neg: true }]);
  assert.deepEqual(ob.list[1].gates, [{ t: 'cd', id: 35395, neg: true }]);
  assert.deepEqual(ob.left, [
    'Seal of Command refreshes Seal of Command only once it has run out, not shortly before.',
    'Exorcism waits for Crusader Strike to be on cooldown, not for how long it has left.',
  ]);
});

test('cooldowns, health, targets and the swing timer', () => {
  assert.deepEqual(gatesOf([{ use: 'cs', if: { cooldownUp: 'cs' } }]), [], 'its own cooldown: One Button checks it');
  assert.deepEqual(gatesOf([{ use: 'exo', if: { cooldownUp: 'cs' } }]), [{ t: 'cd', id: 35395 }]);
  assert.deepEqual(gatesOf([{ use: 'exo', if: { targetHealthBelow: 20 } }]), [{ t: 'execute', op: '<', pct: 20 }]);
  assert.deepEqual(gatesOf([{ use: 'exo', if: { targetHealthAbove: 35 } }]), [{ t: 'execute', op: '>=', pct: 35 }]);
  assert.deepEqual(gatesOf([{ use: 'exo', if: { targetsAtLeast: 3 } }]), [{ t: 'targets', op: '>=', n: 3 }]);
  assert.deepEqual(gatesOf([{ use: 'exo', if: { swingTimerAbove: 1.5 } }]), [{ t: 'swing', op: '>', n: 1.5 }]);
});

test('the fight\'s clock cannot be carried over: no cooldown leaves the action out, a cooldown keeps it', () => {
  const out = translate([{ use: 'exo', if: { timeRemainingBelow: 20 } }, { use: 'soc' }]);
  assert.deepEqual(out.list.map((e) => e.name), ['Seal of Command']);
  assert.deepEqual(out.left, ['Exorcism was left out: One Button cannot check for the last 20 seconds of the fight, and without it the spell would always come first.']);
  const kept = translate([{ use: 'cs', if: { timeAtLeast: 5, targetsAtLeast: 2 } }]);
  assert.deepEqual(kept.list[0].gates, [{ t: 'targets', op: '>=', n: 2 }], 'what could be carried over stays');
  assert.deepEqual(kept.left, ['Crusader Strike is suggested without checking for 5 seconds into the fight, which One Button cannot do.']);
  // A cooldown no longer than the global cooldown is no real cooldown.
  const m = model([{ use: 'exo', if: { timeAtLeast: 5 } }]);
  m.abilities.find((a) => a.id === 'exo').cooldown = 1.5;
  assert.equal(oneButtonList(m, m.rotations[0], SPELLS), null);
});

test('a value outside One Button\'s ranges is not emitted', () => {
  const ob = translate([{ use: 'cs', if: { swingTimerAbove: 12 } }]);
  assert.deepEqual(ob.list[0].gates, []);
  assert.match(ob.left[0], /more than 12 seconds before the next swing/);
});

test('requires and if both apply, each gate once', () => {
  assert.deepEqual(gatesOf([{ use: 'how', if: { resourceAtLeast: 1000, targetHealthBelow: 20 } }]), [
    { t: 'execute', op: '<', pct: 20 }, { t: 'power', res: 'mana', op: '>=', n: 1000 },
  ]);
});

test('any: an or of gates, all of a member together, and an always true member drops it', () => {
  assert.deepEqual(gatesOf([{ use: 'exo', if: { any: [{ targetHealthBelow: 20 }, { buffUp: 'soc_buff', targetsAtLeast: 2 }] } }]), [
    { t: 'any', g: [{ t: 'execute', op: '<', pct: 20 }, { t: 'all', g: [{ t: 'buff', id: 20920, dur: 30 }, { t: 'targets', op: '>=', n: 2 }] }] },
  ]);
  const ob = translate([{ use: 'exo', if: { any: [{ resourceAtLeast: 100 }, { targetHealthBelow: 20 }] } }]);
  assert.deepEqual(ob.list[0].gates, [], 'a member that only restated the cost: always true');
  assert.equal(ob.left, undefined);
  const lostOne = translate([{ use: 'cs', if: { any: [{ targetHealthBelow: 20 }, { timeAtLeast: 10 }] } }]);
  assert.deepEqual(lostOne.list[0].gates, [], 'never one branch of an or on its own');
  assert.match(lostOne.left[0], /^Crusader Strike is suggested without checking for an either-or condition that includes 10 seconds into the fight/);
});

test('not: the opposite of each condition', () => {
  const cases = [
    [{ resourceAtLeast: 1000 }, [{ t: 'power', res: 'mana', op: '<', n: 1000 }]],
    [{ resourceBelow: 1000 }, [{ t: 'power', res: 'mana', op: '>=', n: 1000 }]],
    [{ buffUp: 'soc_buff' }, [{ t: 'buff', id: 20920, dur: 30, neg: true }]],
    [{ buffDown: 'soc_buff' }, [{ t: 'buff', id: 20920, dur: 30 }]],
    [{ buffStacksAtLeast: { id: 'jotc', n: 3 } }, [{ t: 'stack', id: 20271, op: '<', n: 3, tgt: true }]],
    [{ cooldownUp: 'cs' }, [{ t: 'cd', id: 35395, neg: true }]],
    [{ targetHealthBelow: 20 }, [{ t: 'execute', op: '>=', pct: 20 }]],
    [{ targetHealthAbove: 20 }, [{ t: 'execute', op: '<=', pct: 20 }]],
    [{ targetsAtLeast: 3 }, [{ t: 'targets', op: '<', n: 3 }]],
    [{ swingTimerAbove: 0.5 }, [{ t: 'swing', op: '<=', n: 0.5 }]],
    [{ not: { targetsAtLeast: 3 } }, [{ t: 'targets', op: '>=', n: 3 }]],
    // Several keys: any of the opposites. An any: all of them.
    [{ targetsAtLeast: 3, targetHealthBelow: 20 }, [{ t: 'any', g: [{ t: 'targets', op: '<', n: 3 }, { t: 'execute', op: '>=', pct: 20 }] }]],
    [{ any: [{ targetsAtLeast: 3 }, { targetHealthBelow: 20 }] }, [{ t: 'targets', op: '<', n: 3 }, { t: 'execute', op: '>=', pct: 20 }]],
  ];
  for (const [inner, expected] of cases) {
    const gates = gatesOf([{ use: 'exo', if: { not: inner } }]);
    assert.deepEqual(gates, expected, JSON.stringify(inner));
    assertSchema(gates);
  }
  const ob = translate([{ use: 'cs', if: { not: { timeRemainingBelow: 10 } } }]);
  assert.match(ob.left[0], /without checking for the fight before its last 10 seconds/);
});

test('nesting deeper than One Button allows is not carried over', () => {
  // any (depth 1) > all (2) > any (3): a group at depth 3 is dropped by One Button.
  const deep = { any: [{ targetsAtLeast: 2 }, { buffUp: 'soc_buff', any: [{ targetHealthBelow: 20 }, { resourceBelow: 1000 }] }] };
  const ob = translate([{ use: 'cs', if: deep }]);
  assert.deepEqual(ob.list[0].gates, []);
  assert.match(ob.left[0], /nested too deeply/);
  // any (1) > any (2) is fine.
  const ok = gatesOf([{ use: 'cs', if: { any: [{ targetsAtLeast: 2 }, { any: [{ targetHealthBelow: 20 }, { resourceBelow: 1000 }] }] } }]);
  assertSchema(ok);
  assert.equal(ok[0].g[1].t, 'any');
});

test('the limits: 60 entries, 12 gates per entry and per group', () => {
  const spells = [];
  const abilities = [];
  for (let i = 1; i <= 65; i++) {
    spells.push({ name: `Strike ${i}`, id: 1000 + i });
    abilities.push({ id: `s${i}`, name: `Strike ${i}`, type: 'melee', cost: 0, gcd: 1.5, cooldown: 10, damage: { weaponPct: 10 } });
  }
  const m = model(abilities.map((a) => ({ use: a.id })), { abilities });
  const ob = oneButtonList(m, m.rotations[0], spells);
  assert.equal(ob.list.length, 60);
  assert.ok(ob.left.some((l) => /first 60/.test(l)));
  // 14 different gates on one entry.
  const cond = {};
  const keys = [['targetsAtLeast', 2], ['targetHealthBelow', 90], ['targetHealthAbove', 5], ['swingTimerAbove', 0.2], ['resourceAtLeast', 1000],
    ['resourceBelow', 4000], ['buffUp', 'soc_buff'], ['buffDown', 'jotc'], ['cooldownUp', 'judge']];
  for (const [k, v] of keys) cond[k] = v;
  cond.any = [{ targetsAtLeast: 3 }, { targetsAtLeast: 4 }];
  cond.not = { any: [{ cooldownUp: 'cons' }, { cooldownUp: 'how' }, { targetsAtLeast: 9 }, { buffUp: 'combo' }] };
  const many = translate([{ use: 'cs', if: cond }]);
  assert.equal(many.list[0].gates.length, 12);
  assertSchema(many.list[0].gates);
  assert.ok(many.left.some((l) => /first 12 of its conditions/.test(l)));
  // 13 members of one any.
  const wide = translate([{ use: 'cs', if: { any: Array.from({ length: 13 }, (_, i) => ({ targetsAtLeast: i + 2 })) } }]);
  assert.equal(wide.list[0].gates[0].g.length, 12);
  assert.ok(wide.left.some((l) => /first 12/.test(l)));
});

test('a spell listed more than once: a plain first place makes the later ones redundant', () => {
  const ob = translate([{ use: 'cs' }, { use: 'exo' }, { use: 'cs', if: { targetsAtLeast: 2 } }]);
  assert.deepEqual(ob.list, [{ id: 35395, name: 'Crusader Strike', gates: [] }, { id: 10314, name: 'Exorcism', gates: [] }]);
  assert.equal(ob.left, undefined, 'nothing lost: said nothing');
});

test('a conditional place and a plain filler lower down: one plain entry at the filler\'s place', () => {
  const ob = translate([{ use: 'exo', if: { targetHealthBelow: 20 } }, { use: 'cs' }, { use: 'exo' }]);
  assert.deepEqual(ob.list, [{ id: 35395, name: 'Crusader Strike', gates: [] }, { id: 10314, name: 'Exorcism', gates: [] }]);
  assert.deepEqual(ob.left, ['Exorcism is listed more than once: One Button reads each ability once, so it keeps its lowest place.']);
});

test('two conditional places: one entry at the lower one, held back unless one of them holds', () => {
  const ob = translate([
    { use: 'exo', if: { targetsAtLeast: 3 } }, { use: 'cs' }, { use: 'exo', if: { buffUp: 'soc_buff', targetHealthBelow: 20 } },
  ]);
  assertOneButton(ob);
  assert.deepEqual(ob.list, [
    { id: 35395, name: 'Crusader Strike', gates: [] },
    { id: 10314, name: 'Exorcism', gates: [{ t: 'any', g: [
      { t: 'targets', op: '>=', n: 3 },
      { t: 'all', g: [{ t: 'buff', id: 20920, dur: 30 }, { t: 'execute', op: '<', pct: 20 }] },
    ] }] },
  ]);
  assert.match(ob.left[0], /^Exorcism is listed more than once: .*keeps its lowest place, for the conditions of any of its places\.$/);
  // A place that is one "or" of its own gives its members directly.
  const flat = translate([{ use: 'exo', if: { any: [{ targetsAtLeast: 3 }, { targetHealthBelow: 20 }] } }, { use: 'cs' }, { use: 'exo', if: { buffUp: 'soc_buff' } }]);
  assert.deepEqual(flat.list[1].gates, [{ t: 'any', g: [
    { t: 'targets', op: '>=', n: 3 }, { t: 'execute', op: '<', pct: 20 }, { t: 'buff', id: 20920, dur: 30 },
  ] }]);
  assertOneButton(flat);
});

test('a merge that would nest too deeply keeps the lowest place with its own conditions', () => {
  const ob = translate([
    { use: 'exo', if: { buffUp: 'soc_buff', any: [{ targetsAtLeast: 3 }, { targetHealthBelow: 20 }] } }, { use: 'cs' }, { use: 'exo', if: { targetsAtLeast: 5 } },
  ]);
  assert.deepEqual(ob.list.map((e) => e.name), ['Crusader Strike', 'Exorcism']);
  assert.deepEqual(ob.list[1].gates, [{ t: 'targets', op: '>=', n: 5 }]);
  assert.match(ob.left[0], /keeps its lowest place, with only the conditions it has there\.$/);
});

test('places after the first plain one are ignored, and places left out do not count', () => {
  const ob = translate([{ use: 'exo', if: { targetsAtLeast: 3 } }, { use: 'exo' }, { use: 'cs' }, { use: 'exo', if: { targetHealthBelow: 20 } }]);
  assert.deepEqual(ob.list, [{ id: 10314, name: 'Exorcism', gates: [] }, { id: 35395, name: 'Crusader Strike', gates: [] }]);
  // The first Exorcism cannot be carried over and is left out: the second stands alone.
  const left = translate([{ use: 'exo', if: { timeAtLeast: 5 } }, { use: 'cs' }, { use: 'exo', if: { targetsAtLeast: 2 } }]);
  assert.deepEqual(left.list[1], { id: 10314, name: 'Exorcism', gates: [{ t: 'targets', op: '>=', n: 2 }] });
  assert.equal(left.left.length, 1, 'only the line about the place left out');
  // 13 places merged: the "or" keeps 12.
  const many = translate([...Array.from({ length: 13 }, (_, i) => ({ use: 'exo', if: { targetsAtLeast: i + 2 } })), { use: 'cs' }]);
  assert.equal(many.list[0].gates[0].g.length, 12);
  assert.ok(many.left.some((l) => /first 12 of its conditions/.test(l)));
  assertOneButton(many);
});

test('a place left out of a spell that is still listed is one use of it', () => {
  const ob = translate([
    { use: 'exo', if: { buffUp: 'soc_buff' } }, { use: 'exo', if: { buffUp: 'vengeance' } }, { use: 'cs' }, { use: 'exo' },
  ]);
  assert.deepEqual(ob.list.map((e) => [e.name, e.gates]), [['Crusader Strike', []], ['Exorcism', []]]);
  assert.deepEqual(ob.left, [
    'One use of Exorcism was left out: One Button cannot check for Vengeance being up, and without it the spell would always come first.',
    'Exorcism is listed more than once: One Button reads each ability once, so it keeps its lowest place.',
  ], 'with the conditions left out, not the actions');
  // The only place of a spell left out: the spell was left out.
  assert.match(translate([{ use: 'exo', if: { buffUp: 'vengeance' } }, { use: 'cs' }]).left[0], /^Exorcism was left out/);
});

test('a plain lowest place drops what was said about the places it took in', () => {
  const ob = translate([{ use: 'exo', if: { cooldownRemainsAbove: { id: 'judge', sec: 3 } } }, { use: 'cs' }, { use: 'exo' }]);
  assert.deepEqual(ob.list[1], { id: 10314, name: 'Exorcism', gates: [] });
  assert.deepEqual(ob.left, ['Exorcism is listed more than once: One Button reads each ability once, so it keeps its lowest place.']);
  // Merged into an "or", the places' lines still describe the entry.
  const merged = translate([{ use: 'exo', if: { cooldownRemainsAbove: { id: 'judge', sec: 3 } } }, { use: 'cs' }, { use: 'exo', if: { targetsAtLeast: 2 } }]);
  assert.ok(merged.left.some((l) => /^Exorcism waits for Judgement to be on cooldown/.test(l)));
});

test('a DoT One Button tracks: kept up by its own ability, and no other condition on it', () => {
  const kept = translate([{ use: 'swp', if: { buffDown: 'swp' } }]);
  assert.deepEqual(kept.list[0].gates, [{ t: 'dot', id: 589 }]);
  assert.equal(kept.left, undefined, 'exact');
  // From another action: never a stack gate (it would stop One Button tracking the DoT).
  const other = translate([{ use: 'exo', if: { buffUp: 'swp' } }, { use: 'cs', if: { buffDown: 'swp' } }, { use: 'soc' }]);
  assert.deepEqual(other.list.map((e) => [e.name, e.gates]), [['Crusader Strike', []], ['Seal of Command', []]]);
  assert.match(other.left[0], /^Exorcism was left out: One Button cannot check for Shadow Word: Pain being up \(One Button keeps track of that effect itself/);
  assert.match(other.left[1], /^Crusader Strike is suggested without checking for Shadow Word: Pain being down \(One Button keeps track/);
  const stacked = translate([{ use: 'exo', if: { buffStacksAtLeast: { id: 'swp', n: 2 } } }, { use: 'soc' }]);
  assert.deepEqual(stacked.list.map((e) => e.name), ['Seal of Command']);
  const negated = translate([{ use: 'exo', if: { not: { buffDown: 'swp' } } }, { use: 'soc' }]);
  assert.deepEqual(negated.list.map((e) => e.name), ['Seal of Command'], 'the opposites follow the same rule');
});

test('an effect on the target One Button does not track is counted from the player\'s casts', () => {
  // Kept up by an ability without a cooldown: a stack gate, about 30 seconds per cast.
  const kept = translate([{ use: 'hex', if: { buffDown: 'hexed' } }]);
  assert.deepEqual(kept.list[0].gates, [{ t: 'stack', id: 5001, op: '<', n: 1, tgt: true }]);
  assert.deepEqual(kept.left, ['Hex Mark keeps up Hexed, which One Button does not track: it waits about 30 seconds between uses on the same target.']);
  // With a real cooldown, its cooldown paces it.
  const paced = translate([{ use: 'judge', if: { buffDown: 'jotc' } }]);
  assert.deepEqual(paced.list[0].gates, [{ t: 'dot', id: 20271 }]);
  assert.equal(paced.left, undefined);
  // Other conditions on it: stack gates, said to be counted.
  const up = translate([{ use: 'exo', if: { buffUp: 'hexed' } }]);
  assert.deepEqual(up.list[0].gates, [{ t: 'stack', id: 5001, op: '>=', n: 1, tgt: true }]);
  assert.deepEqual(up.left, ['Exorcism counts Hexed on the target from your own casts, about 30 seconds each.']);
  assert.deepEqual(gatesOf([{ use: 'exo', if: { buffStacksAtLeast: { id: 'hexed', n: 3 } } }]), [{ t: 'stack', id: 5001, op: '>=', n: 3, tgt: true }]);
  assert.deepEqual(gatesOf([{ use: 'exo', if: { not: { buffStacksAtLeast: { id: 'hexed', n: 3 } } } }]), [{ t: 'stack', id: 5001, op: '<', n: 3, tgt: true }]);
});

test('usedOnTarget with times, and not usedWithin, as gates One Button answers in a fight', () => {
  assert.deepEqual(gatesOf([{ use: 'exo', if: { usedOnTarget: { id: 'judge', times: 2 } } }]), [{ t: 'stack', id: 20271, op: '>=', n: 2, tgt: true }]);
  assert.deepEqual(gatesOf([{ use: 'exo', if: { not: { usedOnTarget: { id: 'judge', times: 3 } } } }]), [{ t: 'stack', id: 20271, op: '<', n: 3, tgt: true }]);
  // A target stack gate names rank 1 (Exorcism 10314 is a higher rank of
  // 879); the entry and every other gate keep the character's own id. Hex
  // Mark is in no rank chain and keeps its id.
  const ranked = translate([
    { use: 'exo', if: { usedOnTarget: 'exo', cooldownUp: 'cs', not: { usedWithin: { id: 'exo', sec: 10 } } } },
    { use: 'hex', if: { not: { usedOnTarget: { id: 'hex', times: 2 } } } },
  ]);
  assertOneButton(ranked);
  assert.deepEqual(ranked.list, [
    { id: 10314, name: 'Exorcism', gates: [{ t: 'stack', id: 879, op: '>=', n: 1, tgt: true }, { t: 'cd', id: 35395 }, { t: 'buff', id: 10314, dur: 10, neg: true }] },
    { id: 5001, name: 'Hex Mark', gates: [{ t: 'stack', id: 5001, op: '<', n: 2, tgt: true }] },
  ]);
  assert.equal(ranked.left, undefined, 'exact');
  // The positive form cannot be carried over: Exorcism has no cooldown, so it is left out.
  const within = translate([{ use: 'exo', if: { usedWithin: { id: 'cs', sec: 6 } } }, { use: 'cs' }]);
  assert.deepEqual(within.list.map((e) => e.name), ['Crusader Strike']);
  assert.deepEqual(within.left, ['Exorcism was left out: One Button cannot check for Crusader Strike used in the last 6 seconds, and without it the spell would always come first.']);
  // Seal of Command's own buff outlasts 10 seconds: One Button also holds
  // back while it is up, and so does the simulated list.
  const m = model([{ use: 'exo', if: { not: { usedWithin: { id: 'soc', sec: 10 } } } }]);
  const held = cleanRotation(m, m.rotations[0], SPELLS);
  assert.deepEqual(held.list[0].gates, [{ t: 'buff', id: 20920, dur: 10, neg: true }]);
  assert.deepEqual(held.actions, [{ use: 'exo', if: { not: { usedWithin: { id: 'soc', sec: 10 } }, buffDown: 'soc_buff' } }]);
  assert.deepEqual(held.left, ['Exorcism also waits while Seal of Command is up: One Button holds it back for as long as that buff lasts.']);
  // No longer than the time asked: nothing more to wait for.
  const m30 = model([{ use: 'exo', if: { not: { usedWithin: { id: 'soc', sec: 30 } } } }]);
  const exact = cleanRotation(m30, m30.rotations[0], SPELLS);
  assert.deepEqual(exact.actions, [{ use: 'exo', if: { not: { usedWithin: { id: 'soc', sec: 30 } } } }]);
  assert.deepEqual(exact.left, []);
  // A DoT One Button tracks itself still cannot be counted, however many times.
  const dot = translate([{ use: 'exo', if: { usedOnTarget: { id: 'swp', times: 2 } } }, { use: 'cs' }]);
  assert.match(dot.left[0], /^Exorcism was left out: One Button cannot check for Shadow Word: Pain used 2 times on the target, each within 30 seconds of the one before \(One Button keeps/);
});

test('left: actions left out first, then conditions, then approximations', () => {
  const ob = translate([
    { use: 'soc', if: { buffRemainsBelow: { id: 'soc_buff', sec: 2 } } },
    { use: 'cs', if: { timeAtLeast: 3 } },
    { use: 'exo', if: { timeAtLeast: 3 } },
    { use: 'made' },
  ]);
  assertOneButton(ob);
  assert.deepEqual(ob.left.map((l) => l.split(' ').slice(0, 3).join(' ')), [
    'Exorcism was left', 'Made Up Strike', 'Crusader Strike is', 'Seal of Command',
  ]);
});

test('context and the rotation\'s name', () => {
  assert.equal(translate([{ use: 'cs' }]).context, 'st');
  assert.equal(translate([{ use: 'cs' }], { context: 'aoe' }).context, 'aoe');
  assert.equal(translate([{ use: 'cs' }]).rotation, 'Test rotation');
});

test('shapeRotation carries the list of the best rotation only, and none for a healer', () => {
  const src = {
    version: 1, kind: 'damage', fight: { duration: 60, targets: 1 },
    player: { level: 60, autoAttack: 'melee', stats: { attackPower: 1000 }, weapons: { mainHand: { min: 200, max: 300, speed: 3.5 } },
      resource: { type: 'mana', max: 5000, start: 5000, regenPerSec: 10 } },
    abilities: [
      { id: 'cs', name: 'Crusader Strike', type: 'melee', cost: 30, gcd: 1.5, cooldown: 6, damage: { weaponPct: 120 } },
      { id: 'exo', name: 'Exorcism', type: 'spell', school: 'holy', cost: 200, gcd: 1.5, cooldown: 15, damage: { min: 500, max: 500 } },
    ],
    rotations: [
      { name: 'Nothing', actions: [] },
      { name: 'Both', actions: [{ use: 'exo' }, { use: 'cs', if: { targetsAtLeast: 1 } }] },
    ],
  };
  const run = runModel(src, { iterations: 20, weights: false });
  const data = shapeRotation({ model: src }, run, { spells: SPELLS, context: 'aoe' });
  assert.equal(data.rotations[0].name, 'Both');
  assertOneButton(data.oneButton);
  assert.deepEqual(data.oneButton, {
    v: 1, context: 'aoe', source: 'best', rotation: 'Both',
    list: [{ id: 10314, name: 'Exorcism', gates: [] }, { id: 35395, name: 'Crusader Strike', gates: [{ t: 'targets', op: '>=', n: 1 }] }],
    // Nothing had to be cleaned: the list plays exactly as the candidate did.
    value: data.rotations[0].value,
  });
  assert.equal(shapeRotation({ model: src }, run).oneButton, undefined, 'no spells: nothing to name');
  const heal = {
    ...src, kind: 'healing',
    abilities: [{ id: 'hl', name: 'Holy Light', type: 'heal', cost: 300, castTime: 2.5, damage: { min: 900, max: 1000 } }],
    rotations: [{ name: 'Heal', actions: [{ use: 'hl' }] }],
  };
  const healRun = runModel(heal, { iterations: 10, weights: false });
  const healed = shapeRotation({ model: heal }, healRun, { spells: SPELLS });
  assert.equal(healed.metric, 'hps');
  assert.equal(healed.oneButton, undefined);
  assert.ok(healed.otherFight.rotations.length, 'a healer gets the other fight too');
  assert.equal(healed.otherFight.oneButton, undefined, 'but no list in it either');
});

// ------------------------------------------------ the lists of an analysis

// The model of the owner's case: a seal on the pull, Judgement, Seal of
// Command kept up, a swap to Seal of Righteousness that spends a talent's
// stored copies of Seal of Command (the buff "Echo of Command", which only
// the addon saw: no spell of the character), Holy Strike. Seal of Command's
// buff is listed under another id than the spell: the character's spell of
// that name still names it.
const PALADIN_AURAS = [{ name: 'Echo of Command', id: 1311703 }, { name: 'seal of command', id: 99920 }];
function paladin(oneButton, extra = {}) {
  return {
    version: 1, kind: 'damage', fight: { duration: 60, targets: 1, targetLevel: 60, targetArmor: 3000 },
    player: { level: 60, autoAttack: 'melee', stats: { attackPower: 1000, critPct: 10 }, weapons: { mainHand: { min: 200, max: 300, speed: 3.5 } },
      resource: { type: 'mana', max: 5000, start: 5000, regenPerSec: 10 } },
    abilities: [
      { id: 'sotc', name: 'Seal of the Crusader', type: 'spell', school: 'holy', cost: 40, gcd: 1.5, applies: ['sotc_buff'], consumes: ['soc_buff', 'sor_buff'] },
      { id: 'judge', name: 'Judgement', type: 'spell', school: 'holy', cost: 50, gcd: 0, cooldown: 8, damage: { min: 300, max: 300 }, applies: ['jotc'] },
      { id: 'soc', name: 'Seal of Command', type: 'spell', school: 'holy', cost: 65, gcd: 1.5, applies: ['soc_buff'], consumes: ['sotc_buff', 'sor_buff'] },
      { id: 'sor', name: 'Seal of Righteousness', type: 'spell', school: 'holy', cost: 60, gcd: 1.5, applies: ['sor_buff'], consumes: ['soc_buff', 'sotc_buff', 'echo'] },
      { id: 'hs', name: 'Holy Strike', type: 'melee', cost: 30, gcd: 1.5, cooldown: 6, damage: { weaponPct: 100 } },
      { id: 'exo', name: 'Exorcism', type: 'spell', school: 'holy', cost: 200, gcd: 1.5, cooldown: 0, damage: { min: 400, max: 400 } },
      { id: 'swp', name: 'Shadow Word: Pain', type: 'spell', school: 'shadow', cost: 100, gcd: 1.5, dot: { tickDamage: 40, interval: 3, duration: 18 } },
    ],
    buffs: [
      { id: 'sotc_buff', name: 'Seal of the Crusader', duration: 30, modifiers: [{ stat: 'attackPower', value: 100 }] },
      { id: 'soc_buff', name: 'Seal of Command', duration: 30, modifiers: [{ stat: 'damagePct', value: 10 }] },
      { id: 'sor_buff', name: 'Seal of Righteousness', duration: 30, modifiers: [{ stat: 'damagePct', value: 12 }] },
      { id: 'jotc', name: 'Judgement of the Crusader', onTarget: true, duration: 10 },
      { id: 'echo', name: 'Echo of Command', duration: 15, maxStacks: 3 },
    ],
    procs: [{ id: 'store', name: 'Unsealed Wrath', trigger: 'meleeHit', chance: 1, effect: { buff: 'echo' } }],
    rotations: [
      { name: 'Command', actions: [{ use: 'judge' }, { use: 'soc', if: { buffDown: 'soc_buff' } }, { use: 'hs' }] },
      { name: 'Strike first', actions: [{ use: 'hs' }, { use: 'judge' }, { use: 'soc', if: { buffDown: 'soc_buff' } }] },
    ],
    ...(oneButton ? { oneButton } : {}),
    ...extra,
  };
}
// The owner's list as the AI now writes it: the swap while Seal of Command
// is up, once Judgement was used twice on the target (time for the copies to
// build up), at most once every 12 seconds (time to rebuild), just before a
// swing, with mana to spare.
const SWAP = {
  buffUp: 'soc_buff', usedOnTarget: { id: 'judge', times: 2 }, resourceAtLeast: 250,
  not: { any: [{ usedWithin: { id: 'sor', sec: 12 } }, { swingTimerAbove: 0.5 }] },
};
const OWNER_LIST = [
  { use: 'sotc', if: { buffDown: 'sotc_buff', not: { usedOnTarget: 'judge' } } },
  { use: 'judge' },
  { use: 'sor', if: SWAP },
  { use: 'soc', if: { buffDown: 'soc_buff' } },
  { use: 'hs' },
];
// The same swap written the old way, on 3 stacks of the buff only the addon saw.
const OLD_SWAP = { buffStacksAtLeast: { id: 'echo', n: 3 }, resourceAtLeast: 250, not: { swingTimerAbove: 0.5 } };
// An analysis of one of these models: the run and its One Button lists.
function analyse(raw, { goal = 'leveling', auras = PALADIN_AURAS } = {}) {
  const run = runModel(raw, { iterations: 40, weights: false, goal });
  return { run, lists: oneButtonLists(run, { spells: SPELLS, auras }) };
}
// What a list of model actions is worth in a fight of the run, simulated as the candidates were.
const worth = (run, actions, fight = run.model.fight) => {
  const sim = simulate({ ...run.model, fight, rotations: [{ name: 'x', actions }] }, run.opts);
  return Math.round(sim.rotations[0].value * 10) / 10;
};
// How often an ability is used per minute when these actions are simulated in the run's fight.
const usesOf = (run, actions, id) => {
  const sim = simulate({ ...run.model, rotations: [{ name: 'x', actions }] }, run.opts);
  return sim.rotations[0].breakdown.find((b) => b.id === id)?.perMinute ?? 0;
};

test('the AI\'s own list is used and said to be: the owner\'s case, with gates One Button answers in a fight', () => {
  const { run, lists } = analyse(paladin({ short: OWNER_LIST, long: OWNER_LIST }));
  const ob = lists.primary;
  assertOneButton(ob);
  assert.equal(ob.source, 'ai');
  assert.equal(ob.rotation, undefined);
  assert.deepEqual(ob.list, [
    // The opener: "this target has not been judged yet".
    { id: 20305, name: 'Seal of the Crusader', gates: [{ t: 'buff', id: 20305, dur: 30, neg: true }, { t: 'stack', id: 20271, op: '<', n: 1, tgt: true }] },
    { id: 20271, name: 'Judgement', gates: [] },
    // Seal of Command up (from its cast), Judgement counted twice on the
    // target, not swapped in the last 12 seconds, the swing and the mana.
    { id: 20293, name: 'Seal of Righteousness', gates: [
      { t: 'buff', id: 20920, dur: 30 }, { t: 'stack', id: 20271, op: '>=', n: 2, tgt: true }, { t: 'power', res: 'mana', op: '>=', n: 250 },
      { t: 'buff', id: 20293, dur: 12, neg: true }, { t: 'swing', op: '<=', n: 0.5 },
    ] },
    { id: 20920, name: 'Seal of Command', gates: [{ t: 'buff', id: 20920, dur: 30, neg: true }] },
    { id: 1310001, name: 'Holy Strike', gates: [] },
  ]);
  // Seal of Righteousness's own buff outlasts the 12 seconds, but it is
  // never up while Seal of Command is: nothing more to wait for, nothing to say.
  assert.equal(ob.left, undefined, 'nothing left out');
  assert.deepEqual(lists.problems, []);
  // The value is that of exactly the cleaned list, which here plays as written.
  const cleaned = cleanRotation(run.model, { actions: run.model.oneButton.short }, SPELLS, { auras: PALADIN_AURAS });
  assert.equal(ob.value, worth(run, cleaned.actions));
  assert.equal(ob.value, worth(run, run.model.oneButton.short));
  assert.ok(usesOf(run, cleaned.actions, 'sor') > 0, 'the swap is played');
});

test('the owner\'s case written the old way: stacks of a buff One Button cannot read leave the swap out', () => {
  const old = [...OWNER_LIST.slice(0, 2), { use: 'sor', if: OLD_SWAP }, ...OWNER_LIST.slice(3)];
  const { run, lists } = analyse(paladin({ short: old }));
  const ob = lists.primary;
  assertOneButton(ob);
  assert.equal(ob.source, 'ai');
  // The seal has no cooldown: without the condition it would always come first.
  assert.deepEqual(ob.list.map((e) => e.name), ['Seal of the Crusader', 'Judgement', 'Seal of Command', 'Holy Strike']);
  assert.deepEqual(ob.left, ['Seal of Righteousness was left out: One Button cannot check for Echo of Command\'s stacks, hidden in a fight, and without it the spell would always come first.']);
  assert.deepEqual(lists.problems, ob.left.map((l) => `oneButton.short: ${l}`));
  // What is measured is the list without the swap, not the list as written.
  const cleaned = [OWNER_LIST[0], { use: 'judge' }, OWNER_LIST[3], { use: 'hs' }];
  assert.equal(ob.value, worth(run, cleaned));
  assert.notEqual(ob.value, worth(run, run.model.oneButton.short));
  // buffUp of that buff cannot be carried over either; without the addon
  // having seen it, it is a buff One Button cannot name at all.
  const up = analyse(paladin({ short: [{ use: 'sor', if: { buffUp: 'echo' } }, { use: 'hs' }] })).lists.primary;
  assert.match(up.left[0], /^Seal of Righteousness was left out: One Button cannot check for Echo of Command, hidden in a fight, and without it/);
  const blind = analyse(paladin({ short: [{ use: 'sor', if: { buffUp: 'echo' } }, { use: 'hs' }] }), { auras: [] }).lists.primary;
  assert.equal(blind.left[0], 'Seal of Righteousness was left out: One Button cannot check for Echo of Command being up, and without it the spell would always come first.');
  // Names are compared without case.
  const lower = analyse(paladin({ short: [{ use: 'sor', if: { buffUp: 'echo' } }, { use: 'hs' }] }), { auras: [{ name: 'echo of COMMAND', id: 7 }] }).lists.primary;
  assert.match(lower.left[0], /Echo of Command, hidden in a fight/);
});

test('without a list of its own the best candidate of that fight is translated', () => {
  const { run, lists } = analyse(paladin(null));
  assertOneButton(lists.primary);
  assert.equal(lists.primary.source, 'best');
  const best = run.sim.rotations[run.sim.best];
  assert.equal(lists.primary.rotation, best.name);
  assert.equal(lists.primary.value, Math.round(best.value * 10) / 10, 'nothing cleaned: the candidate\'s own number');
  assert.equal(lists.other.source, 'best');
  assert.equal(lists.other.rotation, run.other.sim.rotations[run.other.sim.best].name);
  // An empty list of its own counts as none.
  assert.equal(analyse(paladin({ short: [] })).lists.primary.source, 'best');
  // So does one of which nothing can be carried over, which is said.
  const none = analyse(paladin({ short: [{ use: 'exo', if: { timeAtLeast: 10 } }] }));
  assert.equal(none.lists.primary.source, 'best');
  assert.ok(none.lists.problems.some((p) => /^oneButton\.short: None of its abilities could be carried over/.test(p)), none.lists.problems.join(' | '));
});

test('usedOnTarget on a DoT One Button tracks itself is not carried over', () => {
  const ob = cleanRotation(normalizeModel(paladin()).model, { actions: [
    { use: 'exo', if: { usedOnTarget: 'swp' } }, { use: 'hs', if: { not: { usedOnTarget: 'swp' } } }, { use: 'judge', if: { usedOnTarget: 'hs' } },
  ] }, SPELLS);
  assert.deepEqual(ob.list, [
    { id: 1310001, name: 'Holy Strike', gates: [] },
    { id: 20271, name: 'Judgement', gates: [{ t: 'stack', id: 1310001, op: '>=', n: 1, tgt: true }] },
  ]);
  assert.match(ob.left[0], /^Exorcism was left out: One Button cannot check for Shadow Word: Pain used on the target in the last 30 seconds \(One Button keeps track/);
  assert.match(ob.left[1], /^Holy Strike is suggested without checking for Shadow Word: Pain not used on the target/);
  // In the model's language, what was left out is left out of what is simulated.
  assert.deepEqual(ob.actions, [{ use: 'hs' }, { use: 'judge', if: { usedOnTarget: 'hs' } }]);
});

test('an AI list that breaks the rules is cleaned by the same rules, and says so', () => {
  const broken = [
    { use: 'hs', if: { timeAtLeast: 20 } },      // a time condition on an ability with a cooldown: kept without it
    { use: 'exo', if: { timeRemainingBelow: 10 } }, // without a cooldown: left out
    { use: 'judge' },
    { use: 'hs' },                               // twice
  ];
  const { lists } = analyse(paladin({ short: broken }));
  const ob = lists.primary;
  assertOneButton(ob);
  assert.equal(ob.source, 'ai');
  assert.deepEqual(ob.list, [{ id: 1310001, name: 'Holy Strike', gates: [] }, { id: 20271, name: 'Judgement', gates: [] }]);
  assert.deepEqual(lists.problems, [
    'oneButton.short: Exorcism was left out: One Button cannot check for the last 10 seconds of the fight, and without it the spell would always come first.',
    'oneButton.short: Holy Strike is suggested without checking for 20 seconds into the fight, which One Button cannot do.',
  ]);
  // The ability listed twice after a plain place: nothing to say, the first place stands.
  const twice = analyse(paladin({ short: [{ use: 'hs', if: { targetsAtLeast: 2 } }, { use: 'judge' }, { use: 'hs' }] })).lists;
  assert.deepEqual(twice.primary.list.map((e) => e.name), ['Judgement', 'Holy Strike']);
  assert.deepEqual(twice.problems, ['oneButton.short: Holy Strike is listed more than once: One Button reads each ability once, so it keeps its lowest place.']);
  // What the model's normalization found wrong in a list comes along.
  const unknown = analyse(paladin({ short: [{ use: 'nothing' }, { use: 'hs' }] })).lists;
  assert.deepEqual(unknown.problems, ['oneButton.short action 1 uses unknown ability "nothing"']);
});

test('the value reported is that of the cleaned list', () => {
  // Holy Strike only after 30 seconds, Seal of Command kept up: One Button
  // cannot wait for the clock, so it plays Holy Strike from the start.
  const written = [{ use: 'judge' }, { use: 'hs', if: { timeAtLeast: 30 } }, { use: 'soc', if: { buffDown: 'soc_buff' } }];
  const { run, lists } = analyse(paladin({ short: written }));
  const cleaned = [{ use: 'judge' }, { use: 'hs' }, { use: 'soc', if: { buffDown: 'soc_buff' } }];
  assert.equal(lists.primary.value, worth(run, cleaned));
  assert.notEqual(lists.primary.value, worth(run, run.model.oneButton.short), 'not the number of the list as written');
  // A condition only carried over roughly is simulated the rough way: a
  // debuff One Button does not track is counted from casts, 30 seconds each.
  const rough = cleanRotation(run.model, { actions: [{ use: 'judge', if: { buffUp: 'jotc' } }, { use: 'soc', if: { buffRemainsBelow: { id: 'soc_buff', sec: 3 } } }] }, SPELLS);
  assert.deepEqual(rough.actions, [{ use: 'judge', if: { usedOnTarget: 'judge' } }, { use: 'soc', if: { buffDown: 'soc_buff' } }]);
  // A DoT One Button tracks waits for itself to run out, asked or not.
  const dot = cleanRotation(run.model, { actions: [{ use: 'swp' }] }, SPELLS);
  assert.deepEqual(dot.actions, [{ use: 'swp', if: { buffDown: 'swp' } }]);
  assert.deepEqual(dot.list[0].gates, []);
});

test('each kind of fight has its own list and its own number', () => {
  const short = [{ use: 'judge' }, { use: 'hs' }];
  const long = [{ use: 'judge' }, { use: 'soc', if: { buffDown: 'soc_buff' } }, { use: 'hs' }];
  // Leveling: the model's fight is the short one, the other is long.
  const lev = analyse(paladin({ short, long }));
  assert.equal(lev.run.kind, 'short');
  assert.deepEqual(lev.lists.primary.list.map((e) => e.name), ['Judgement', 'Holy Strike']);
  assert.deepEqual(lev.lists.other.list.map((e) => e.name), ['Judgement', 'Seal of Command', 'Holy Strike']);
  assert.equal(lev.lists.other.value, worth(lev.run, lev.run.model.oneButton.long, { ...lev.run.other.fight, kind: undefined }));
  assert.notEqual(lev.lists.primary.value, lev.lists.other.value);
  // Dungeons: the other way round.
  const dun = analyse(paladin({ short, long }), { goal: 'dungeons' });
  assert.equal(dun.run.kind, 'long');
  assert.deepEqual(dun.lists.primary.list.map((e) => e.name), ['Judgement', 'Seal of Command', 'Holy Strike']);
  assert.deepEqual(dun.lists.other.list.map((e) => e.name), ['Judgement', 'Holy Strike']);
  // Only one list written: the other kind falls back to its best candidate.
  const one = analyse(paladin({ long }));
  assert.equal(one.lists.primary.source, 'best');
  assert.equal(one.lists.other.source, 'ai');
});
