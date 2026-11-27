// The best rotation of an analysis as a Forever One Button priority list
// (src/armory/onebutton.js): every condition of the model mapped to One
// Button's gates, or named in "left" when it could not be carried over.
import test from 'node:test';
import assert from 'node:assert/strict';
import { oneButtonList } from '../src/armory/onebutton.js';
import { normalizeModel } from '../src/armory/sim/engine.js';
import { runModel, shapeRotation } from '../src/armory/rotation.js';

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
  assert.ok(typeof ob.rotation === 'string' && ob.rotation.length <= 80);
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
  assert.deepEqual(gatesOf([{ use: 'exo', if: { buffDown: 'cons' } }]), [{ t: 'stack', id: 20924, op: '<', n: 1, tgt: true }]);
  assert.deepEqual(gatesOf([{ use: 'exo', if: { buffStacksAtLeast: { id: 'jotc', n: 2 } } }]), [{ t: 'stack', id: 20271, op: '>=', n: 2, tgt: true }]);
  assert.deepEqual(gatesOf([{ use: 'judge', if: { buffStacksAtLeast: { id: 'soc_buff', n: 2 } } }]), [{ t: 'stack', id: 20920, op: '>=', n: 2 }]);
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
    v: 1, context: 'aoe', rotation: 'Both',
    list: [{ id: 10314, name: 'Exorcism', gates: [] }, { id: 35395, name: 'Crusader Strike', gates: [{ t: 'targets', op: '>=', n: 1 }] }],
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
});
