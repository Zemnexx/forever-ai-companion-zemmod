// Item ids for gear plans (src/armory/item-ids.js): Wowhead's tooltip check,
// and the lookup by the AI with one retry, with stand-ins for both. No test
// here touches the network.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkItem, checkItems, fillIds, namesToLookUp, sameName } from '../src/armory/item-ids.js';
import { buildIdLookupMessage, buildIdLookupSystem } from '../src/armory/prompts.js';
import { createArmory, lookupConfig } from '../src/armory/index.js';
import { openArmoryStore } from '../src/armory/store.js';
import { DEFAULTS } from '../src/config.js';

// A Wowhead stand-in: items by id; anything else is a 404. `down`: ids that
// get no answer (a network error) the first `times` times they are asked.
function wowhead(items = {}, { down = {}, status = {} } = {}) {
  const calls = [];
  const fetchImpl = async (url, opts) => {
    const id = Number(String(url).split('/').pop());
    calls.push({ url: String(url), opts, id });
    if (down[id] > 0) { down[id]--; throw new TypeError('fetch failed'); }
    if (status[id]) return new Response('<html>busy</html>', { status: status[id] });
    if (items[id]) return new Response(JSON.stringify({ name: items[id], quality: 3, tooltip: '<table></table>' }), { status: 200 });
    return new Response(JSON.stringify({ error: 'ID is out of range' }), { status: 404 });
  };
  return { fetchImpl, calls };
}

const pick = (name, extra = {}) => ({ name, why: '', source: { type: 'world' }, confidence: 'low', ...extra });
const plan = (...slots) => ({ v: 1, kind: 'gear', summary: 's', slots: slots.map(([slot, ...picks]) => ({ slot, picks })) });
const lookups = (...replies) => {
  const calls = [];
  const lookup = async (system, messages) => {
    calls.push({ system, messages });
    const r = replies[calls.length - 1];
    if (r instanceof Error) throw r;
    return typeof r === 'string' ? r : JSON.stringify(r ?? { ids: {} });
  };
  return { lookup, calls };
};
const quiet = () => {};

test('checkItem: found, missing, a timeout tried again, and no answer after the retry', async () => {
  const site = wowhead({ 7717: 'Ravager' });
  assert.deepEqual(await checkItem(7717, { fetchImpl: site.fetchImpl }), { status: 'found', name: 'Ravager' });
  assert.equal(site.calls[0].url, 'https://nether.wowhead.com/forever/tooltip/item/7717');
  assert.match(site.calls[0].opts.headers['user-agent'], /^Mozilla\/5\.0 \(compatible; [\w-]+\)$/);
  assert.ok(site.calls[0].opts.signal instanceof AbortSignal);
  assert.deepEqual(await checkItem(99999999, { fetchImpl: site.fetchImpl }), { status: 'missing' });
  assert.equal(site.calls.length, 2, 'a 404 is an answer, not tried again');

  // The first request times out, the second one answers.
  let n = 0;
  const slow = async (url, { signal }) => {
    n++;
    if (n === 1) {
      // The timeout's own timer does not keep the test alive: this one does.
      const hold = setTimeout(() => {}, 1000);
      return new Promise((_, reject) => signal.addEventListener('abort', () => { clearTimeout(hold); reject(signal.reason); }));
    }
    return new Response(JSON.stringify({ name: 'Ravager' }), { status: 200 });
  };
  assert.deepEqual(await checkItem(7717, { fetchImpl: slow, timeoutMs: 20 }), { status: 'found', name: 'Ravager' });
  assert.equal(n, 2);

  // Never an answer: exactly two requests, then "unreachable".
  const dead = wowhead({ 7717: 'Ravager' }, { down: { 7717: 5 } });
  assert.deepEqual(await checkItem(7717, { fetchImpl: dead.fetchImpl }), { status: 'unreachable' });
  assert.equal(dead.calls.length, 2);
  const busy = wowhead({}, { status: { 5: 503 } });
  assert.deepEqual(await checkItem(5, { fetchImpl: busy.fetchImpl }), { status: 'unreachable' });
  const garbled = async () => new Response('not json', { status: 200 });
  assert.deepEqual(await checkItem(5, { fetchImpl: garbled }), { status: 'unreachable' });
});

