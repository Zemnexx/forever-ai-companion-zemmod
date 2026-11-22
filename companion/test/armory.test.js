// The Armory plugin (src/armory): reading the AI's JSON, replaying talent
// orders under the game's rules, shaping gear plans, simulating rotations and
// measuring ideas, with a stand-in for the AI.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { extractJson } from '../src/armory/json.js';
import { talentIndex, validateOrder, shapeBuild, takenTalents } from '../src/armory/talents.js';
import { shapeGear, slotName, cleanWeights, equippable } from '../src/armory/gear.js';
import { runModel, shapeRotation, describeCondition, keepFromRun } from '../src/armory/rotation.js';
import { applyIdea, measureIdea, shapeIdeas } from '../src/armory/discover.js';
import { buildArmorySystem, buildArmoryMessage } from '../src/armory/prompts.js';
import { MODEL_SPEC } from '../src/armory/model-spec.js';
import { armoryConfig, createArmory, KINDS } from '../src/armory/index.js';
import { openArmoryStore } from '../src/armory/store.js';
import { DEFAULTS } from '../src/config.js';

// Two small trees: Arms (ids 1xx) and Fury (2xx).
const TREES = {
  api: 'classic', rowPoints: 5, spent: 3, available: 2, level: 14, pointsAtCap: 12,
  trees: [
    { id: 1, name: 'Arms', points: 3, talents: [
      { id: 101, name: 'Improved Heroic Strike', row: 1, col: 1, rank: 3, max: 3, desc: 'Reduces the cost of Heroic Strike by 3 Rage.' },
      { id: 102, name: 'Deflection', row: 1, col: 2, rank: 0, max: 5, desc: 'Parry +5%.' },
      { id: 103, name: 'Improved Rend', row: 2, col: 1, rank: 0, max: 3, desc: 'Rend +35% damage.' },
      { id: 104, name: 'Deep Wounds', row: 2, col: 2, rank: 0, max: 3, requires: 103, desc: 'Crits cause a bleed.' },
    ] },
    { id: 2, name: 'Fury', points: 0, talents: [
      { id: 201, name: 'Cruelty', row: 1, col: 1, rank: 0, max: 5, desc: 'Crit +5%.' },
      { id: 202, name: 'Unbridled Wrath', row: 2, col: 1, rank: 0, max: 5, desc: 'Chance for extra Rage.' },
    ] },
  ],
};

const MELEE_MODEL = {
  version: 1, kind: 'damage',
  fight: { duration: 60, targets: 1, targetLevel: 60, targetArmor: 3000 },
  player: {
    level: 60, autoAttack: 'melee',
    stats: { attackPower: 1000, critPct: 20, hitPct: 5 },
    weapons: { mainHand: { min: 150, max: 250, speed: 3.4 } },
    resource: { type: 'rage', max: 100, start: 0, perSwing: { perDamage: 0.03, critMult: 1.75 } },
  },
  abilities: [
    { id: 'bt', name: 'Bloodthirst', spellId: 23881, type: 'melee', school: 'physical', cost: 30, gcd: 1.5, cooldown: 6, damage: { apCoef: 0.45 } },
    { id: 'hs', name: 'Heroic Strike', type: 'melee', school: 'physical', cost: 15, gcd: 0, nextSwing: true, damage: { min: 157, max: 157, weaponPct: 100 } },
  ],
  statConversions: { strength: { attackPower: 2 }, agility: { critPct: 0.05 } },
  rotations: [
    { name: 'Bloodthirst only', actions: [{ use: 'bt', note: 'on cooldown' }] },
    { name: 'Bloodthirst and Heroic Strike', actions: [{ use: 'bt', note: 'on cooldown' }, { use: 'hs', if: { resourceAtLeast: 60 } }] },
  ],
};

const tmpStore = () => openArmoryStore(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'faic-armory-')), 'armory.json'));

