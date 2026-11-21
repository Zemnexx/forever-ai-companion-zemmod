// Companion side: install into a fake WoW folder, process a screenshot
// request with the "echo" provider, and check what the addon would load.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig, wowPaths } from '../src/config.js';
import { install } from '../src/install.js';
import { handleRequest, readRequest } from '../src/watcher.js';
import { cleanAnswer, buildSystem, buildMessages, flattenPrompt, wantsRecipes, wantsQuestDetail, promptContext, DONE_SHOWN } from '../src/prompt.js';
import { anthropicWebTools, canSearch } from '../src/providers.js';
import { claudeCodeArgs } from '../src/providers.js';
import { applyPreset } from '../src/config.js';
import { luaString as toLuaString } from '../src/inbox.js';
import { encodePNG, renderGrid, runLua } from './helpers.js';

function tempWow() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'faic-wow-'));
  fs.mkdirSync(path.join(dir, 'Interface', 'AddOns'), { recursive: true });
  return dir;
}

test('install creates addon, slots and empty signal files', () => {
  const cfg = { ...loadConfig(path.join(os.tmpdir(), 'no-config.json')), wowDir: tempWow(), slots: 3, signals: 5 };
  const p = install(cfg, { log: () => {}, resetState: false });
  assert.ok(fs.existsSync(path.join(p.addonDir, 'ForeverAICompanion.toc')));
  assert.equal(fs.statSync(p.signal(1)).size, 0);
  assert.ok(fs.statSync(p.okSignal).size > 44);
  const toc = fs.readFileSync(path.join(p.slotDir(3), 'ForeverAICompanion_S03.toc'), 'utf8');
  assert.match(toc, /## LoadOnDemand: 1/);
  assert.match(toc, /## Interface: 16001/);
});

test('screenshot request -> answer in every slot + signal rung', async () => {
  const cfg = { ...loadConfig(path.join(os.tmpdir(), 'no-config.json')), wowDir: tempWow(), slots: 3, signals: 5, provider: 'echo' };
  const p = install(cfg, { log: () => {}, resetState: false });

  // The addon builds the request (real Lua) and "takes the screenshot".
  const out = runLua(`
    local json = ns.Json.Encode({ v = 1, id = "abc123", sig = 2, lang = "es", question = "¿Dónde estoy?",
      context = { character = { name = "Thoradin", class = "Paladín", level = 24, race = "Enano" },
                  position = { zone = "Montañas de Alterac", x = 38.2, y = 46.7 } } })
    local W, H, cells = ns.Uplink.BuildGrid(ns.Uplink.Frame(json), 240)
    RESULT = W .. "," .. H .. "," .. table.concat(cells, ",")`);
  const [W, H, ...cells] = out.split(',').map(Number);
  const shot = path.join(p.screenshots, 'WoWScrnShot_111226_211500.png');
  fs.writeFileSync(shot, encodePNG(renderGrid(W, H, cells, { pitch: 6.2, noise: 5 })));

  const req = readRequest(shot);
  assert.equal(req.question, '¿Dónde estoy?');

  const state = { nextSig: 1, answers: [], processed: [] };
  const answer = await handleRequest(req, { cfg, paths: wowPaths(cfg.wowDir), state, system: buildSystem(''), save: () => {} });
  assert.ok(answer.ok);
  // The request came from a Spanish game client: the app answers in Spanish.
  assert.match(answer.answer, /Thoradin, Enano Paladín nivel 24/);
  assert.match(answer.answer, /Prueba de conexión OK/);

  // The addon asked for signal 2, so that one must now be playable.
  assert.equal(fs.statSync(p.signal(1)).size, 0);
  assert.ok(fs.statSync(p.signal(2)).size > 44);
  assert.equal(state.nextSig, 3);

  // Same request again (e.g. duplicate screenshot) is ignored.
  assert.equal(await handleRequest(req, { cfg, paths: wowPaths(cfg.wowDir), state, system: '', save: () => {} }), null);

  // What LoadAddOn would execute: Inbox.lua must be valid Lua with the answer.
  const inbox = fs.readFileSync(path.join(p.slotDir(2), 'Inbox.lua'), 'utf8');
  const result = runLua(`
    local chunk = assert(load(INBOX))
    chunk()
    local a = ForeverAICompanion_Inbox.answers[1]
    RESULT = a.id .. "|" .. tostring(a.ok) .. "|" .. a.answer`, { INBOX: inbox }, []);
  const [id, ok, text] = result.split('|');
  assert.equal(id, 'abc123');
  assert.equal(ok, 'true');
  assert.equal(text, answer.answer);
});

test('inbox escaping survives quotes, backslashes, newlines and accents', () => {
  const tricky = 'Dijo "hola" \\ y luego\nnueva línea ]] [[ --[[ ñandú\ttab';
  const out = runLua(`
    local chunk = assert(load(INBOX))
    chunk()
    RESULT = ForeverAICompanion_Inbox.answers[1].answer`,
  { INBOX: `ForeverAICompanion_Inbox = { answers = { { answer = ${toLuaString(tricky)} } } }` }, []);
  assert.equal(out, tricky);
});

test('cleanAnswer strips markdown and emoji for the WoW font', () => {
  const raw = '## Ruta\n**Minas de la Muerte** 🗡️ es tu mejor opción.\n* Ve a `Páramos de Poniente (42, 72)`\n\n\n\nSuerte';
  assert.equal(cleanAnswer(raw), 'Ruta\nMinas de la Muerte  es tu mejor opción.\n- Ve a Páramos de Poniente (42, 72)\n\nSuerte');
});

test('subscription mode runs Claude Code as a plain chat model', () => {
  const args = claudeCodeArgs({ model: 'sonnet', effort: 'low' }, 'C:\\tmp\\sys.txt', false);
  const at = (flag) => args[args.indexOf(flag) + 1];
  assert.equal(at('--system-prompt-file'), 'C:\\tmp\\sys.txt');
  assert.ok(args.includes('--no-session-persistence'), 'nothing saved in ~/.claude/projects');
  assert.equal(at('--tools'), '', 'no tools');
  assert.equal(at('--setting-sources'), '', 'no user settings or CLAUDE.md');
  assert.ok(args.includes('--strict-mcp-config'));
  assert.equal(at('--model'), 'sonnet');
  assert.equal(at('--effort'), 'low');
  // Through cmd.exe (claude.cmd) the empty values must be quoted to survive.
  const viaShell = claudeCodeArgs({ model: 'default' }, 'x', true);
  assert.equal(viaShell[viaShell.indexOf('--tools') + 1], '""');
  assert.ok(!viaShell.includes('--model'), '"default" leaves the plan default');
  // The prompt sent on stdin no longer repeats the system prompt.
  assert.ok(!flattenPrompt(null, [{ role: 'user', content: 'hola' }]).startsWith('null'));
  // The model picked in the window reaches the provider.
  const cfg = applyPreset({ preset: 'claude-code', models: { 'claude-code': 'haiku' }, claudeCode: { bin: 'claude' } });
  assert.equal(cfg.provider, 'claude-code');
  assert.equal(cfg.claudeCode.model, 'haiku');
});
test('each assistant has its own personality over the same rules', () => {
  const fizzi = buildSystem('', 'fizzi');
  const rizzik = buildSystem('', 'rizzik');
  assert.match(fizzi, /Fizzi Sparkwrench/, 'English names by default');
  assert.match(rizzik, /Rizzik Fastfuse/);
  assert.ok(!rizzik.includes('Fizzi'), 'no mixing of personalities');
  for (const s of [fizzi, rizzik]) assert.match(s, /Answer format/);
  assert.match(buildSystem('', undefined), /Fizzi/, 'old addons without the field get Fizzi');
  assert.match(buildSystem('', '<script>'), /Fizzi/, 'unknown names are ignored');
  assert.match(buildSystem('Server fact', 'rizzik'), /Server knowledge[\s\S]*Server fact/);
  // Spanish players: Spanish names, and the AI is told the client is in Spanish.
  const es = buildSystem('', 'fizzi', { lang: 'es' });
  assert.match(es, /Fizzi Chispatuerca/);
  assert.match(es, /client is in Spanish/);
  assert.match(buildSystem('', 'rizzik', { client: { locale: 'esMX' } }), /Rizzik Bujíaveloz/, 'old addons: from the client locale');
  assert.match(fizzi, /client is in English/);
});
test('the AI sticks to the question, and adds a reminder only past clear thresholds', () => {
  const s = buildSystem('', 'fizzi');
  assert.match(s, /using the parts of their data that matter to the question\. Don't comment on the rest/);
  const at = s.indexOf('7. Reminders:');
  assert.ok(at > 0, 'the reminders rule is there');
  const end = s.indexOf('\n## ', at);
  const rule = s.slice(at, end > 0 ? end : undefined);
  for (const re of [
    /one short reminder \(two at most\)/,
    /don't repeat a reminder already given in the chat history/,
    /"lowestDurabilityPct" 20% or less, or 40% or less before a dungeon/,
    /"bags\.freeSlots" 2 or less, or 4 or less before a dungeon/,
    /leaving crafting materials/,
    /"notLearned" at their level or below/,
    /25 or more points under its cap/,
    /"ammo\.equipped" under 200/,
    /\("hardcore": true\), a real danger to its life goes first/,
  ]) assert.match(rule, re);
  assert.match(s, /A reminder \(rule 7 above\) fits inside that limit, on its own last line, and is the first thing to cut/);
  // Abilities missing from the bars: never a reminder, only when the player asks.
  assert.doesNotMatch(rule, /spellsNotOnBars/);
  assert.match(s, /spellsNotOnBars: [^\n]*and so do auras, stances and forms on the stance bar[^\n]*use this when the player asks about their bars, keybinds, rotation or an ability they can't find[^\n]*Don't bring it up otherwise\./);
});
test('flights: the AI flies the player only between flight points they know', () => {
  const s = buildSystem('', 'fizzi');
  assert.match(s, /- flightPaths: per continent[^\n]*"known" = the flight points they can fly to; "notKnown" = [^\n]*can't fly to yet[^\n]*"notChecked"/);
  assert.match(s, /Flying: only between flight points in "flightPaths\.known"\. Never send them by air to one in "notKnown"/);
  assert.match(s, /fly only between flight points they know, rule 2/);
  assert.doesNotMatch(s, /knownFlightPaths/);
});
test('quests: new ones only from the available list, never one already done', () => {
  const s = buildSystem('', 'fizzi');
  assert.match(s, /"next" \(the quest that follows it in its chain\)/);
  assert.match(s, /- completedQuests: "total" = quests this character has completed; "inZone" = the ones done in their current zone \("zone"\); "more" = how many others are done there/);
  assert.match(s, /- availableQuests: quests they can pick up now: right level \(not grey or red\), race and class, prerequisites done, not done and not in the log, and no reputation to earn with a faction they are Hostile or Hated with\. Per zone, their current zone first \("none": nothing left to pick up there\), then the nearest zones the quests in their log come from or send them to[^\n]*availableQuestsAsked: the same for a zone named in the question/);
  assert.match(s, /New quests to pick up: when "availableQuests" or "availableQuestsAsked" is there, only from it[^\n]*Never one in "completedQuests" or "recentlyCompletedQuests"\. A quest in none of these lists is already done or not available yet/);
});
test('recipes go to the AI only with crafting questions; skill levels always', () => {
  const knownRecipes = [{ profession: 'Mining', recipes: [{ name: 'Smelt Iron', reagents: '1x Iron Ore' }, { name: 'Lodestone' }] }];
  const professions = [{ name: 'Mining', rank: 206, max: 300 }];
  const sent = (question, extra = {}) => {
    const content = buildMessages({ question, context: { professions, knownRecipes, ...extra.context }, history: extra.history }).at(-1).content;
    return { recipes: content.includes('"knownRecipes"'), skills: content.includes('"professions"') };
  };
  assert.deepEqual(sent('What should I do next?'), { recipes: false, skills: true });
  assert.deepEqual(sent('how do I make money'), { recipes: false, skills: true });
  for (const q of ['What can I craft?', 'Should I level mining?', 'What do I do with my iron ore?', 'Is Smelt Iron still worth it?',
    '¿Qué recetas tengo?', '¿Qué puedo fabricar?', 'How do I cook this?']) {
    assert.equal(sent(q).recipes, true, q);
  }
  // A follow-up to a crafting question, and a trainer's window open.
  assert.equal(sent('And how many?', { history: [{ q: 'What can I craft?', a: 'Iron bars.' }] }).recipes, true);
  assert.equal(sent('What should I learn?', { context: { screen: { trainer: { services: [] } } } }).recipes, true);
  assert.equal(wantsRecipes({ question: 'What can I craft?', context: {} }), false, 'nothing saved: nothing to send');
  // Grey recipes go as a list of names.
  const sentRecipes = JSON.parse(buildMessages({ question: 'What can I craft?', context: { knownRecipes: [{
    profession: 'Mining', rank: 211, recipes: [{ name: 'Smelt Steel', difficulty: 'yellow', reagents: '1x Iron Bar, 1x Coal' },
      { name: 'Smelt Iron', difficulty: 'grey' }, { name: 'Smelt Tin', difficulty: 'grey' }] }] } })
    .at(-1).content.match(/JSON\):\n(.*)\n\nQuestion/s)[1]).knownRecipes;
  assert.deepEqual(sentRecipes, [{ profession: 'Mining', rank: 211,
    recipes: [{ name: 'Smelt Steel', difficulty: 'yellow', reagents: '1x Iron Bar, 1x Coal' }], greyRecipes: ['Smelt Iron', 'Smelt Tin'] }]);
  const s = buildSystem('', 'fizzi');
  assert.match(s, /- knownRecipes: [^\n]*It only comes with questions about crafting[^\n]*ask them to open it once and ask again\./);
});
test('completed quests: 40 and how many more, all of them for questions about quests', () => {
  const names = Array.from({ length: 60 }, (_, i) => `Quest Number ${String(i).padStart(2, '0')}`);
  const context = {
    completedQuests: { total: 300, zone: 'Ashenvale', inZone: names, more: 5 },
    availableQuestsAsked: [{ zone: 'Desolace', quests: [], done: names, doneMore: 2 }, { zone: 'Orgrimmar', none: true }],
  };
  const cut = promptContext({ question: 'What gear should I buy?', context });
  assert.equal(DONE_SHOWN, 40);
  assert.deepEqual(cut.completedQuests, { total: 300, zone: 'Ashenvale', inZone: names.slice(0, 40), more: 25 });
  assert.deepEqual(cut.availableQuestsAsked, [
    { zone: 'Desolace', quests: [], done: names.slice(0, 40), doneMore: 22 }, { zone: 'Orgrimmar', none: true }]);
  assert.equal(context.completedQuests.inZone.length, 60, 'the saved context is not changed');
  // About quests: every one the addon sent.
  for (const q of ['Did I do the Gelkis quests?', 'Have I done everything here?', 'What should I turn in?', 'Is this a chain?',
    '¿Qué misiones me quedan?', '¿Ya hice todo aquí?', 'Should I do Quest Number 55 again?']) {
    assert.equal(wantsQuestDetail({ question: q, context }), true, q);
    assert.deepEqual(promptContext({ question: q, context }), context, q);
  }
  // A follow-up, and quests the addon found named in the question.
  assert.equal(wantsQuestDetail({ question: 'And there?', history: [{ q: 'Which quests did I finish?', a: '...' }], context }), true);
  assert.equal(wantsQuestDetail({ question: 'Hmm?', context: { ...context, questsAsked: [{ id: 1, status: 'done' }] } }), true);
  assert.equal(wantsQuestDetail({ question: 'What should I do next?', context }), false);
  // Short lists are left as they are.
  const short = { completedQuests: { total: 3, zone: 'Ashenvale', inZone: ['A', 'B'] } };
  assert.equal(promptContext({ question: 'Hi', context: short }), short);
  const s = buildSystem('', 'fizzi');
  assert.match(s, /- questsAsked: quests named or linked in the question[^\n]*"status" "done"; "inLog"; "available"[^\n]*"notYet" with "why"/);
  assert.match(s, /availableQuestsAsked: the same for a zone named in the question, with "done" = the quests done there/);
  assert.match(s, /A quest in "questsAsked": answer with its "status"/);
});
test('the AI knows WoW Forever and searches only when it can', () => {
  const withSearch = buildSystem('', 'fizzi', { canSearch: true });
  const without = buildSystem('', 'fizzi', { canSearch: false });
  assert.match(withSearch, /November 4, 2026/, 'explains Forever is newer than the model');
  assert.match(withSearch, /The Drowned City/, 'built-in Forever guide is included');
  assert.match(withSearch, /## Searching the internet/);
  assert.match(without, /You cannot search the internet/);
  assert.match(withSearch, /Never include links/);

  // Which providers search, and with what.
  assert.equal(canSearch({ provider: 'claude-code' }), true);
  assert.equal(canSearch({ provider: 'anthropic', webSearch: false }), false);
  assert.equal(canSearch({ provider: 'openai' }), false);
  assert.deepEqual(anthropicWebTools('claude-opus-5-5').map((t) => t.type), ['web_search_20260209', 'web_fetch_20260209']);
  assert.deepEqual(anthropicWebTools('claude-haiku-5-5').map((t) => t.type), ['web_search_20250305']);

  // Subscription: only web tools, allowed without asking.
  const args = claudeCodeArgs({ model: 'sonnet' }, 'x', false, { webSearch: true });
  assert.equal(args[args.indexOf('--tools') + 1], 'WebSearch,WebFetch');
  assert.equal(args[args.indexOf('--allowedTools') + 1], 'WebSearch,WebFetch');
});

test('answers never carry links or source lists (the game cannot open them)', () => {
  const raw = 'La entrada está en Tuercespina (21, 28), según [Warcraft Tavern](https://www.warcrafttavern.com/forever/guides/x/).\n\nFuentes:\n- [Guía](https://example.com)';
  const out = cleanAnswer(raw);
  assert.equal(out, 'La entrada está en Tuercespina (21, 28), según Warcraft Tavern.');
  assert.equal(cleanAnswer('Mira https://wowhead.com/quest=70 para más.'), 'Mira  para más.'.replace('  ', ' '));
});