test('several ids are checked a few at a time, each once', async () => {
  let open = 0;
  let most = 0;
  const fetchImpl = async (url) => {
    open++;
    most = Math.max(most, open);
    await new Promise((r) => setTimeout(r, 5));
    open--;
    return new Response(JSON.stringify({ name: `Item ${String(url).split('/').pop()}` }), { status: 200 });
  };
  const ids = Array.from({ length: 20 }, (_, i) => i + 1);
  const out = await checkItems([...ids, 1, 2], { fetchImpl });
  assert.equal(out.size, 20);
  assert.equal(out.get(7).name, 'Item 7');
  assert.ok(most <= 6, `at most 6 at a time (saw ${most})`);
});

test('names match whatever the case, accents and punctuation', () => {
  assert.ok(sameName("X'caliboar", 'Xcaliboar'));
  assert.ok(sameName('Blade of the Titans', 'blade  of the titans'));
  assert.ok(sameName('Ironfoe', 'IRONFOE.'));
  assert.ok(sameName('Hand-of-Edward', 'Hand of Edward'));
  assert.ok(!sameName('Ravager', 'Ravager Axe'));
  assert.ok(!sameName('', ''));
});

test('names to look up: the first pick of each slot first, each name once, at most 12', () => {
  const slots = plan(
    ['head', pick('Helm A'), pick('Helm B')],
    ['chest', pick('Chest A', { itemId: 3 }), pick('Chest B')],
    ['legs', pick('helm a'), pick('Legs B')],
  ).slots;
  assert.deepEqual(namesToLookUp(slots), ['Helm A', 'Helm B', 'Chest B', 'Legs B']);
  const many = Array.from({ length: 20 }, (_, i) => [`s${i}`, pick(`Item ${i}`)]);
  assert.equal(namesToLookUp(plan(...many).slots).length, 12);
});

test('the lookup prompt is small and asks only for ids', () => {
  const system = buildIdLookupSystem();
  assert.match(system, /wowhead forever/);
  assert.match(system, /item=7717\/ravager" is id 7717/);
  assert.match(system, /Never make a number up/);
  assert.match(system, /"ids"/);
  assert.ok(system.length < 3000);
  const msg = buildIdLookupMessage(['Ravager'], new Map([['Ravager', 12]]));
  assert.ok(msg.includes('["Ravager"]') && msg.includes('{"Ravager":12}'));
  assert.ok(!buildIdLookupMessage(['Ravager']).includes('Wrong'));
});

test('an id from the plan that Wowhead names another item is removed; no answer keeps it', async () => {
  const site = wowhead({ 7717: 'Ravager', 100: 'Some Other Thing' }, { down: { 200: 9 } });
  const p = plan(['mainHand', pick('Ravager', { itemId: 7717 })], ['head', pick('Lucky Hat', { itemId: 100 })],
    ['feet', pick('Boots', { itemId: 200 })], ['legs', pick('Pants', { itemId: 300 })]);
  const lines = [];
  const stats = await fillIds(p, { fetchImpl: site.fetchImpl, canLookUp: false, log: (l) => lines.push(l) });
  assert.equal(p.slots[0].picks[0].itemId, 7717);
  assert.equal(p.slots[1].picks[0].itemId, undefined, 'another item');
  assert.equal(p.slots[2].picks[0].itemId, 200, 'Wowhead did not answer: the game checks it');
  assert.equal(p.slots[3].picks[0].itemId, undefined, 'no such item');
  assert.deepEqual([stats.came, stats.confirmed, stats.dropped, stats.unchecked], [4, 1, 2, 1]);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /4 came with the plan \(1 confirmed, 2 dropped, 1 unchecked\); none looked up \(the AI cannot search the web\)/);
});