test('the JSON object is found inside whatever the AI wrote around it', () => {
  assert.deepEqual(extractJson('Here you go:\n```json\n{"a": 1, "b": [1, 2,],}\n```\nHope it helps'), { a: 1, b: [1, 2] });
  assert.deepEqual(extractJson('{"text": "a } brace and a \\" quote", // why\n "n": 2}'), { text: 'a } brace and a " quote', n: 2 });
  // A small example before the real answer: the bigger object wins.
  assert.deepEqual(extractJson('e.g. {"x":1} then {"summary":"s","order":[1,2,3]}'), { summary: 's', order: [1, 2, 3] });
  assert.equal(extractJson('no json here'), null);
  assert.equal(extractJson('{"never": closed'), null);
});

test('a legal talent order passes untouched', () => {
  const index = talentIndex(TREES);
  const order = [101, 101, 101, 102, 102, 103, 103, 103, 104, 104, 104, 201];
  const checked = validateOrder(index, order);
  assert.deepEqual(checked.order, order);
  assert.deepEqual(checked.problems, []);
  assert.equal(shapeBuild(index, { name: 'Arms', summary: 's', keyTalents: [{ id: 104, why: 'bleeds' }, { id: 999 }] }, checked).spec, '11/1');
});

test('points given too early wait until the game would allow them', () => {
  const index = talentIndex(TREES);
  // Deep Wounds (row 2, needs Improved Rend 3/3) is listed first.
  const checked = validateOrder(index, [104, 101, 101, 101, 102, 102, 103, 103, 103, 104, 104, 201]);
  assert.equal(checked.order.length, 12);
  assert.equal(checked.order[0], 101);
  assert.equal(checked.ranks.get(104), 3);
  assert.equal(checked.reordered > 0, true);
  // Every prefix is legal: the row-2 talents come after 5 points in Arms.
  assert.ok(checked.order.indexOf(103) >= 5);
});

test('illegal talent points are dropped and explained', () => {
  const index = talentIndex(TREES);
  const checked = validateOrder(index, [101, 101, 101, 101, 555, 202, 'x']);
  assert.deepEqual(checked.order, [101, 101, 101]);
  assert.ok(checked.problems.some((p) => p.includes('already has 3/3')));
  assert.ok(checked.problems.some((p) => p.includes('no talent with id 555')));
  assert.ok(checked.problems.some((p) => p.includes('needs 5 points in Fury')));
  assert.ok(checked.problems.some((p) => p.includes('only 3 of 12 points')));
  // More points than a character has.
  const many = validateOrder(index, Array(30).fill(102).concat(Array(30).fill(201)), { limit: 6 });
  assert.equal(many.order.length, 6);
});

test('talents taken are summarized for the other requests', () => {
  assert.deepEqual(takenTalents(TREES), [{ tree: 'Arms', points: 3, talents: [{ name: 'Improved Heroic Strike', rank: '3/3', desc: 'Reduces the cost of Heroic Strike by 3 Rage.' }] }]);
  assert.equal(takenTalents(null), null);
});

test('a gear plan keeps only what the addon can show', () => {
  const data = shapeGear({
    summary: 'Your weapon is the weak spot.',
    weights: { strength: 2.2, 'attack power': 1, STAMINA: '0.3', junk: 'x', ZERO: 0 },
    slots: [
      { slot: 'Main Hand', picks: [
        { name: 'Ravager', itemId: 7717, level: 37, source: { type: 'Dungeon', where: 'Scarlet Monastery', from: 'Herod' }, why: 'Big upgrade', confidence: 'HIGH' },
        { name: 'ravager' }, // twice
        { name: 'Made up', itemId: 'abc', source: { type: 'lottery' } },
        { name: 'Third' }, { name: 'Fourth' },
      ] },
      { slot: 'nonsense', picks: [{ name: 'x' }] },
      { slot: 'ring', picks: [{ name: 'Seal', auction: true }] },
    ],
    next: ['Run Scarlet Monastery'], notes: 'one note',
  });
  assert.deepEqual(data.weights, { STRENGTH: 2.2, ATTACK_POWER: 1, STAMINA: 0.3 });
  assert.deepEqual(data.slots.map((s) => s.slot), ['finger1', 'mainHand']);
  const main = data.slots[1].picks;
  assert.equal(main.length, 3);
  assert.deepEqual(main[0], { name: 'Ravager', why: 'Big upgrade', itemId: 7717, level: 37, source: { type: 'dungeon', where: 'Scarlet Monastery', from: 'Herod', note: undefined }, confidence: 'high' });
  assert.equal(main[1].itemId, undefined);
  assert.equal(main[1].source.type, 'world');
  assert.equal(main[1].confidence, 'low');
  assert.equal(data.slots[0].picks[0].auction, true);
  assert.deepEqual(data.notes, ['one note']);
  assert.equal(slotName('Off-Hand'), 'offHand');
  assert.deepEqual(cleanWeights(null), {});
  assert.deepEqual(equippable([{ name: 'Cloth', count: 3 }, { name: 'Helm', equipSlot: 'INVTYPE_HEAD' }]), [{ name: 'Helm', equipSlot: 'INVTYPE_HEAD' }]);
});

