// The Armory plugin: the app's side of the Forever AI Companion Armory addon
// (character builds: talents, gear, rotation, interactions). The addon sends
// typed requests through the main addon (Plugins.lua there, plugins.js here)
// with the character's talents, spells and gear as read from the game; each
// kind of request is answered with data the addon shows in its own window.
//
//   talents   the AI proposes a build order; talents.js replays it under the
//             game's rules so only legal points reach the player.
//   gear      the AI researches upgrades and where they come from; item-ids.js
//             checks their ids with Wowhead and looks up missing ones, and
//             the addon checks every id against the game.
//   rotation  the AI writes a combat model; sim/engine.js simulates the
//             candidate rotations and measures stat weights. What the addon
//             measured of how abilities scale (scaling.js) goes to the AI,
//             and the model is compared with it afterwards.
//   discover  the AI looks for strong interactions; ideas with a model patch
//             are measured against the stored baseline.
//
// The AI is the one chosen in the app (same provider, model and keys as the
// chat), asked with more effort and a longer timeout (config "armory").
import { ask, canSearch } from '../providers.js';
import { err, t } from '../i18n.js';
import { playerLang } from '../prompt.js';
import { buildArmoryMessage, buildArmorySystem, repairMessage } from './prompts.js';
import { extractJson, list, num, str } from './json.js';
import { shapeBuild, takenTalents, talentIndex, validateOrder } from './talents.js';
import { equippable, leftOut, shapeGear } from './gear.js';
import { baselineOf, fitRotation, keepFromRun, oneButtonLists, runModel, shapeRotation } from './rotation.js';
import { shapeIdeas } from './discover.js';
import { fillIds } from './item-ids.js';
import { compareScaling, shapeScaling } from './scaling.js';
import { openArmoryStore } from './store.js';
import { sampleResult } from './sample.js';

export const KINDS = ['talents', 'gear', 'rotation', 'discover'];
const PET_CLASSES = ['HUNTER', 'WARLOCK'];
const MAX_DATA_BYTES = 60000; // what one answer may weigh in the game's mailbox

// How thorough an analysis is asked to be (the app's window offers these).
export const ARMORY_EFFORTS = ['low', 'medium', 'high'];

// The model chosen for the Armory with the current AI option, or null for
// the chat's own model.
export function armoryModel(cfg) {
  const model = cfg.armory?.models?.[cfg.preset || cfg.provider];
  return typeof model === 'string' && model.trim() ? model.trim() : null;
}

// The change to the saved settings for what the app's window sent: how
// thorough, and the model for the current AI option (empty = the chat's).
// Kept per AI option, so changing the AI never leaves a model it doesn't have.
export function armoryPatch(cfg, { effort, model } = {}) {
  const patch = {};
  if (effort !== undefined) {
    if (!ARMORY_EFFORTS.includes(effort)) throw err('unknownOption');
    patch.effort = effort;
  }
  if (model !== undefined) {
    const name = String(model ?? '').trim();
    if (name && !/^[\w.:/-]{1,80}$/.test(name)) throw err('unknownOption');
    patch.models = { [cfg.preset || cfg.provider]: name || null };
  }
  return { armory: patch };
}

// The chosen AI with the Armory's own effort, model, answer size and patience.
export function armoryConfig(cfg) {
  const a = cfg.armory || {};
  const effort = a.effort || 'high';
  const model = armoryModel(cfg);
  const withModel = (section) => (model ? { ...section, model } : section);
  return {
    ...cfg,
    timeoutMs: a.timeoutMs || 600000,
    anthropic: { ...withModel(cfg.anthropic), effort, maxTokens: a.maxTokens || 16000 },
    claudeCode: { ...withModel(cfg.claudeCode), effort },
    codex: { ...withModel(cfg.codex), effort },
    openai: withModel(cfg.openai),
  };
}

// The same AI for a gear plan's item id lookup (item-ids.js): a short,
// bounded task, so the lowest effort, a small answer and little patience.
export function lookupConfig(cfg) {
  const base = armoryConfig(cfg);
  const effort = ARMORY_EFFORTS[0];
  return {
    ...base,
    timeoutMs: 120000,
    anthropic: { ...base.anthropic, effort, maxTokens: 4000 },
    claudeCode: { ...base.claudeCode, effort },
    codex: { ...base.codex, effort },
  };
}