test('an id the game gave in the character data is kept without asking Wowhead', async () => {
  const site = wowhead({});
  const p = plan(['head', pick('Bag Helm', { itemId: 77 })]);
  await fillIds(p, { ctx: { inventory: [{ name: 'Bag Helm', itemId: 77 }] }, fetchImpl: site.fetchImpl, log: quiet });
  assert.equal(p.slots[0].picks[0].itemId, 77);
  assert.equal(site.calls.length, 0);
});

test('a lookup round finds some ids, and the retry finds the rest', async () => {
  const site = wowhead({ 1: 'Helm A', 2: 'Chest A', 3: 'Legs A' });
  const ai = lookups({ ids: { 'Helm A': 1 } }, { ids: { 'Chest A': 2, 'Legs A': 3 } });
  const p = plan(['head', pick('Helm A')], ['chest', pick('Chest A')], ['legs', pick('Legs A')]);
  const lines = [];
  const stats = await fillIds(p, { lookup: ai.lookup, canLookUp: true, fetchImpl: site.fetchImpl, log: (l) => lines.push(l) });
  assert.deepEqual(p.slots.map((s) => s.picks[0].itemId), [1, 2, 3]);
  assert.equal(ai.calls.length, 2);
  assert.ok(ai.calls[0].messages[0].content.includes('["Helm A","Chest A","Legs A"]'));
  assert.ok(ai.calls[1].messages[0].content.includes('["Chest A","Legs A"]'));
  assert.deepEqual([stats.asked, stats.found, stats.missing], [3, 3, 0]);
  assert.match(lines[0], /3 looked up, 3 found, 0 not found after the retry/);
});

test('a wrong id is rejected and asked again, and what is still missing is given up', async () => {
  const site = wowhead({ 5: 'Not The Helm', 6: 'Helm A' });
  // Round 1: a wrong id for the helm, a made-up one for the boots, nothing for the ring.
  const ai = lookups({ ids: { 'Helm A': 5, Boots: 999 } }, { ids: { 'Helm A': 6 } }, { ids: { Ring: 7 } });
  const p = plan(['head', pick('Helm A')], ['feet', pick('Boots')], ['finger1', pick('Ring')]);
  const stats = await fillIds(p, { lookup: ai.lookup, canLookUp: true, fetchImpl: site.fetchImpl, log: quiet });
  assert.equal(ai.calls.length, 2, 'one retry, no third round');
  const retry = ai.calls[1].messages[0].content;
  assert.ok(retry.includes('"Helm A":5') && retry.includes('"Boots":999'), 'told which ids were wrong');
  assert.deepEqual(p.slots.map((s) => s.picks[0].itemId), [6, undefined, undefined]);
  assert.deepEqual([stats.asked, stats.found, stats.missing], [3, 1, 2]);
});

test('an id that Wowhead could not check is accepted; the id a plan had wrong is named in round 1', async () => {
  const site = wowhead({ 50: 'Other' }, { down: { 8: 9 } });
  const ai = lookups({ ids: { Cloak: 8 } });
  const p = plan(['back', pick('Cloak', { itemId: 50 })]);
  await fillIds(p, { lookup: ai.lookup, canLookUp: true, fetchImpl: site.fetchImpl, log: quiet });
  assert.ok(ai.calls[0].messages[0].content.includes('{"Cloak":50}'));
  assert.equal(p.slots[0].picks[0].itemId, 8);
});

test('a lookup that fails, and a Wowhead that is down, never fail the plan', async () => {
  const ai = lookups(new Error('timed out'), 'no json here');
  const p = plan(['head', pick('Helm A')]);
  const lines = [];
  const broken = () => { throw new Error('boom'); };
  await fillIds(p, { lookup: ai.lookup, canLookUp: true, fetchImpl: broken, log: (l) => lines.push(l) });
  assert.equal(ai.calls.length, 2);
  assert.equal(p.slots[0].picks[0].itemId, undefined);
  assert.ok(lines.some((l) => /lookup failed: timed out/.test(l)));
  assert.match(lines.at(-1), /1 looked up, 0 found, 1 not found after the retry/);
});