test('a combat model is simulated and shaped for the addon', () => {
  const run = runModel(MELEE_MODEL, { iterations: 80 });
  assert.equal(run.fatal, false);
  const data = shapeRotation({ summary: 'Hit Bloodthirst on cooldown.', assumptions: ['Boss armor guessed'], model: MELEE_MODEL }, run);
  assert.equal(data.metric, 'dps');
  assert.equal(data.rotations.length, 2);
  assert.ok(data.rotations[0].value >= data.rotations[1].value, 'best first');
  assert.equal(data.rotations[0].best, true);
  const steps = data.rotations.find((r) => r.name === 'Bloodthirst and Heroic Strike').steps;
  assert.deepEqual(steps[0], { spell: 'Bloodthirst', when: 'on cooldown', spellId: 23881 });
  assert.equal(steps[1].when, 'resource 60+');
  const shares = data.rotations[0].breakdown.reduce((n, b) => n + b.share, 0);
  assert.ok(shares > 90 && shares <= 100.5, `shares add up to about 100 (${shares})`);
  assert.equal(data.weights.reference, 'attackPower');
  assert.equal(data.weights.normalized.attackPower, 1);
  assert.ok(data.weights.perPoint.strength > data.weights.perPoint.attackPower);
  assert.ok(data.table.some((row) => row.name === 'Bloodthirst' && row.perUse > 0));
  assert.deepEqual(data.fight, { duration: 60, targets: 1, targetLevel: 60, targetArmor: 3000 });
  // What is kept for later: the best rotation only.
  const kept = keepFromRun(run);
  assert.equal(kept.model.rotations.length, 1);
  assert.equal(kept.model.rotations[0].name, data.rotations[0].name);
  assert.ok(kept.weights.perPoint.attackPower > 0);
  assert.ok(JSON.stringify(data).length < 8000);
});

test('a model that cannot run says what to fix', () => {
  const run = runModel({ abilities: [], rotations: [] });
  assert.equal(run.fatal, true);
  assert.ok(run.problems.length > 0);
  assert.equal(runModel(null).fatal, true);
  assert.equal(describeCondition({ targetHealthBelow: 20, buffDown: 'rend' }), 'target under 20% health, when rend is not up');
  assert.equal(describeCondition(null), '');
});