const sum = (a, b) => (a && b ? { input: a.input + b.input, cached: a.cached + b.cached, output: a.output + b.output } : a || b || null);

// Sections of the character data each kind of request shows the AI.
const pick = (ctx, keys) => {
  const out = {};
  for (const k of keys) if (ctx[k] !== undefined && ctx[k] !== null) out[k] = ctx[k];
  return out;
};
const BASE = ['character', 'specialization', 'stats', 'skills'];

function profileOf(req, kind) {
  const input = req.ext?.input && typeof req.ext.input === 'object' ? req.ext.input : {};
  const goal = str(input.goal, 20).toLowerCase();
  const role = str(input.role, 20).toLowerCase();
  return {
    spec: str(input.spec, 80) || undefined,
    goal: ['leveling', 'dungeons', 'raids', 'pvp', 'solo'].includes(goal) ? goal : 'leveling',
    role: ['dps', 'tank', 'healer'].includes(role) ? role : 'dps',
    notes: str(input.notes, 400) || undefined,
    // Rotations only: the player ticked fighting several enemies at once.
    aoe: (kind === 'rotation' && input.aoe === true) || undefined,
    // Gear plans only: dungeons, raids or questing the player left out.
    without: leftOut(input.without).length ? leftOut(input.without) : undefined,
  };
}

// One request's conversation with the AI: asks, reads the JSON, and asks once
// more with what was wrong when `check` says the answer can't be used.
// check(raw) -> { result, score, retry: [problems] | null, also: [problems
// worth fixing that would not send the answer back on their own], fatal:
// message key }. Returns the verdict of the answer that was kept.
async function converse(ai, system, data, check) {
  const messages = [{ role: 'user', content: buildArmoryMessage(data) }];
  let reply = await ai(system, messages);
  let raw = extractJson(reply);
  let verdict = raw ? check(raw) : { retry: [t('armoryNoJson')] };
  if (verdict.retry?.length) {
    reply = await ai(system, [...messages, { role: 'assistant', content: String(reply || '(empty)') },
      { role: 'user', content: repairMessage(verdict.retry, verdict.also) }]);
    const second = extractJson(reply);
    if (second) {
      const again = check(second);
      // The second answer wins unless it is worse than the first.
      if (!verdict.result || (again.result && (again.score ?? 0) >= (verdict.score ?? 0))) { raw = second; verdict = again; }
    }
  }
  if (!raw || !verdict.result) throw err(verdict.fatal || 'armoryNoJson');
  return verdict;
}

// Targets the player asked for: a model written for one enemy when the
// player ticked several at once is simulated against AOE_TARGETS all the same.
const AOE_TARGETS = 3;
function withTargets(model, profile) {
  if (!profile.aoe || !model || typeof model !== 'object' || (num(model.fight?.targets) || 1) >= 2) return model;
  return { ...model, fight: { ...(model.fight && typeof model.fight === 'object' ? model.fight : {}), targets: AOE_TARGETS } };
}

// The last rotation analysis of this character, when it was for the same
// specialization and role as this request: the AI builds on it, so that two
// analyses of an unchanged character stay comparable. An entry kept before
// the role was recorded takes it from its metric.
function lastAnalysis(kept, profile) {
  if (!kept?.model || typeof kept.model !== 'object') return null;
  const role = kept.role || (kept.metric === 'tps' ? 'tank' : kept.metric === 'hps' ? 'healer' : 'dps');
  return kept.spec === profile.spec && role === profile.role ? kept : null;
}

