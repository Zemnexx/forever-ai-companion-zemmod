// Calibration on the app's side (src/armory/scaling.js): the addon's
// measurements of how abilities scale, read defensively, passed to the AI,
// and compared with the combat model it wrote.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { compareScaling, modelCoefficient, shapeScaling } from '../src/armory/scaling.js';
import { normalizeModel } from '../src/armory/sim/engine.js';
import { buildArmorySystem } from '../src/armory/prompts.js';
import { createArmory } from '../src/armory/index.js';
import { openArmoryStore } from '../src/armory/store.js';
import { DEFAULTS } from '../src/config.js';

// What the addon sends (Calibrate.Section in the Armory).
const SCALING = {
  v: 1, readings: 6,
  abilities: [
    { name: 'Judgement', id: 20271, rank: 'Rank 2', effects: [
      { index: 1, kind: 'damage', text: '150 to 156 Holy damage', value: 153, status: 'scales', readings: 5,
        perPoint: { spellPower: 0.43 }, base: 83, margin: 0.01, rms: 0.3 },
      { index: 2, kind: 'damage', text: '300 to 310 if the target is stunned', value: 305, status: 'scales', readings: 5,
        perPoint: { spellPower: 0.86 }, base: 165, margin: 0.01, rms: 0.3 },
    ] },
    { name: 'Seal of Command', id: 20375, effects: [
      { index: 1, kind: 'damage', text: '82 to 87 Holy damage', value: 84.5, status: 'flat', readings: 5, tested: ['attackPower', 'spellPower'] },
    ] },
    { name: 'Holy Strike', effects: [
      { index: 1, kind: 'damage', text: '160 Holy damage', value: 160, status: 'scales', readings: 4, perPoint: { attackPower: 0.2 }, base: 40, margin: 0.01 },
    ] },
    { name: 'Consecration', effects: [
      { index: 1, kind: 'damage', text: '120 Holy damage over 8 sec', value: 120, overTime: true, status: 'scales', readings: 4, perPoint: { spellPower: 0.4 }, base: 40 },
    ] },
    { name: 'Holy Light', effects: [
      { index: 1, kind: 'heal', text: '400 to 420', value: 410, status: 'ambiguous', readings: 4,
        candidates: [{ stat: 'spellPower', perPoint: 0.71 }, { stat: 'healingPower', perPoint: 0.71 }] },
    ] },
    { name: 'Exorcism', effects: [
      { index: 1, kind: 'damage', text: '200 Holy damage', value: 200, status: 'scales', readings: 3, perPoint: { spellPower: 0.43 }, level: 30 },
    ] },
  ],
};

const MODEL = {
  version: 1, kind: 'damage',
  fight: { duration: 60, targets: 1, targetLevel: 36, targetArmor: 2000 },
  player: {
    level: 34, autoAttack: 'melee',
    stats: { attackPower: 600, spellPower: 160, critPct: 5 },
    weapons: { mainHand: { min: 80, max: 120, speed: 3.5 } },
    resource: { type: 'mana', max: 2000, start: 2000, regenPerSec: 5 },
  },
  abilities: [
    { id: 'judgement', name: 'Judgement', spellId: 20271, type: 'spell', school: 'holy', cost: 50, cooldown: 8, damage: { min: 83, max: 86, spCoef: 0.43 } },
    { id: 'judgement_stunned', name: 'Judgement', type: 'spell', school: 'holy', cost: 50, cooldown: 8, damage: { min: 165, max: 175, spCoef: 0.5 } },
    { id: 'soc', name: 'Seal of Command', type: 'spell', school: 'holy', damage: { min: 82, max: 87 } },
    { id: 'strike', name: 'Holy Strike', type: 'melee', school: 'holy', cooldown: 6, damage: { min: 130, max: 130, apCoef: 0.05 } },
    { id: 'consecration', name: 'Consecration', type: 'spell', school: 'holy', cooldown: 8, dot: { tickDamage: 10, spCoefPerTick: 0.1, interval: 2, duration: 8 } },
    { id: 'crusader', name: 'Crusader Strike', type: 'melee', damage: { weaponPct: 100, normalizedSpeed: 3.3 } },
  ],
  rotations: [{ name: 'Judge', actions: [{ use: 'judgement' }, { use: 'strike' }, { use: 'consecration' }] }],
};