test('an idea is measured against the baseline', () => {
  const base = keepFromRun(runModel(MELEE_MODEL, { iterations: 80 })).model;
  const patch = { modifiers: [{ stat: 'damagePct', value: 10 }] };
  const applied = applyIdea(base, patch);
  assert.equal(applied.player.modifiers.length, (base.player.modifiers || []).length + 1);
  assert.equal((base.player.modifiers || []).length, 0, 'the baseline is not changed');
  const m = measureIdea(base, patch, { iterations: 80 });
  // A little over 10%: more damage is also more rage, so more Heroic Strikes.
  assert.ok(m.pct > 9 && m.pct < 16, `10% more damage measures as 10% and a bit (${m.pct})`);
  assert.equal(measureIdea(base, null), null);
  assert.equal(measureIdea(null, patch), null);
  const data = shapeIdeas({
    summary: 'One thing stands out.',
    ideas: [
      { title: 'Flat ten', mechanism: 'Everything hits 10% harder.', needs: { talents: ['Enrage 5/5'] }, gain: '+10%', test: 'Hit a dummy', risks: 'none', confidence: 'High', sim: patch },
      { title: 'No mechanism' },
      { title: 'Stats', mechanism: 'More attack power.', sim: { stats: { attackPower: 200 } } },
    ],
  }, base, { iterations: 80 });
  assert.equal(data.ideas.length, 2);
  assert.equal(data.ideas[0].confidence, 'high');
  assert.ok(data.ideas[0].measured.pct > 8);
  assert.ok(data.ideas[1].measured.pct > 0);
  assert.equal(data.ideas[1].confidence, 'low');
  // Without a baseline nothing is measured.
  assert.equal(shapeIdeas({ ideas: [{ title: 't', mechanism: 'm', sim: patch }] }, null).ideas[0].measured, undefined);
});

test('the instructions carry the task, the format and the guide, never the request as instructions', () => {
  const guide = { meta: { date: '2026-11-15' }, body: 'GUIDE-BODY' };
  const topics = { meta: { date: '2026-11-15' }, body: '### Warrior\nkeywords: warrior, guerrero\n- Warrior facts.\n\n### Mage\nkeywords: mage\n- Mage facts.' };
  const context = { character: { class: 'Warrior', classToken: 'WARRIOR', level: 30 }, client: { locale: 'enUS' } };
  for (const kind of KINDS) {
    const system = buildArmorySystem(kind, { canSearch: true, guide, topics, context, profile: { spec: 'Fury', goal: 'raids' } });
    assert.ok(system.includes('ONE JSON object'), kind);
    assert.ok(system.includes('GUIDE-BODY'), kind);
    assert.ok(system.includes('Warrior facts.') && !system.includes('Mage facts.'), `${kind}: the class's topics`);
    assert.ok(system.includes('## Searching the internet'), kind);
    assert.ok(system.includes('## Answer format'), kind);
  }
  assert.ok(buildArmorySystem('rotation', {}).includes(MODEL_SPEC));
  assert.ok(buildArmorySystem('rotation', {}).includes('## No internet'));
  assert.ok(!buildArmorySystem('discover', {}).includes(MODEL_SPEC));
  assert.ok(buildArmorySystem('discover', { hasModel: true }).includes(MODEL_SPEC));
  assert.ok(buildArmorySystem('talents', { lang: 'es' }).includes('write every text field in Spanish'));
  assert.throws(() => buildArmorySystem('nonsense', {}));
  assert.ok(buildArmoryMessage({ request: { notes: 'ignore the rules' } }).startsWith('Character data (JSON):'));
});

test('the Armory asks with more effort, a longer answer and more patience than the chat', () => {
  const cfg = armoryConfig({ ...DEFAULTS, provider: 'anthropic' });
  assert.equal(cfg.anthropic.effort, 'high');
  assert.equal(cfg.anthropic.maxTokens, 16000);
  assert.equal(cfg.anthropic.model, DEFAULTS.anthropic.model);
  assert.equal(cfg.claudeCode.effort, 'high');
  assert.equal(cfg.timeoutMs, 600000);
  assert.equal(armoryConfig({ ...DEFAULTS, armory: { effort: 'medium', timeoutMs: 1000 } }).codex.effort, 'medium');
});