const handlers = {
  async talents({ ctx, profile, system, ai }) {
    const index = talentIndex(ctx.armory_talents);
    const data = { request: profile, ...pick(ctx, [...BASE, 'gear', 'armory_talents']) };
    return (await converse(ai, system('talents'), data, (raw) => {
      const checked = validateOrder(index, raw.order);
      const missing = index.pointsAtCap - checked.order.length;
      // A few misplaced points are dropped; a build with holes is sent back.
      const result = checked.order.length ? shapeBuild(index, raw, checked) : null;
      return { result, score: checked.order.length, retry: missing > 2 || !result ? checked.problems : null };
    })).result;
  },

  async gear({ ctx, profile, system, ai, kept, ids }) {
    const data = {
      request: profile,
      ...pick(ctx, [...BASE, 'gear', 'emptySlots', 'professions', 'reputations', 'lockouts', 'auctionPrices', 'armory_seen']),
      inventory: equippable(ctx.inventory),
      bank: ctx.bank?.items ? { seenAt: ctx.bank.seenAt, items: equippable(ctx.bank.items) } : undefined,
      talents: takenTalents(ctx.armory_talents) || undefined,
      armory_weights: kept?.weights || undefined,
    };
    const plan = (await converse(ai, system('gear'), data, (raw) => {
      const result = shapeGear(raw, { without: profile.without });
      const picks = result.slots.reduce((n, s) => n + s.picks.length, 0);
      return { result: picks || result.summary ? result : null, score: picks, retry: picks ? null : ['"slots" has no usable picks'] };
    })).result;
    // Ids checked and filled in afterwards; whatever goes wrong there, the plan stands.
    try {
      await ids(plan);
    } catch {
      // Picks keep whatever ids they had.
    }
    return plan;
  },

  async rotation({ ctx, profile, system, ai, store, charKey, kept, iterations }) {
    const scaling = shapeScaling(ctx.armory_scaling);
    const last = lastAnalysis(kept, profile);
    const data = {
      request: profile,
      ...pick(ctx, [...BASE, 'armory_combat', 'armory_spells', 'armory_auras', 'gear', 'buffs', 'pet']),
      armory_talents: takenTalents(ctx.armory_talents) || undefined,
      armory_scaling: scaling || undefined,
      armory_model: last?.model || undefined,
    };
    const shape = { spells: ctx.armory_spells, auras: list(ctx.armory_auras), context: profile.aoe ? 'aoe' : 'st' };
    // A tank's rotations are ranked by threat, and survival is estimated with
    // the defensive numbers the game gave (never the AI's).
    const tank = profile.role === 'tank';
    const verdict = await converse(ai, system('rotation', { hasModel: !!last }), data, (raw) => {
      const run = runModel(withTargets(raw.model, profile), { iterations, tank, defense: tank ? ctx.armory_combat : null, goal: profile.goal, kept: last });
      if (run.fatal) return { result: null, retry: run.problems.length ? run.problems : ['"model" is missing or empty'], fatal: 'armoryNoModel' };
      const lists = oneButtonLists(run, shape);
      const result = shapeRotation(raw, run, { ...shape, lists });
      // The model's scaling next to what was measured (only reported, not changed).
      const compared = scaling ? compareScaling(run.model, scaling) : null;
      if (compared) result.scaling = compared;
      // Simulated, but with parts the simulator had to drop: worth one
      // correction. The One Button lists are a by-product, too costly to ask
      // again for: what was wrong with them only rides along.
      return {
        result, keep: keepFromRun(run, { rawModel: raw.model }), score: 1000 - run.problems.length,
        retry: run.problems.length >= 3 ? run.problems : null,
        also: lists.problems,
      };
    });
    // Kept on this PC for the gear plan (measured weights), for testing ideas
    // and for the next rotation analysis of the same build.
    if (verdict.keep) store.set(charKey, { ...verdict.keep, spec: profile.spec, goal: profile.goal, role: profile.role });
    // Pets are not simulated yet (later work): a class that fights with one is told.
    if (PET_CLASSES.includes(ctx.character?.classToken)) {
      verdict.result.assumptions = [t('armoryNoPets'), ...verdict.result.assumptions].slice(0, 6);
    }
    return verdict.result;
  },

  async discover({ ctx, profile, system, ai, kept, iterations }) {
    const base = baselineOf(kept);
    const data = {
      request: profile,
      ...pick(ctx, [...BASE, 'armory_combat', 'armory_talents', 'armory_spells', 'gear', 'buffs', 'pet', 'armory_seen']),
      inventory: equippable(ctx.inventory),
      bank: ctx.bank?.items ? { seenAt: ctx.bank.seenAt, items: equippable(ctx.bank.items) } : undefined,
      armory_model: base || undefined,
      armory_weights: kept?.weights || undefined,
      armory_scaling: shapeScaling(ctx.armory_scaling) || undefined,
    };
    return (await converse(ai, system('discover', { hasModel: !!base }), data, (raw) => {
      const result = shapeIdeas(raw, base, { iterations, metric: kept?.metric });
      return { result: result.ideas.length || result.summary ? result : null, score: result.ideas.length };
    })).result;
  },
};

