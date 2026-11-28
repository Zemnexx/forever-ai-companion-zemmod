// Every talent the character has is accounted for in a rotation answer
// (src/armory/accounting.js): the AI says where the model carries each one
// or why it does not, the program checks that against the character's
// talents and the model, and the result says what was counted.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { accountTalents, aurasForPrompt, shapeTalents, talentNames } from '../src/armory/accounting.js';
import { fitRotation, runModel, shapeRotation } from '../src/armory/rotation.js';
import { buildArmorySystem } from '../src/armory/prompts.js';
import { createArmory } from '../src/armory/index.js';
import { openArmoryStore } from '../src/armory/store.js';
import { DEFAULTS } from '../src/config.js';

// The owner's case: a Retribution paladin with Unsealed Wrath, whose stored
// copies show in the game as "Echo of Command", and a talent on the player.
const TALENTS = {
  pointsAtCap: 51,
  trees: [
    { id: 3, name: 'Retribution', points: 6, talents: [
      { id: 301, name: 'Unsealed Wrath', row: 3, col: 2, rank: 1, max: 1, desc: 'Your melee attacks store a copy of your active Seal for 15 sec, stacking up to 3 times. Landing an attack with a different Seal consumes all stacks, giving the stored Seal its normal chance to activate once per stack.' },
      { id: 302, name: 'Benediction', row: 1, col: 1, rank: 5, max: 5, desc: 'Reduces the mana cost of your Seals by 15%.' },
      { id: 303, name: 'Eye for an Eye', row: 3, col: 1, rank: 0, max: 2, desc: 'Not taken.' },
    ] },
    { id: 2, name: 'Protection', points: 2, talents: [
      { id: 201, name: 'Toughness', row: 1, col: 2, rank: 2, max: 5, desc: 'Increases your armor value from items by 4%.' },
    ] },
  ],
};
const SPELLS = [
  { name: 'Seal of Command', id: 20920 },
  { name: 'Seal of Righteousness', id: 20293 },
  { name: 'Judgement', id: 20271 },
];
const AURAS = [
  { name: 'Echo of Command', id: 1311703, desc: 'A stored copy of Seal of Command.', stacks: 3 },
  { name: 'Echo of Righteousness', id: 1311704, desc: 'A stored copy of Seal of Righteousness.', stacks: 2 },
];
// Seal of Command kept up; its stored copies (a proc on every swing) spent by
// switching to Seal of Righteousness at 3 stacks.
const MODEL = {
  version: 1, kind: 'damage', fight: { duration: 25, targets: 1, targetLevel: 40, targetArmor: 2400 },
  player: { level: 40, autoAttack: 'melee', stats: { attackPower: 600, critPct: 8 }, weapons: { mainHand: { min: 80, max: 120, speed: 3.5 } },
    resource: { type: 'mana', max: 3000, start: 3000, regenPerSec: 10 }, modifiers: [{ stat: 'damagePct', value: 2 }] },
  abilities: [
    { id: 'soc', name: 'Seal of Command', type: 'spell', school: 'holy', cost: 65, gcd: 1.5, applies: ['soc_buff'], consumes: ['sor_buff'] },
    { id: 'sor', name: 'Seal of Righteousness', type: 'spell', school: 'holy', cost: 60, gcd: 1.5, applies: ['sor_buff'], consumes: ['soc_buff', 'echo_cmd'], damage: { min: 150, max: 150 } },
    { id: 'judge', name: 'Judgement', type: 'spell', school: 'holy', cost: 50, gcd: 0, cooldown: 8, damage: { min: 200, max: 200 } },
  ],
  buffs: [
    { id: 'soc_buff', name: 'Seal of Command', duration: 30, modifiers: [{ stat: 'damagePct', value: 10 }] },
    { id: 'sor_buff', name: 'Seal of Righteousness', duration: 30, modifiers: [{ stat: 'damagePct', value: 8 }] },
    { id: 'echo_cmd', name: 'Echo of Command', duration: 15, maxStacks: 3 },
  ],
  procs: [{ id: 'store', name: 'Unsealed Wrath', trigger: 'meleeHit', chance: 1, effect: { buff: 'echo_cmd' } }],
  rotations: [
    { name: 'Command', actions: [{ use: 'judge' }, { use: 'soc', if: { buffDown: 'soc_buff' } }] },
    { name: 'Swap at 3 echoes', actions: [{ use: 'sor', if: { buffStacksAtLeast: { id: 'echo_cmd', n: 3 } } }, { use: 'judge' }, { use: 'soc', if: { buffDown: 'soc_buff' } }] },
  ],
  oneButton: { short: [{ use: 'sor', if: { buffStacksAtLeast: { id: 'echo_cmd', n: 3 } } }, { use: 'judge' }, { use: 'soc', if: { buffDown: 'soc_buff' } }] },
};
const ACCOUNTED = [
  { name: ' unsealed WRATH', in: ['echo_cmd', 'store'], how: 'stored seals as Echo of Command, spent by the swap' },
  { name: 'Benediction', in: ['player'], how: 'seals cost 15% less mana' },
  { name: 'Toughness', in: [], how: 'armor: defense, not damage' },
];
const TAKEN = ['Unsealed Wrath', 'Benediction', 'Toughness'];