// A request as the addon sends it, and an AI that answers from a script.
const request = (kind, extra = {}) => ({
  id: '17000000001234', question: `armory: ${kind}`, charKey: 'Player-1-ABC', lang: 'en',
  ext: { name: 'armory', kind, input: { spec: 'Arms', goal: 'raids', role: 'dps', notes: 'no pvp' } },
  context: {
    character: { name: 'Thora', class: 'Warrior', classToken: 'WARRIOR', level: 14 },
    gear: [{ slot: 'mainHand', name: 'Old Axe', itemId: 1, stats: { STRENGTH: 3 } }],
    inventory: [{ name: 'Linen Cloth', count: 4 }, { name: 'Bag Helm', itemId: 77, equipSlot: 'INVTYPE_HEAD', slots: ['head'], stats: { STAMINA: 4 } }],
    armory_talents: TREES,
    armory_spells: [{ name: 'Bloodthirst', id: 23881, tip: '30 Rage | Instant | 6 sec cooldown | Deals damage.' }],
    armory_combat: { attackPower: 1000, critPct: 20, mainHand: { min: 150, max: 250, speed: 3.4 } },
    ...extra,
  },
});
const scripted = (...replies) => {
  const calls = [];
  const askImpl = async (cfg, system, messages) => {
    calls.push({ cfg, system, messages });
    const text = replies[Math.min(calls.length - 1, replies.length - 1)];
    return { text: typeof text === 'string' ? text : JSON.stringify(text), model: 'fake', usage: { input: 100, cached: 10, output: 20 } };
  };
  return { askImpl, calls };
};
const cfg = { ...DEFAULTS, provider: 'anthropic', armory: { ...DEFAULTS.armory, iterations: 60 } };

test('a talent request: one answer, checked', async () => {
  const { askImpl, calls } = scripted({ name: 'Arms', summary: 'Bleeds.', order: [101, 101, 101, 102, 102, 103, 103, 103, 104, 104, 104, 201], keyTalents: [{ id: 104, why: 'x' }], respec: null });
  const out = await createArmory({ store: tmpStore(), askImpl }).handle(request('talents'), { cfg });
  assert.equal(calls.length, 1);
  assert.equal(out.data.kind, 'talents');
  assert.equal(out.data.order.length, 12);
  assert.equal(out.data.spec, '11/1');
  assert.equal(out.data.respec, undefined);
  assert.deepEqual(out.data.asked, { spec: 'Arms', goal: 'raids', role: 'dps', level: 14 });
  assert.deepEqual(out.usage, { input: 100, cached: 10, output: 20 });
  assert.ok(out.text.includes('Arms (11/1)'));
  // The AI got the trees and the player's wishes as data, in the user message.
  const sent = JSON.parse(calls[0].messages[0].content.split('\n')[1]);
  assert.equal(sent.request.notes, 'no pvp');
  assert.equal(sent.armory_talents.trees.length, 2);
  assert.equal(sent.inventory, undefined);
  assert.ok(!calls[0].system.includes('no pvp'));
  assert.equal(calls[0].cfg.anthropic.effort, 'high');
});

test('a build with holes is sent back once with what was wrong', async () => {
  const { askImpl, calls } = scripted(
    'Sure! {"name": "Bad", "order": [104, 104, 999]}',
    { name: 'Fixed', summary: 'ok', order: [101, 101, 101, 102, 102, 103, 103, 103, 104, 104, 104, 201] },
  );
  const out = await createArmory({ store: tmpStore(), askImpl }).handle(request('talents'), { cfg });
  assert.equal(calls.length, 2);
  assert.equal(out.data.name, 'Fixed');
  assert.equal(out.usage.input, 200);
  const repair = calls[1].messages[2].content;
  assert.ok(repair.includes('no talent with id 999') && repair.includes('"Deep Wounds" (row 2) needs 5 points in Arms first'));
  assert.equal(calls[1].messages[1].role, 'assistant');
});

test('an answer that is not JSON twice is an error, and so is a request without talents', async () => {
  const { askImpl } = scripted('I cannot do that.', 'Still no.');
  await assert.rejects(createArmory({ store: tmpStore(), askImpl }).handle(request('talents'), { cfg }), /could not be read/);
  await assert.rejects(createArmory({ store: tmpStore(), askImpl }).handle(request('talents', { armory_talents: null }), { cfg }), /No talent data/);
  await assert.rejects(createArmory({ store: tmpStore(), askImpl }).handle(request('rotation', { armory_spells: [] }), { cfg }), /No spell data/);
  await assert.rejects(createArmory({ store: tmpStore(), askImpl }).handle({ ...request('talents'), ext: { name: 'armory', kind: 'hack' } }, { cfg }), /does not know/);
});