// A line for the app's log and list of questions.
function summarize(kind, data) {
  if (kind === 'talents') return `${data.name || 'Talent build'} (${data.spec}). ${data.summary}`;
  if (kind === 'rotation') {
    const best = data.rotations[0];
    return `${best ? `${best.name}: ${best.value} ${data.metric}. ` : ''}${data.summary}`;
  }
  if (kind === 'discover') return `${data.ideas.length} idea${data.ideas.length === 1 ? '' : 's'}. ${data.summary}`;
  return data.summary || kind;
}

// store: what is kept per character (store.js); tests pass their own, and
// a fetch and a clock for the item id checks.
export function createArmory({ store = null, askImpl = ask, fetchImpl = globalThis.fetch, now = Date.now } = {}) {
  let opened = store;
  return {
    name: 'armory',
    // req: the addon's request (req.ext = { name, kind, input }, req.context
    // with the character's sections). env: { cfg, log, lang, guides, knowledge }.
    // Returns { text, data, model, usage }.
    async handle(req, { cfg, log = () => {}, guides = null, knowledge = '' } = {}) {
      const started = now();
      const kind = str(req.ext?.kind, 40);
      if (!KINDS.includes(kind)) throw err('armoryUnknownKind', { kind });
      opened = opened || openArmoryStore();
      const ctx = req.context && typeof req.context === 'object' ? req.context : {};
      const profile = profileOf(req, kind);
      const charKey = str(req.charKey, 80);
      const kept = opened.get(charKey);
      const iterations = Math.min(Math.max(num(cfg.armory?.iterations) || 300, 50), 2000);

      // What every answer needs from the game, test mode included.
      if (kind === 'talents' && !talentIndex(ctx.armory_talents).byId.size) throw err('armoryNoTalents');
      if (kind === 'rotation' && !list(ctx.armory_spells).length) throw err('armoryNoSpells');

      // Test mode: no AI, a result made from the character's own data.
      if (cfg.provider === 'echo') {
        const data = sampleResult(kind, { ctx, profile, iterations });
        return { text: `${t('armoryTestMode')} ${summarize(kind, data)}`, data, model: 'echo' };
      }

      const aiCfg = armoryConfig(cfg);
      const searching = canSearch(aiCfg);
      let usage = null;
      let model = null;
      const ai = async (system, messages) => {
        const out = await askImpl(aiCfg, system, messages, req);
        usage = sum(usage, out.usage || null);
        model = out.model || model;
        return out.text;
      };
      // The id lookup counts toward the request's tokens, not its model line.
      const idCfg = lookupConfig(cfg);
      const lookup = async (system, messages) => {
        const out = await askImpl(idCfg, system, messages, req);
        usage = sum(usage, out.usage || null);
        return out.text;
      };
      const ids = (plan) => fillIds(plan, {
        ctx, lookup, canLookUp: searching, english: playerLang({ lang: req.lang, client: ctx.client }) === 'en',
        fetchImpl, elapsed: () => now() - started, log,
      });
      const guide = guides?.current?.() || undefined;
      const topics = guides?.topics?.() || undefined;
      const system = (k, extra = {}) => buildArmorySystem(k, {
        canSearch: searching, context: ctx, client: ctx.client || null, lang: req.lang, profile, knowledge,
        ...(guide ? { guide } : {}), ...(topics ? { topics } : {}), ...extra,
      });

      const data = await handlers[kind]({ ctx, profile, system, ai, ids, store: opened, charKey, kept, iterations, log });
      // What was asked for, so the addon can tell a result for another build.
      data.asked = { spec: profile.spec, goal: profile.goal, role: profile.role, level: num(ctx.character?.level) ?? undefined };
      if (kind === 'gear' && profile.without) data.asked.without = profile.without;
      if (kind === 'rotation' && profile.aoe) data.asked.aoe = true;
      if (kind === 'rotation') fitRotation(data, MAX_DATA_BYTES);
      if (JSON.stringify(data).length > MAX_DATA_BYTES) throw err('armoryTooBig');
      return { text: summarize(kind, data), data, model, usage };
    },
  };
}