test('the time budget: no lookup after 12 minutes, no retry after 15', async () => {
  const site = wowhead({});
  const late = lookups();
  const p = plan(['head', pick('Helm A')]);
  const stats = await fillIds(p, { lookup: late.lookup, canLookUp: true, fetchImpl: site.fetchImpl, elapsed: () => 12 * 60000 + 1, log: quiet });
  assert.equal(late.calls.length, 0);
  assert.equal(stats.skipped, 'no time left');

  let t = 11 * 60000;
  const slow = lookups();
  const lookup = async (...args) => { t = 15 * 60000 + 1; return slow.lookup(...args); };
  const again = await fillIds(plan(['head', pick('Helm A')]), { lookup, canLookUp: true, fetchImpl: site.fetchImpl, elapsed: () => t, log: quiet });
  assert.equal(slow.calls.length, 1, 'round 1 only');
  assert.equal(again.skipped, 'no time left for the retry');
  assert.equal(again.missing, 1);
});

test('a player whose names are not in English: only an id that does not exist is dropped', async () => {
  const site = wowhead({ 7717: 'Ravager' });
  const p = plan(['mainHand', pick('Devastador', { itemId: 7717 })], ['head', pick('Casco', { itemId: 4 })]);
  await fillIds(p, { fetchImpl: site.fetchImpl, english: false, log: quiet });
  assert.equal(p.slots[0].picks[0].itemId, 7717);
  assert.equal(p.slots[1].picks[0].itemId, undefined);
});

// Through the plugin, as the app runs it.
const tmpStore = () => openArmoryStore(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'faic-armory-ids-')), 'armory.json'));
const cfg = { ...DEFAULTS, provider: 'anthropic', armory: { ...DEFAULTS.armory, iterations: 60 } };
const gearRequest = () => ({
  id: '17000000001234', question: 'armory: gear', charKey: 'Player-1-ABC', lang: 'en',
  ext: { name: 'armory', kind: 'gear', input: { spec: 'Arms', goal: 'raids', role: 'dps' } },
  context: { character: { name: 'Thora', class: 'Warrior', classToken: 'WARRIOR', level: 14 }, gear: [{ slot: 'mainHand', name: 'Old Axe', itemId: 1 }] },
});
const GEAR = { summary: 'Plan.', weights: { STRENGTH: 2 }, slots: [
  { slot: 'head', picks: [{ name: 'Helm A', source: { type: 'dungeon' } }] },
  { slot: 'mainHand', picks: [{ name: 'Ravager', itemId: 7717, source: { type: 'dungeon' } }] },
] };
const scripted = (...replies) => {
  const calls = [];
  const askImpl = async (aiCfg, system, messages) => {
    calls.push({ cfg: aiCfg, system, messages });
    const r = replies[calls.length - 1] ?? { ids: {} };
    return { text: JSON.stringify(r), model: calls.length === 1 ? 'main-model' : 'other', usage: { input: 100, cached: 10, output: 20 } };
  };
  return { askImpl, calls };
};