test('a rotation request is simulated, and its model kept for the gear plan and for ideas', async () => {
  const store = tmpStore();
  const first = scripted({ summary: 'Bloodthirst on cooldown.', assumptions: ['armor guessed'], model: MELEE_MODEL });
  const armory = createArmory({ store, askImpl: first.askImpl });
  const out = await armory.handle(request('rotation'), { cfg });
  assert.equal(first.calls.length, 1);
  assert.equal(out.data.rotations.length, 2);
  assert.ok(out.text.includes('dps'));
  assert.ok(first.calls[0].system.includes('Combat model format'));
  const kept = store.get('Player-1-ABC');
  assert.equal(kept.model.rotations.length, 1);
  assert.equal(kept.goal, 'raids');

  // The gear plan gets the measured weights...
  const gear = scripted({ summary: 'g', weights: { STRENGTH: 2 }, slots: [{ slot: 'head', picks: [{ name: 'Bag Helm', itemId: 77, source: { type: 'world' }, confidence: 'high' }] }] });
  const plan = await createArmory({ store, askImpl: gear.askImpl }).handle(request('gear'), { cfg });
  const sent = JSON.parse(gear.calls[0].messages[0].content.split('\n')[1]);
  assert.ok(sent.armory_weights.perPoint.attackPower > 0);
  assert.deepEqual(sent.inventory.map((i) => i.name), ['Bag Helm']);
  assert.equal(sent.talents[0].tree, 'Arms');
  assert.equal(plan.data.slots[0].picks[0].itemId, 77);

  // ...and an idea is measured against the kept model.
  const ideas = scripted({ summary: 'i', ideas: [{ title: 'Ten', mechanism: 'm', confidence: 'medium', sim: { modifiers: [{ stat: 'damagePct', value: 10 }] } }] });
  const found = await createArmory({ store, askImpl: ideas.askImpl }).handle(request('discover'), { cfg });
  assert.ok(ideas.calls[0].system.includes('armory_model'));
  assert.ok(found.data.ideas[0].measured.pct > 8);
  assert.equal(found.data.baseline, true);
});

test('a model the simulator cannot run is sent back, and fails clearly if it stays broken', async () => {
  const broken = { summary: 's', model: { abilities: [], rotations: [] } };
  const fixed = scripted(broken, { summary: 'ok', model: MELEE_MODEL });
  const out = await createArmory({ store: tmpStore(), askImpl: fixed.askImpl }).handle(request('rotation'), { cfg });
  assert.equal(fixed.calls.length, 2);
  assert.equal(out.data.rotations.length, 2);
  const never = scripted(broken, broken);
  await assert.rejects(createArmory({ store: tmpStore(), askImpl: never.askImpl }).handle(request('rotation'), { cfg }), /combat model/);
});

test('test mode answers every kind without an AI, through the same checks', async () => {
  const echo = { ...cfg, provider: 'echo' };
  const never = async () => { throw new Error('the AI must not be asked'); };
  const armory = createArmory({ store: tmpStore(), askImpl: never });
  const talents = await armory.handle(request('talents'), { cfg: echo });
  assert.equal(talents.model, 'echo');
  assert.equal(talents.data.test, true);
  assert.equal(talents.data.order.length, 12);
  assert.equal(talents.data.order[0], 101, 'the chosen tree first');
  assert.ok(talents.text.startsWith('Test mode'));
  const gear = await armory.handle(request('gear'), { cfg: echo });
  assert.deepEqual(gear.data.slots.map((s) => s.slot), ['head']);
  assert.deepEqual(gear.data.weights, { STRENGTH: 1 });
  const rotation = await armory.handle(request('rotation'), { cfg: echo });
  assert.equal(rotation.data.rotations.length, 2);
  assert.ok(rotation.data.rotations[0].value > 0);
  const caster = await armory.handle(request('rotation', { armory_combat: { spellPower: 200 } }), { cfg: echo });
  assert.equal(caster.data.rotations[0].name, 'Bolt');
  const ideas = await armory.handle(request('discover'), { cfg: echo });
  assert.equal(ideas.data.ideas.length, 1);
});