const tmpStore = () => openArmoryStore(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'faic-talents-')), 'armory.json'));
const cfg = { ...DEFAULTS, provider: 'anthropic', armory: { ...DEFAULTS.armory, iterations: 40 } };
const request = (extra = {}) => ({
  id: '17000000001234', question: 'armory: rotation', charKey: 'Player-1-PAL', lang: 'en',
  ext: { name: 'armory', kind: 'rotation', input: { spec: 'Retribution', goal: 'leveling', role: 'dps' } },
  context: {
    character: { name: 'Lumen', class: 'Paladin', classToken: 'PALADIN', level: 40 },
    armory_talents: TALENTS, armory_spells: SPELLS, armory_auras: AURAS,
    armory_combat: { attackPower: 600, critPct: 8, mainHand: { min: 200, max: 240, speed: 3.5 } },
    ...extra,
  },
});
const scripted = (...replies) => {
  const calls = [];
  const askImpl = async (c, system, messages) => {
    calls.push({ system, messages });
    return { text: JSON.stringify(replies[Math.min(calls.length - 1, replies.length - 1)]), model: 'fake' };
  };
  return { askImpl, calls };
};
const sent = (call) => JSON.parse(call.messages[0].content.split('\n')[1]);

test('the AI is told to account for every talent, and how, in the task and the answer format', () => {
  const system = buildArmorySystem('rotation', {});
  assert.match(system, /- "talents": one entry for every talent in "armory_talents" \(this request sends only the ones the character has points in\), named exactly as there/);
  assert.match(system, /a talent the character has that "armory_model" does not carry is something that was wrong in it/);
  assert.match(system, /A talent that only pays off when the rotation plays around it \(a swap, stacks to spend, a buff to consume\) is played around by at least one candidate, and by the One Button lists where they can\./);
  assert.match(system, /"talents": \[ \{ "name": "exactly as in armory_talents", "in": \[/);
  assert.match(system, /"in": \[\] means it is not in the model, and "how" then says why it does not change the result for this role \(utility, defense for a damage dealer, healing only, not usable in this fight\)/);
  assert.match(system, /- armory_auras: buffs the addon has seen on the character, each \{ "name", "id" \} \(the buff's own spell id\), with "desc" \(the buff's own tooltip text\) and "stacks"/);
  assert.match(system, /A buff here can be the visible form of a talent under another name \(a talent's stored copies or charges\): match them by what they do, and give the model's buff exactly the name the game gives it here\./);
  // The other requests have no such list.
  assert.ok(!buildArmorySystem('discover', { hasModel: true }).includes('"talents": [ { "name"'));
});

test('the talents the character has, by the names the game gave', () => {
  assert.deepEqual(talentNames(TALENTS), TAKEN);
  assert.deepEqual(talentNames(null), []);
  assert.deepEqual(talentNames({ trees: [{ talents: [{ name: 'A', rank: 1 }, { name: 'a', rank: 2 }, { name: 'B', rank: 0 }] }] }), ['A']);
});

test('the accounting: counted, left out with why, and what is missing or points at nothing', () => {
  const { model } = runModel(MODEL, { iterations: 10, weights: false });
  const good = accountTalents(ACCOUNTED, model, TAKEN);
  assert.deepEqual(good, {
    counted: [{ name: 'Unsealed Wrath', how: 'stored seals as Echo of Command, spent by the swap' }, { name: 'Benediction', how: 'seals cost 15% less mana' }],
    left: [{ name: 'Toughness', why: 'armor: defense, not damage' }],
    missing: [],
    problems: [],
  });
  // A talent left unlisted, one pointing at nothing, one only partly there,
  // one the character does not have, a repeated entry.
  const bad = accountTalents([
    { name: 'Benediction', in: ['seal_cost'], how: 'x' },
    { name: 'Toughness', in: ['player', 'armor_buff'], how: 'y' },
    { name: 'Eye for an Eye', in: ['nothing'] },
    { name: 'toughness', in: [] },
    { name: 'Benediction', in: ['player'] },
  ], model, TAKEN);
  assert.deepEqual(bad.counted, [{ name: 'Toughness', how: 'y' }]);
  assert.deepEqual(bad.left, []);
  assert.deepEqual(bad.missing, ['Unsealed Wrath', 'Benediction']);
  assert.deepEqual(bad.problems, [
    '"talents" does not account for this talent the character has: Unsealed Wrath. Give each one an entry: in the model if it changes the result, or with "in": [] and why it does not',
    '"talents": "Benediction" is in "seal_cost", which the model has no ability, buff or proc for: put its effect in the model, or point "in" at where it is',
    '"talents": "Toughness" is in "armor_buff", which the model has no ability, buff or proc for: put its effect in the model, or point "in" at where it is',
  ]);
  // No list at all; a name instead of an id counts as the same thing.
  const none = accountTalents(undefined, model, TAKEN);
  assert.deepEqual(none.missing, TAKEN);
  assert.match(none.problems[0], /these talents the character has: Unsealed Wrath, Benediction, Toughness\./);
  assert.deepEqual(accountTalents([{ name: 'Unsealed Wrath', in: 'echo of command' }], model, ['Unsealed Wrath']).counted, [{ name: 'Unsealed Wrath' }]);
  // Nothing to check against: nothing said.
  assert.deepEqual(accountTalents(ACCOUNTED, model, []), { counted: [], left: [], missing: [], problems: [] });
  assert.equal(shapeTalents(accountTalents(ACCOUNTED, model, []), []), null);
});

test('the result says what was counted, its texts bounded, and nothing without talents', () => {
  const run = runModel(MODEL, { iterations: 20, weights: false });
  const long = 'This talent stores a copy of the active seal on every melee swing and the swap to another seal spends all of them at once for extra damage';
  const raw = { summary: 's', model: MODEL, talents: [{ ...ACCOUNTED[0], how: long }, ACCOUNTED[2]] };
  const data = shapeRotation(raw, run, { spells: SPELLS, auras: AURAS, talents: TAKEN });
  assert.deepEqual(data.talents, {
    counted: [{ name: 'Unsealed Wrath', how: 'This talent stores a copy of the active seal on every melee swing and the swap to another seal spends all of them at...' }],
    left: [{ name: 'Toughness', why: 'armor: defense, not damage' }],
    missing: ['Benediction'],
  });
  assert.ok(data.talents.counted[0].how.length <= 120);
  // Every one counted: no empty lists.
  assert.deepEqual(Object.keys(shapeRotation({ ...raw, talents: ACCOUNTED.slice(0, 2) }, run, { talents: TAKEN.slice(0, 2) }).talents), ['counted']);
  // No talents in the request: no key at all.
  assert.equal('talents' in shapeRotation(raw, run, { spells: SPELLS }), false);
});

test('when an answer is too big, what is said about each talent is shortened before anything else', () => {
  const run = runModel(MODEL, { iterations: 20, weights: false });
  const how = 'word '.repeat(30).trim();
  const data = shapeRotation({ model: MODEL, talents: ACCOUNTED.map((t) => ({ ...t, how })) }, run, { talents: TAKEN });
  const before = JSON.stringify(data.otherFight);
  fitRotation(data, JSON.stringify(data).length - 10);
  assert.ok(data.talents.counted.every((t) => t.how.length <= 50) && data.talents.left[0].why.length <= 50);
  assert.equal(JSON.stringify(data.otherFight), before, 'the other fight untouched');
  fitRotation(data, JSON.stringify(data).length - 10);
  assert.deepEqual(data.talents.counted.map((t) => Object.keys(t)), [['name'], ['name']], 'then the texts go');
});

test('a talent left out of the answer is worth one correction round, with plain lines', async () => {
  const forgot = { summary: 's', model: MODEL, talents: ACCOUNTED.slice(1) };
  const fixed = { summary: 'fixed', model: MODEL, talents: ACCOUNTED };
  const ai = scripted(forgot, fixed);
  const out = await createArmory({ store: tmpStore(), askImpl: ai.askImpl }).handle(request(), { cfg });
  assert.equal(ai.calls.length, 2);
  const repair = ai.calls[1].messages[2].content;
  assert.match(repair, /\n- "talents" does not account for this talent the character has: Unsealed Wrath\./);
  assert.equal(out.data.summary, 'fixed');
  assert.deepEqual(out.data.talents.counted.map((t) => t.name), ['Unsealed Wrath', 'Benediction']);
  assert.equal(out.data.talents.missing, undefined);
  // The AI only gets the talents taken, which are the ones checked.
  assert.deepEqual(sent(ai.calls[0]).armory_talents.flatMap((t) => t.talents.map((x) => x.name)), TAKEN);
});

test('a second answer that still misses a talent is used anyway, with the talent under missing', async () => {
  const forgot = { summary: 'still', model: MODEL, talents: [ACCOUNTED[1], ACCOUNTED[2], { name: 'Unsealed Wrath', in: ['echo_storage'] }] };
  const ai = scripted(forgot);
  const out = await createArmory({ store: tmpStore(), askImpl: ai.askImpl }).handle(request(), { cfg });
  assert.equal(ai.calls.length, 2, 'one correction round, no more');
  assert.match(ai.calls[1].messages[2].content, /"Unsealed Wrath" is in "echo_storage", which the model has no ability, buff or proc for/);
  assert.deepEqual(out.data.talents.missing, ['Unsealed Wrath']);
  assert.ok(out.data.rotations.length >= 2, 'the result is built all the same');
  // Fully accounted: one request.
  const fine = scripted({ summary: 's', model: MODEL, talents: ACCOUNTED });
  await createArmory({ store: tmpStore(), askImpl: fine.askImpl }).handle(request(), { cfg });
  assert.equal(fine.calls.length, 1);
  // No talents in the request: nothing to account for, and nothing said.
  const bare = scripted({ summary: 's', model: MODEL });
  const plain = await createArmory({ store: tmpStore(), askImpl: bare.askImpl }).handle(request({ armory_talents: undefined }), { cfg });
  assert.equal(bare.calls.length, 1);
  assert.equal(plain.data.talents, undefined);
});

test('the buffs seen go to the AI with what the game says about them, bounded', async () => {
  const many = Array.from({ length: 130 }, (_, i) => ({ name: `Buff ${i}`, id: 9000 + i, desc: 'word '.repeat(80), stacks: i % 4 }));
  const shaped = aurasForPrompt([...AURAS, { id: 5 }, ...many]);
  assert.equal(shaped.length, 120);
  assert.deepEqual(shaped[0], AURAS[0]);
  assert.ok(shaped.every((a) => !a.desc || a.desc.length <= 200));
  assert.equal(shaped[3].stacks, 1);
  assert.equal('stacks' in shaped[2], false, 'no stacks seen: no key');
  assert.equal(aurasForPrompt([]), null);
  const ai = scripted({ summary: 's', model: MODEL, talents: ACCOUNTED });
  await createArmory({ store: tmpStore(), askImpl: ai.askImpl }).handle(request({ armory_auras: [...AURAS, ...many] }), { cfg });
  const auras = sent(ai.calls[0]).armory_auras;
  assert.equal(auras.length, 120);
  assert.deepEqual(auras.slice(0, 2), AURAS);
});

test('the owner\'s case: Unsealed Wrath counted in its Echo of Command buff, checked by One Button under the aura\'s id', async () => {
  const ai = scripted({ summary: 'Swap seals at 3 echoes.', model: MODEL, talents: ACCOUNTED });
  const out = await createArmory({ store: tmpStore(), askImpl: ai.askImpl }).handle(request(), { cfg });
  assert.equal(ai.calls.length, 1);
  assert.deepEqual(out.data.talents, {
    counted: [
      { name: 'Unsealed Wrath', how: 'stored seals as Echo of Command, spent by the swap' },
      { name: 'Benediction', how: 'seals cost 15% less mana' },
    ],
    left: [{ name: 'Toughness', why: 'armor: defense, not damage' }],
  });
  // The aura reached the AI with what it is and how many stacks were seen.
  assert.deepEqual(sent(ai.calls[0]).armory_auras[0], { name: 'Echo of Command', id: 1311703, desc: 'A stored copy of Seal of Command.', stacks: 3 });
  // The short list (goal leveling) checks 3 stacks of the buff by the game's own id.
  const ob = out.data.oneButton;
  assert.equal(ob.source, 'ai');
  assert.deepEqual(ob.list[0], { id: 20293, name: 'Seal of Righteousness', gates: [{ t: 'stack', id: 1311703, op: '>=', n: 3 }] });
});

test('test mode accounts for the talents it is given', async () => {
  const echo = { ...cfg, provider: 'echo' };
  const out = await createArmory({ store: tmpStore(), askImpl: async () => { throw new Error('no AI'); } }).handle(request(), { cfg: echo });
  assert.deepEqual(out.data.talents.left.map((t) => t.name), TAKEN);
  assert.equal(out.data.talents.missing, undefined);
  assert.equal(out.data.talents.counted, undefined);
});