test('the section is read defensively: unknown stats, bad numbers and thin readings are dropped', () => {
  assert.equal(shapeScaling(null), null);
  assert.equal(shapeScaling('nonsense'), null);
  assert.equal(shapeScaling([]), null);
  assert.equal(shapeScaling({ abilities: [] }), null);
  const shaped = shapeScaling({
    readings: '6',
    abilities: [
      ...SCALING.abilities,
      { name: '', effects: [SCALING.abilities[0].effects[0]] },
      { name: 'Bad', effects: [
        { kind: 'damage', status: 'scales', readings: 5, perPoint: { spellPower: -1 } },
        { kind: 'damage', status: 'scales', readings: 5, perPoint: { strength: 1, spellPower: 'x' } },
        { kind: 'damage', status: 'scales', readings: 2, perPoint: { spellPower: 0.4 } },
        { kind: 'damage', status: 'scales', readings: 5, perPoint: { spellPower: 1e9 } },
        { kind: 'damage', status: 'flat', readings: 5, tested: ['luck'] },
        { kind: 'damage', status: 'ambiguous', readings: 5, candidates: [{ stat: 'spellPower', perPoint: 0.4 }] },
        { kind: 'damage', status: 'guessed', readings: 5 },
      ] },
      { name: 'x'.repeat(200), id: 'no', rank: 7, effects: [{ kind: 'weird', status: 'flat', readings: 3, tested: ['spellPower', 'spellPower', 'nope'], school: 'void' }] },
    ],
  });
  assert.equal(shaped.readings, 6);
  assert.deepEqual(shaped.abilities.map((a) => a.name.slice(0, 20)), ['Judgement', 'Seal of Command', 'Holy Strike', 'Consecration', 'Holy Light', 'Exorcism', 'x'.repeat(20)]);
  const last = shaped.abilities.at(-1);
  assert.equal(last.name.length, 60);
  assert.equal(last.id, undefined);
  assert.equal(last.rank, '7');
  assert.deepEqual(last.effects, [{ index: undefined, kind: 'other', text: undefined, value: undefined, status: 'flat', readings: 3, tested: ['spellPower'] }]);
  assert.deepEqual(shaped.abilities[0].effects[0].perPoint, { spellPower: 0.43 });
  // Bounded: no more than 30 abilities and 40 numbers in all.
  const many = shapeScaling({ abilities: Array.from({ length: 50 }, (_, i) => ({ name: `Spell ${i}`, effects: Array(4).fill(SCALING.abilities[0].effects[0]) })) });
  assert.equal(many.abilities.length, 10);
  assert.equal(many.abilities.reduce((n, a) => n + a.effects.length, 0), 40);
});

test('the model is compared with what was measured, ability by ability, without changing it', () => {
  const { model } = normalizeModel(MODEL);
  const before = JSON.stringify(model);
  const { entries } = compareScaling(model, shapeScaling(SCALING));
  assert.equal(JSON.stringify(model), before, 'the model is left as it was');
  const find = (name, s, measured) => entries.filter((e) => e.name === name && e.stat === s && (measured === undefined || e.measured === measured));
  // Judgement twice in the model: each stands for the measured number closest to what it does.
  assert.deepEqual(find('Judgement', 'spellPower', 0.43)[0], { name: 'Judgement', kind: 'damage', stat: 'spellPower', measured: 0.43, model: 0.43, agrees: true });
  assert.deepEqual(find('Judgement', 'spellPower', 0.86)[0], { name: 'Judgement', kind: 'damage', stat: 'spellPower', measured: 0.86, model: 0.5, agrees: false });
  // "Does not scale" agrees with a coefficient of 0.
  assert.deepEqual(find('Seal of Command', 'attackPower')[0], { name: 'Seal of Command', kind: 'damage', stat: 'attackPower', measured: 0, flat: true, model: 0, agrees: true });
  assert.equal(find('Seal of Command', 'spellPower')[0].agrees, true);
  assert.deepEqual(find('Holy Strike', 'attackPower')[0], { name: 'Holy Strike', kind: 'damage', stat: 'attackPower', measured: 0.2, model: 0.05, agrees: false });
  // A periodic number is a total: the model's per tick coefficient times its 4 ticks.
  assert.deepEqual(find('Consecration', 'spellPower')[0], { name: 'Consecration', kind: 'damage', stat: 'spellPower', measured: 0.4, model: 0.4, agrees: true });
  // Not in the model, and measured at an earlier level.
  assert.deepEqual(find('Exorcism', 'spellPower')[0], { name: 'Exorcism', kind: 'damage', stat: 'spellPower', measured: 0.43, level: 30, model: null });
  // Which stat it was cannot be told: nothing to compare.
  assert.equal(entries.some((e) => e.name === 'Holy Light'), false);
  assert.equal(compareScaling(model, null), null);
});