test('a gear plan: ids checked, the missing one looked up cheaply, and its tokens counted', async () => {
  const site = wowhead({ 7717: 'Ravager', 42: 'Helm A' });
  const ai = scripted(GEAR, { ids: { 'Helm A': 42 } });
  const lines = [];
  const out = await createArmory({ store: tmpStore(), askImpl: ai.askImpl, fetchImpl: site.fetchImpl }).handle(gearRequest(), { cfg, log: (l) => lines.push(l) });
  assert.equal(ai.calls.length, 2);
  assert.deepEqual(out.data.slots.map((s) => s.picks[0].itemId), [42, 7717]);
  assert.deepEqual(out.usage, { input: 200, cached: 20, output: 40 });
  assert.equal(out.model, 'main-model');
  // The lookup: its own short prompt, only the names, the lowest effort and little patience.
  const look = ai.calls[1];
  assert.equal(look.system, buildIdLookupSystem());
  assert.equal(look.messages.length, 1);
  assert.ok(!look.messages[0].content.includes('Thora'));
  assert.equal(look.cfg.anthropic.effort, 'low');
  assert.equal(look.cfg.timeoutMs, 120000);
  assert.equal(ai.calls[0].cfg.anthropic.effort, 'high');
  assert.ok(lines.some((l) => /^Item ids: 1 came with the plan \(1 confirmed/.test(l)));
  // The main prompt no longer spends searches on ids.
  assert.match(ai.calls[0].system, /the app looks up the ids that are missing/);
  assert.ok(!ai.calls[0].system.includes('at most 5 such searches'));
});

test('a gear plan whose id lookup throws is still answered', async () => {
  const site = wowhead({ 7717: 'Ravager' });
  let n = 0;
  const askImpl = async () => {
    n++;
    if (n > 1) throw new Error('lookup timed out');
    return { text: JSON.stringify(GEAR), model: 'm', usage: { input: 1, cached: 0, output: 1 } };
  };
  const out = await createArmory({ store: tmpStore(), askImpl, fetchImpl: site.fetchImpl }).handle(gearRequest(), { cfg });
  assert.equal(n, 3, 'the plan, round 1 and the retry');
  assert.equal(out.data.slots[0].picks[0].itemId, undefined);
  assert.equal(out.data.slots[1].picks[0].itemId, 7717);
});

test('no lookup when the AI cannot search the web', async () => {
  const site = wowhead({ 7717: 'Ravager' });
  for (const c of [{ ...cfg, webSearch: false }, { ...cfg, provider: 'openai' }]) {
    const ai = scripted(GEAR);
    const out = await createArmory({ store: tmpStore(), askImpl: ai.askImpl, fetchImpl: site.fetchImpl }).handle(gearRequest(), { cfg: c });
    assert.equal(ai.calls.length, 1);
    assert.equal(out.data.slots[1].picks[0].itemId, 7717);
  }
});

test('the request\'s clock decides whether a lookup still fits', async () => {
  const site = wowhead({ 7717: 'Ravager' });
  let clock = 0;
  const askImpl = async (aiCfg, system, messages) => {
    clock += 13 * 60000; // the plan took 13 minutes
    return { text: JSON.stringify(GEAR), model: 'm', usage: null };
  };
  let asked = 0;
  const counted = async (...a) => { asked++; return askImpl(...a); };
  await createArmory({ store: tmpStore(), askImpl: counted, fetchImpl: site.fetchImpl, now: () => clock }).handle(gearRequest(), { cfg });
  assert.equal(asked, 1);
});

test('the lookup config: the lowest effort, a small answer, two minutes', () => {
  const c = lookupConfig({ ...DEFAULTS, provider: 'claude-code', armory: { effort: 'high', models: { 'claude-code': 'opus' } } });
  assert.equal(c.claudeCode.effort, 'low');
  assert.equal(c.claudeCode.model, 'opus', 'the Armory\'s model');
  assert.equal(c.codex.effort, 'low');
  assert.equal(c.anthropic.maxTokens, 4000);
  assert.equal(c.timeoutMs, 120000);
});

test('test mode makes no request and no lookup', async () => {
  const site = wowhead({ 7717: 'Ravager' });
  const never = async () => { throw new Error('the AI must not be asked'); };
  const out = await createArmory({ store: tmpStore(), askImpl: never, fetchImpl: site.fetchImpl }).handle(gearRequest(), { cfg: { ...cfg, provider: 'echo' } });
  assert.equal(out.model, 'echo');
  assert.equal(site.calls.length, 0);
});