test('a model coefficient counts what the simulator does with the stat', () => {
  const { model } = normalizeModel(MODEL);
  const by = (id) => model.abilities.find((a) => a.id === id);
  // A weapon's share of an attack adds attack power as a weapon hit does (normalized speed / 14).
  assert.ok(Math.abs(modelCoefficient(model, by('crusader'), 'damage', 'attackPower') - 3.3 / 14) < 1e-9);
  // A spell does not scale with attack power, nor melee with ranged attack power.
  assert.equal(modelCoefficient(model, by('judgement'), 'damage', 'attackPower'), 0);
  assert.equal(modelCoefficient(model, by('strike'), 'damage', 'rangedAttackPower'), 0);
  // In a healing model every ability scales with healing power, not spell power.
  const { model: healing } = normalizeModel({ ...MODEL, kind: 'healing', abilities: [{ id: 'hl', name: 'Holy Light', type: 'heal', damage: { min: 300, max: 330, spCoef: 0.71 } }] });
  assert.equal(modelCoefficient(healing, healing.abilities[0], 'damage', 'healingPower'), 0.71);
  assert.equal(modelCoefficient(healing, healing.abilities[0], 'damage', 'spellPower'), 0);
});

test('the AI is told what the section means and to use it, and to say what was measured', () => {
  const system = buildArmorySystem('rotation', {});
  assert.match(system, /- armory_scaling: how this character's abilities scale, MEASURED by the addon/);
  assert.match(system, /wherever "armory_scaling" measures an ability's number, use the measurement instead of your own coefficient/);
  assert.match(system, /"flat" is a coefficient of 0 for every stat in "tested"/);
  assert.match(system, /In "assumptions", say in one entry which abilities' scaling was measured and in another which ones you had to guess/);
  assert.match(buildArmorySystem('discover', {}), /"armory_scaling", when present, is how this character's abilities were measured to scale/);
});

const tmpStore = () => openArmoryStore(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'faic-scaling-')), 'armory.json'));
const cfg = { ...DEFAULTS, provider: 'anthropic', armory: { ...DEFAULTS.armory, iterations: 60 } };
const request = (kind, extra = {}) => ({
  id: '17000000001234', question: `armory: ${kind}`, charKey: 'Player-1-ABC', lang: 'en',
  ext: { name: 'armory', kind, input: { spec: 'Retribution', goal: 'leveling', role: 'dps' } },
  context: {
    character: { name: 'Lumen', class: 'Paladin', classToken: 'PALADIN', level: 34 },
    armory_spells: [{ name: 'Judgement', id: 20271, tip: '50 Mana | Instant 8 sec cooldown | Unleashes the energy of the seal, causing 150 to 156 Holy damage.' }],
    armory_combat: { attackPower: 600, spellPower: 160 },
    ...extra,
  },
});
const scripted = (reply) => {
  const calls = [];
  return { calls, askImpl: async (c, system, messages) => { calls.push({ system, messages }); return { text: JSON.stringify(reply), model: 'fake' }; } };
};
const sent = (call) => JSON.parse(call.messages[0].content.split('\n')[1]);

test('a rotation request passes the measurements to the AI and reports the comparison', async () => {
  const { askImpl, calls } = scripted({ summary: 's', assumptions: ['Judgement measured.'], model: MODEL });
  const out = await createArmory({ store: tmpStore(), askImpl }).handle(request('rotation', { armory_scaling: SCALING }), { cfg });
  assert.equal(sent(calls[0]).armory_scaling.abilities[0].name, 'Judgement');
  assert.equal(sent(calls[0]).armory_scaling.v, undefined, 'the shaped section, not the raw one');
  const judgement = out.data.scaling.entries.find((e) => e.name === 'Judgement' && e.measured === 0.43);
  assert.equal(judgement.agrees, true);
  assert.ok(JSON.stringify(out.data.scaling).length < 6000);
  // The rest of the result is as before.
  assert.equal(out.data.kind, 'rotation');
  assert.ok(out.data.rotations.length >= 1);

  // A Lab request gets the measurements too.
  const lab = scripted({ summary: 'i', ideas: [] });
  await createArmory({ store: tmpStore(), askImpl: lab.askImpl }).handle(request('discover', { armory_scaling: SCALING }), { cfg });
  assert.equal(sent(lab.calls[0]).armory_scaling.abilities.length, 6);
});

test('without measurements, or with nothing usable in them, a rotation goes exactly as before', async () => {
  const runs = [];
  for (const extra of [{}, { armory_scaling: { abilities: [{ name: 'Junk', effects: [{ status: 'scales', readings: 1 }] }] } }, { armory_scaling: 'x' }]) {
    const { askImpl, calls } = scripted({ summary: 's', model: MODEL });
    const out = await createArmory({ store: tmpStore(), askImpl }).handle(request('rotation', extra), { cfg });
    assert.equal('armory_scaling' in sent(calls[0]), false);
    assert.equal(out.data.scaling, undefined);
    runs.push(out.data);
  }
  assert.deepEqual(runs[1], runs[0]);
  assert.deepEqual(runs[2], runs[0]);
});
