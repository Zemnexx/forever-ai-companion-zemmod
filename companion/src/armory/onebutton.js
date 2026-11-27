// Priority lists for Forever One Button, the owner's other addon, which can
// import such a list as a "rotation profile". The AI writes one list per kind
// of fight ("oneButton" in the model); without one, the best candidate of that
// fight stands in. Either way this code cleans the list into what One Button
// can play, says in plain sentences what it could not carry over, and the
// simulator measures exactly the cleaned list (oneButtonFor below).
//
// The target format is One Button's (ForeverOneButton/Core/Profiles.lua,
// SCHEMA and the limits): entries { id, gates } where each gate is a condition
// type ("t") with a few fields. One Button already holds an entry back while
// its spell is unknown, unusable, short of resources, on cooldown, out of
// range, or a DoT it knows is still ticking (Engine/Queue.lua Evaluate), so
// none of that needs a gate. A gate it cannot answer never holds an ability
// back, so a condition lost on the way makes an ability come up more freely
// than the model meant: that is what the rules below guard against.
//
// Every gate comes with the condition it stands for in the model's own
// language ("conds"), so the cleaned list can be simulated as One Button
// would play it: a condition left out is left out of both, and one carried
// over only roughly is simulated the rough way.
import { num, str, text } from './json.js';

export const ONE_BUTTON_VERSION = 1;
const MAX_ENTRIES = 60;   // per list
const MAX_GATES = 12;     // per entry and per group
const MAX_DEPTH = 3;      // an entry's own gates are depth 1; groups nest up to here
const MAX_LEFT = 8;
const LEFT_LEN = 160;
const NAME_LEN = 80;

// The number ranges of One Button's SCHEMA, for the fields emitted here. A
// gate with a value outside them would be dropped by its sanitizer, so it is
// left out here instead, with a line saying so.
const RANGES = {
  power: { n: [-100000, 100000] },
  buff: { dur: [0, 86400] },
  stack: { n: [0, 1000] },
  targets: { n: [0, 100] },
  execute: { pct: [0, 100] },
  resource: { n: [0, 10] },
  swing: { n: [0, 10] },
};
const SPELL_MAX = 2147483648;
const spellId = (v) => {
  const n = num(v);
  return n !== null && Number.isInteger(n) && n > 0 && n < SPELL_MAX ? n : null;
};
function inRange(gate) {
  for (const [field, [low, high]] of Object.entries(RANGES[gate.t] || {})) {
    if (field in gate && !(gate[field] >= low && gate[field] <= high)) return false;
  }
  return true;
}

// The spells One Button keeps track of as DoTs by itself (Dots.Active in
// Engine/Dots.lua): every rank whose base rank is in Data/Defaults.lua
// targetDots, ranks taken from Data/Rotations.lua rankChains, Forever One
// Button 1.1.4-zm9 (153 ids). It holds such a spell back while its DoT is up
// on the target. A spell named by any target stack gate stops being treated
// as a DoT there, so no stack gate is ever emitted for one of these.
const TRACKED_DOTS = new Set([
  99, 172, 339, 348, 589, 594, 603, 703, 707, 770, 772, 778, 970, 980, 992, 1014, 1062, 1079, 1094, 1120,
  1130, 1160, 1735, 1822, 1823, 1824, 1943, 1978, 2767, 2941, 3674, 5195, 5196, 5570, 6190, 6217, 6222, 6223,
  6546, 6547, 6548, 7648, 8050, 8052, 8053, 8288, 8289, 8631, 8632, 8633, 8639, 8640, 8921, 8924, 8925, 8926,
  8927, 8928, 8929, 9490, 9492, 9493, 9747, 9749, 9752, 9833, 9834, 9835, 9852, 9853, 9894, 9896, 9898, 9904,
  9907, 10447, 10448, 10797, 10892, 10893, 10894, 11273, 11274, 11275, 11289, 11290, 11554, 11555, 11556,
  11572, 11573, 11574, 11665, 11667, 11668, 11671, 11672, 11675, 11711, 11712, 11713, 13549, 13550, 13551,
  13552, 13553, 13554, 13555, 13797, 14296, 14298, 14299, 14300, 14301, 14323, 14324, 14325, 15407, 17311,
  17312, 17313, 17314, 18265, 18807, 18879, 18880, 18881, 19296, 19299, 19302, 19303, 19304, 19305, 24118,
  24119, 24120, 24974, 24975, 24976, 24977, 25295, 25309, 25311, 29228, 414644, 440892, 1235826, 1235827,
  1299332, 1311676, 1311677, 1311680, 1316697
]);
// One Button counts an effect it does not track from the player's own
// casts, one application per cast lasting this long (Dots.DEFAULT_STACKING).
const COUNTED_SECONDS = 30;

// Combo points are a buff with stacks in the model (the simulator has no
// combo points of its own); One Button reads them directly.
const isCombo = (buff) => /combo/i.test(String(buff?.id ?? '')) || /combo/i.test(String(buff?.name ?? ''));

// The character's spells by lower-case name and by id, as the game listed them.
function spellIndex(spells) {
  const byName = new Map();
  const byId = new Map();
  for (const s of Array.isArray(spells) ? spells : []) {
    const name = str(s?.name, NAME_LEN);
    const id = spellId(s?.id);
    if (!name || id === null) continue;
    if (!byName.has(name.toLowerCase())) byName.set(name.toLowerCase(), { name, id });
    if (!byId.has(id)) byId.set(id, { name, id });
  }
  return { byName, byId };
}

// The translation's view of the model: which spell each ability and buff
// stands for in the character's own spell list, or in the buffs the addon
// saw on the character (auras: { name, id }, the buff's own spell id).
function makeWorld(model, spells, auras) {
  const index = spellIndex(spells);
  const seen = spellIndex(auras).byName;
  const abilities = new Map((model.abilities || []).map((a) => [a.id, a]));
  const buffs = new Map((model.buffs || []).map((b) => [b.id, b]));
  // An ability's spell: its exact name wins; the model's own spellId only
  // counts when the character has a spell with that id.
  const abilitySpell = (ab) => {
    if (!ab) return null;
    const byName = index.byName.get(String(ab.name || '').toLowerCase());
    if (byName) return byName;
    const id = spellId(ab.spellId);
    return id !== null ? index.byId.get(id) || null : null;
  };
  const appliers = (buffId) => (model.abilities || []).filter((a) => (a.applies || []).includes(buffId));
  const firstSpell = (abs) => abs.map(abilitySpell).find(Boolean) || null;
  // The first ability of these that the character has, with its spell.
  const firstApplier = (abs) => {
    for (const ability of abs) { const spell = abilitySpell(ability); if (spell) return { ability, spell }; }
    return null;
  };
  // What a buff reference (buffUp and the like) names: a buff, or an
  // ability's dot by the ability's id, as the simulator looks them up.
  const effect = (ref) => {
    const buff = buffs.get(ref);
    if (buff) {
      if (isCombo(buff)) return { kind: 'combo', name: buff.name || buff.id };
      if (buff.onTarget) return { kind: 'target', name: buff.name || buff.id, appliers: appliers(buff.id), buff };
      // A player buff is named by one of the character's spells with its
      // name, by a buff of that name the addon saw on the character, or by
      // the ability that applies it.
      const key = String(buff.name || '').toLowerCase();
      const spell = index.byName.get(key) || seen.get(key) || firstSpell(appliers(buff.id));
      return { kind: 'player', name: buff.name || buff.id, spell, buff };
    }
    const ab = abilities.get(ref);
    if (ab && ab.dot) return { kind: 'target', name: ab.name || ab.id, appliers: [ab] };
    if (/combo/i.test(String(ref))) return { kind: 'combo', name: String(ref) };
    return { kind: 'unknown', name: String(ref) };
  };
  const nameOf = (ref) => buffs.get(ref)?.name || abilities.get(ref)?.name || String(ref);
  return { abilities, abilitySpell, firstSpell, firstApplier, effect, nameOf, resource: model.player?.resource?.type || 'none' };
}

// The opposite of a condition, in the model's own terms where it has one and
// in a few keys of this module's own (starting with "_") where it has not.
// A "not" over several keys is an "any" of their opposites; the opposite of
// an "any" is all of the opposites.
const OPPOSITE = {
  resourceAtLeast: (v) => ({ resourceBelow: v }),
  resourceBelow: (v) => ({ resourceAtLeast: v }),
  buffUp: (v) => ({ buffDown: v }),
  buffDown: (v) => ({ buffUp: v }),
  buffStacksAtLeast: (v) => ({ _stacksBelow: v }),
  buffRemainsBelow: (v) => ({ _remainsAtLeast: v }),
  cooldownUp: (v) => ({ _onCooldown: v }),
  cooldownRemainsAbove: (v) => ({ _lost: true, _what: 'cooldownAtMost', _v: v }),
  targetHealthBelow: (v) => ({ targetHealthAbove: v }),
  targetHealthAbove: (v) => ({ _healthAtMost: v }),
  targetsAtLeast: (v) => ({ _targetsBelow: v }),
  swingTimerAbove: (v) => ({ _swingAtMost: v }),
  usedOnTarget: (v) => ({ _notUsed: v }),
  timeAtLeast: (v) => ({ timeAtLeast: v, _negated: true }),
  timeRemainingBelow: (v) => ({ timeRemainingBelow: v, _negated: true }),
  any: (v) => ({ _all: (v || []).map(negate) }),
  not: (v) => v,
};
function negate(cond) {
  const keys = Object.keys(cond || {});
  if (keys.length > 1) return { any: keys.map((k) => negate({ [k]: cond[k] })) };
  const [key] = keys;
  const flip = OPPOSITE[key];
  return flip ? flip(cond[key]) : { _lost: true, _what: key, _v: cond[key] };
}

// A condition in a few plain words, for the lines the player reads.
function phrase(key, v, world, negated) {
  const name = (ref) => world.nameOf(ref);
  const res = world.resource === 'none' ? 'resource' : world.resource;
  const words = {
    timeAtLeast: () => `${v} seconds into the fight`,
    timeRemainingBelow: () => `the last ${v} seconds of the fight`,
    cooldownAtMost: () => `${name(v?.id)} being ready within ${v?.sec} seconds`,
    buffUp: () => `${name(v)} being up`,
    buffDown: () => `${name(v)} being down`,
    buffStacksAtLeast: () => `${v?.n} or more stacks of ${name(v?.id)}`,
    _stacksBelow: () => `fewer than ${v?.n} stacks of ${name(v?.id)}`,
    cooldownUp: () => `${name(v)} being ready`,
    _onCooldown: () => `${name(v)} being on cooldown`,
    cooldownRemainsAbove: () => `${name(v?.id)} being on cooldown`,
    resourceAtLeast: () => `${res} at ${v} or more`,
    resourceBelow: () => `${res} below ${v}`,
    targetHealthBelow: () => `the target below ${v}% health`,
    targetHealthAbove: () => `the target at ${v}% health or more`,
    _healthAtMost: () => `the target at ${v}% health or less`,
    targetsAtLeast: () => `${v} or more enemies`,
    _targetsBelow: () => `fewer than ${v} enemies`,
    swingTimerAbove: () => `more than ${v} seconds before the next swing`,
    _swingAtMost: () => `${v} seconds or less before the next swing`,
    usedOnTarget: () => `${name(v)} used on the target in the last ${COUNTED_SECONDS} seconds`,
    _notUsed: () => `${name(v)} not used on the target in the last ${COUNTED_SECONDS} seconds`,
  }[key];
  if (negated && key === 'timeAtLeast') return `the first ${v} seconds of the fight`;
  if (negated && key === 'timeRemainingBelow') return `the fight before its last ${v} seconds`;
  const said = words ? words() : 'a condition';
  return negated ? `not ${said}` : said;
}

// One condition translated: the gates, the model conditions they stand for
// (conds, each of one key, all of which must hold), what could not be carried
// over (lost), what was carried over only roughly (approx) and what was cut
// by One Button's limits (cut).
const result = () => ({ gates: [], conds: [], lost: [], approx: [], cut: [] });
function merge(into, part) {
  into.gates.push(...part.gates);
  into.conds.push(...part.conds);
  into.lost.push(...part.lost);
  into.approx.push(...part.approx);
  into.cut.push(...part.cut);
  return into;
}
const lost = (what) => ({ ...result(), lost: [what] });
// cond: what the gate means in the model's language.
function gate(g, key, v, world, cond) {
  if (!inRange(g)) return lost(phrase(key, v, world));
  return { ...result(), gates: [g], conds: [cond] };
}
const not = (cond) => ({ not: cond });

// Conditions of one key each as one condition object. Two of the same key
// (two buffs that must be down) go into "all", which the simulator reads too.
function andOf(conds) {
  const out = {};
  const more = [];
  for (const c of conds) {
    const [key] = Object.keys(c);
    if (key in out) more.push(c); else out[key] = c[key];
  }
  if (more.length) out.all = [...(out.all || []), ...more];
  return out;
}

// The keys of one condition, at a depth of One Button's nesting.
function translate(cond, depth, act) {
  const out = result();
  if (!cond) return out;
  for (const [key, v] of Object.entries(cond)) {
    // Markers of this module's own opposites ride along with their key.
    if (key.startsWith('_') && !TRANSLATE[key]) continue;
    const fn = TRANSLATE[key];
    if (!fn) { out.lost.push(phrase(key, v, act.world)); continue; }
    merge(out, fn(v, depth, act, cond));
  }
  // The same gate twice (from "requires" and "if" alike) is one gate.
  out.gates = unique(out.gates);
  out.conds = unique(out.conds);
  return out;
}

function power(op, n, key, act) {
  const { world, ability } = act;
  if (world.resource === 'none') return result();
  // At or below the ability's own cost, One Button's usability check says the same.
  if (op === '>=' && !(n > (ability.cost || 0))) return result();
  return gate({ t: 'power', res: world.resource, op, n }, key, n, world, { [key]: n });
}

// buffUp / buffDown and their stack forms. up: the effect wanted present.
function presence(ref, up, act, key) {
  const { world, ability } = act;
  const e = world.effect(ref);
  const same = up ? { buffUp: ref } : { buffDown: ref };
  if (e.kind === 'combo') return gate({ t: 'resource', res: 'combo_points', op: up ? '>=' : '<', n: 1 }, key, ref, world, same);
  if (e.kind === 'player') {
    if (!e.spell) return lost(phrase(key, ref, world));
    const g = { t: 'buff', id: e.spell.id };
    if (e.buff.duration > 0) g.dur = e.buff.duration;
    if (!up) g.neg = true;
    return gate(g, key, ref, world, same);
  }
  if (e.kind === 'target') {
    // Kept up on the target by the very ability that puts it there.
    if (!up && e.appliers.some((a) => a.id === ability.id)) return keepUp(e, act, key, ref);
    return onTarget(e, up ? '>=' : '<', 1, act, key, ref, same);
  }
  return lost(phrase(key, ref, world));
}

// An effect on the target kept up by its own ability. A DoT One Button
// tracks holds itself back while it is up; so does an ability whose own
// cooldown paces it. Anything else is counted from the player's casts.
function keepUp(e, act, key, ref) {
  const { world, ability, spell } = act;
  if (TRACKED_DOTS.has(spell.id)) return gate({ t: 'dot', id: spell.id }, key, ref, world, { buffDown: ref });
  // Only informational to One Button: the cooldown alone paces it, so the
  // simulated list has no condition there.
  if (hasCooldown(ability)) return { ...result(), gates: [{ t: 'dot', id: spell.id }] };
  const part = gate({ t: 'stack', id: spell.id, op: '<', n: 1, tgt: true }, key, ref, world, not({ usedOnTarget: ability.id }));
  if (!part.lost.length) part.approx.push(`keeps up ${e.name}, which One Button does not track: it waits about ${COUNTED_SECONDS} seconds between uses on the same target`);
  return part;
}

// Any other condition on an effect on the target. One Button cannot be asked
// about a DoT it tracks itself (a stack gate would stop the tracking); any
// other effect is counted from the player's own casts, which for one
// application is the applier's use in the last 30 seconds. same: the model's
// own condition, simulated as it is for more applications.
function onTarget(e, op, n, act, key, v, same) {
  const { world } = act;
  const found = world.firstApplier(e.appliers);
  if (!found) return lost(phrase(key, v, world));
  const applier = found.spell;
  if (TRACKED_DOTS.has(applier.id)) return lost(`${phrase(key, v, world)} (One Button keeps track of that effect itself and offers no condition on it)`);
  const used = { usedOnTarget: found.ability.id };
  const cond = n === 1 ? (op === '>=' ? used : not(used)) : same;
  const part = gate({ t: 'stack', id: applier.id, op, n, tgt: true }, key, v, world, cond);
  if (!part.lost.length) part.approx.push(`counts ${e.name} on the target from your own casts, about ${COUNTED_SECONDS} seconds each`);
  return part;
}

function stacks(v, atLeast, act, key) {
  const { world } = act;
  const e = world.effect(v?.id);
  const n = num(v?.n);
  if (n === null) return lost(phrase(key, v, world));
  const same = atLeast ? { buffStacksAtLeast: v } : not({ buffStacksAtLeast: v });
  if (e.kind === 'combo') return gate({ t: 'resource', res: 'combo_points', op: atLeast ? '>=' : '<', n }, key, v, world, same);
  if (e.kind === 'target') return onTarget(e, atLeast ? '>=' : '<', n, act, key, v, same);
  const id = e.kind === 'player' ? e.spell?.id ?? null : null;
  if (id === null) return lost(phrase(key, v, world));
  return gate({ t: 'stack', id, op: atLeast ? '>=' : '<', n }, key, v, world, same);
}

function cooldown(ref, onCooldown, act, key) {
  const { world, ability } = act;
  // Its own cooldown being over is what One Button checks anyway.
  if (!onCooldown && ref === ability.id) return result();
  const spell = world.abilitySpell(world.abilities.get(ref));
  if (!spell) return lost(phrase(key, ref, world));
  const g = { t: 'cd', id: spell.id };
  if (onCooldown) g.neg = true;
  return gate(g, key, ref, world, onCooldown ? not({ cooldownUp: ref }) : { cooldownUp: ref });
}

// An ability's use on the target in the last 30 seconds, as One Button counts
// it: a target stack gate on its spell. Not for a DoT One Button tracks
// itself, which a stack gate would stop it tracking.
function used(ref, wanted, act, key) {
  const { world } = act;
  const spell = world.abilitySpell(world.abilities.get(ref));
  if (!spell) return lost(phrase(key, ref, world));
  if (TRACKED_DOTS.has(spell.id)) return lost(`${phrase(key, ref, world)} (One Button keeps track of that effect itself and offers no condition on it)`);
  const cond = { usedOnTarget: ref };
  return gate({ t: 'stack', id: spell.id, op: wanted ? '>=' : '<', n: 1, tgt: true }, key, ref, world, wanted ? cond : not(cond));
}

// An "or": every member must be carried over, or none of it is (dropping a
// branch would make it stricter than the model). A member that only restated
// what One Button checks itself makes the whole "or" always true.
function anyOf(members, depth, act) {
  if (!members.length) return lost('a condition that never holds');
  if (depth >= MAX_DEPTH) return lost('a condition nested too deeply');
  const out = result();
  const g = [];
  const conds = [];
  for (const member of members) {
    let part = translate(member, depth + 1, act);
    // A member of several gates becomes a group of its own, one level down.
    if (part.gates.length > 1) part = translate(member, depth + 2, act);
    if (part.lost.length) return lost(`an either-or condition that includes ${part.lost[0]}`);
    out.approx.push(...part.approx);
    out.cut.push(...part.cut);
    if (!part.gates.length) return result();
    // A member that holds back nothing in One Button makes the "or" always true there.
    conds.push(part.conds.length ? andOf(part.conds) : null);
    if (part.gates.length === 1) { g.push(part.gates[0]); continue; }
    if (depth + 1 >= MAX_DEPTH) return lost('a condition nested too deeply');
    if (part.gates.length > MAX_GATES) { out.cut.push('group'); part.gates.length = MAX_GATES; }
    g.push({ t: 'all', g: part.gates });
  }
  if (g.length > MAX_GATES) { out.cut.push('group'); g.length = MAX_GATES; conds.length = MAX_GATES; }
  out.gates.push({ t: 'any', g });
  if (!conds.includes(null)) out.conds.push({ any: conds });
  return out;
}

const TRANSLATE = {
  resourceAtLeast: (v, d, act) => power('>=', v, 'resourceAtLeast', act),
  resourceBelow: (v, d, act) => power('<', v, 'resourceBelow', act),
  buffUp: (v, d, act) => presence(v, true, act, 'buffUp'),
  buffDown: (v, d, act) => presence(v, false, act, 'buffDown'),
  buffStacksAtLeast: (v, d, act) => stacks(v, true, act, 'buffStacksAtLeast'),
  _stacksBelow: (v, d, act) => stacks(v, false, act, '_stacksBelow'),
  // One Button cannot compare the time a buff has left: it is treated as
  // missing, so the ability refreshes it only once it has run out.
  buffRemainsBelow: (v, d, act) => {
    const part = presence(v?.id, false, act, 'buffDown');
    if (!part.lost.length) part.approx.push(`refreshes ${act.world.nameOf(v?.id)} only once it has run out, not shortly before`);
    return part;
  },
  _remainsAtLeast: (v, d, act) => {
    const part = presence(v?.id, true, act, 'buffUp');
    if (!part.lost.length) part.approx.push(`waits only for ${act.world.nameOf(v?.id)} to be up, whatever time it has left`);
    return part;
  },
  cooldownUp: (v, d, act) => cooldown(v, false, act, 'cooldownUp'),
  _onCooldown: (v, d, act) => cooldown(v, true, act, '_onCooldown'),
  // Only "on cooldown" can be asked, not how long is left.
  cooldownRemainsAbove: (v, d, act) => {
    const part = cooldown(v?.id, true, act, 'cooldownRemainsAbove');
    if (!part.lost.length) part.approx.push(`waits for ${act.world.nameOf(v?.id)} to be on cooldown, not for how long it has left`);
    return part;
  },
  targetHealthBelow: (v, d, act) => gate({ t: 'execute', op: '<', pct: v }, 'targetHealthBelow', v, act.world, { targetHealthBelow: v }),
  targetHealthAbove: (v, d, act) => gate({ t: 'execute', op: '>=', pct: v }, 'targetHealthAbove', v, act.world, { targetHealthAbove: v }),
  _healthAtMost: (v, d, act) => gate({ t: 'execute', op: '<=', pct: v }, '_healthAtMost', v, act.world, not({ targetHealthAbove: v })),
  targetsAtLeast: (v, d, act) => gate({ t: 'targets', op: '>=', n: v }, 'targetsAtLeast', v, act.world, { targetsAtLeast: v }),
  _targetsBelow: (v, d, act) => gate({ t: 'targets', op: '<', n: v }, '_targetsBelow', v, act.world, not({ targetsAtLeast: v })),
  swingTimerAbove: (v, d, act) => gate({ t: 'swing', op: '>', n: v }, 'swingTimerAbove', v, act.world, { swingTimerAbove: v }),
  _swingAtMost: (v, d, act) => gate({ t: 'swing', op: '<=', n: v }, '_swingAtMost', v, act.world, not({ swingTimerAbove: v })),
  usedOnTarget: (v, d, act) => used(v, true, act, 'usedOnTarget'),
  _notUsed: (v, d, act) => used(v, false, act, '_notUsed'),
  // One Button knows nothing of the fight's clock.
  timeAtLeast: (v, d, act, cond) => lost(phrase('timeAtLeast', v, act.world, cond._negated)),
  timeRemainingBelow: (v, d, act, cond) => lost(phrase('timeRemainingBelow', v, act.world, cond._negated)),
  _lost: (v, d, act, cond) => lost(phrase(cond._what, cond._v, act.world, cond._what !== 'cooldownAtMost')),
  any: (v, d, act) => anyOf(Array.isArray(v) ? v : [], d, act),
  // "All of these" at the same level: their gates simply stand side by side.
  _all: (v, d, act) => (Array.isArray(v) ? v : []).reduce((out, c) => merge(out, translate(c, d, act)), result()),
  not: (v, d, act) => translate(negate(v), d, act),
};

// A real cooldown keeps an ability from always coming first on its own.
const hasCooldown = (ab) => ab.cooldown > 0 && ab.cooldown > (ab.gcd || 0);

// The lines the player reads: actions left out first, then conditions left
// out, then approximations; each once, cut to fit.
function leftLines(notes) {
  const out = [];
  for (const level of [0, 1, 2]) {
    for (const n of notes) {
      if (n.level !== level) continue;
      const line = text(n.line, LEFT_LEN);
      if (line && !out.includes(line)) out.push(line);
    }
  }
  return out.slice(0, MAX_LEFT);
}
const joined = (parts) => [...new Set(parts)].slice(0, 2).join(' and ');


// One action of the list translated on its own: its spell, its gates, the
// model conditions of its "if" as One Button would check them (requires
// stays the ability's own in the model, the game holds it back too) and the
// lines about it, or null when it was left out (with a line).
function occurrence(action, place, world, dropped) {
  const ability = world.abilities.get(action.use);
  if (!ability) return null;
  const spell = world.abilitySpell(ability);
  const name = ability.name || ability.id;
  if (!spell) { dropped.push({ level: 0, line: `${name} was left out: the character's spell list has no such spell.` }); return null; }
  const act = { world, ability, spell };
  const req = translate(ability.requires, 1, act);
  const when = translate(action.if, 1, act);
  const reqConds = [...req.conds];
  const ifConds = [...when.conds];
  // One Button holds back a DoT it tracks while it runs, asked or not.
  if (TRACKED_DOTS.has(spell.id) && ability.dot) ifConds.push({ buffDown: ability.id });
  const both = merge(req, when);
  both.gates = unique(both.gates);
  if (both.lost.length && !hasCooldown(ability)) {
    dropped.push({ level: 0, spellId: spell.id, name: spell.name, why: `One Button cannot check for ${joined(both.lost)}, and without it the spell would always come first.` });
    return null;
  }
  const notes = [];
  if (both.lost.length) notes.push({ level: 1, line: `${spell.name} is suggested without checking for ${joined(both.lost)}, which One Button cannot do.` });
  if (both.gates.length > MAX_GATES) { both.cut.push('entry'); both.gates.length = MAX_GATES; }
  if (both.cut.length) notes.push({ level: 1, line: `${spell.name} keeps only the first ${MAX_GATES} of its conditions.` });
  for (const a of both.approx) notes.push({ level: 2, line: `${spell.name} ${a}.` });
  return { place, ability, spell, gates: both.gates, reqConds, ifConds: unique(ifConds), notes };
}

const unique = (items) => {
  const seen = new Set();
  return items.filter((g) => { const k = JSON.stringify(g); if (seen.has(k)) return false; seen.add(k); return true; });
};
const isGroup = (g) => g.t === 'any' || g.t === 'all';
// The model action an occurrence stands for, with these conditions.
const actionOf = (occ, conds) => (conds.length ? { use: occ.ability.id, if: andOf(conds) } : { use: occ.ability.id });

// One spell's places in the list as the one entry One Button reads (its
// queue takes each spell once, Engine/Queue.lua). A first place without
// conditions makes the later ones redundant. Otherwise the places up to the
// first one without conditions become one entry at the last of them, held
// back unless the conditions of one of them hold: never suggested where the
// model would not use it, never above what the model ranks higher; only the
// earlier places are lost. Each entry carries its model action (action).
function oneEntry(occs) {
  const [first] = occs;
  if (!first.gates.length || occs.length === 1) return { ...first, notes: [...first.notes], action: actionOf(first, first.ifConds) };
  const plain = occs.findIndex((o) => !o.gates.length);
  const taken = plain >= 0 ? occs.slice(0, plain + 1) : occs;
  const last = taken[taken.length - 1];
  const name = last.spell.name;
  const notes = taken.flatMap((o) => o.notes);
  const line = (rest) => ({ level: 2, twice: true, line: `${name} is listed more than once: One Button reads each ability once, so it keeps its lowest place${rest}.` });
  const own = actionOf(last, last.ifConds);
  // A plain place took the others in: what was said about their conditions
  // no longer describes the entry.
  if (!last.gates.length) return { ...last, notes: [...last.notes, line('')], action: own };
  // Several gates of which one is a group would need a group at depth 3.
  if (taken.some((o) => o.gates.length > 1 && o.gates.some(isGroup))) {
    return { ...last, notes: [...last.notes, line(', with only the conditions it has there')], action: own };
  }
  let members = unique(taken.flatMap((o) => {
    if (o.gates.length > 1) return [{ t: 'all', g: o.gates }];
    return o.gates[0].t === 'any' ? o.gates[0].g : o.gates;
  }));
  if (members.length > MAX_GATES) {
    members = members.slice(0, MAX_GATES);
    notes.push({ level: 1, line: `${name} keeps only the first ${MAX_GATES} of its conditions.` });
  }
  // In the model: any of the places' own conditions; a place with none of
  // its own makes it always true.
  const places = taken.map((o) => [...o.reqConds, ...o.ifConds]);
  const action = places.some((c) => !c.length) ? { use: last.ability.id } : { use: last.ability.id, if: { any: places.map(andOf) } };
  return { ...last, gates: [{ t: 'any', g: members }], notes: [...notes, line(', for the conditions of any of its places')], action };
}

/**
 * A priority list cleaned into what One Button can play. model: the
 * validated model; rotation: { actions } in the model's language; spells:
 * the character's spells as the game listed them; auras: buffs the addon saw
 * on the character ({ name, id }). Returns null when nothing could be carried
 * over, else { list: [{ id, name, gates }], actions (the same list in the
 * model's language, to simulate), left (lines for the player), problems (the
 * lines that say what broke One Button's rules) }.
 */
export function cleanRotation(model, rotation, spells, { auras = [] } = {}) {
  if (!model || !rotation) return null;
  const world = makeWorld(model, spells, auras);
  const dropped = [];
  const bySpell = new Map();
  (rotation.actions || []).forEach((action, place) => {
    const occ = occurrence(action, place, world, dropped);
    if (!occ) return;
    if (!bySpell.has(occ.spell.id)) bySpell.set(occ.spell.id, []);
    bySpell.get(occ.spell.id).push(occ);
  });
  let entries = [...bySpell.values()].map(oneEntry).sort((a, b) => a.place - b.place);
  if (entries.length > MAX_ENTRIES) {
    entries = entries.slice(0, MAX_ENTRIES);
    dropped.push({ level: 0, line: `Only the first ${MAX_ENTRIES} abilities of the rotation were carried over.` });
  }
  if (!entries.length) return null;
  // A place left out of a spell that still has an entry is one use of it
  // left out, not the spell: said with the conditions left out.
  const listed = new Set(entries.map((e) => e.spell.id));
  const said = dropped.map((d) => {
    if (!d.why) return d;
    if (listed.has(d.spellId)) return { level: 1, line: `One use of ${d.name} was left out: ${d.why}` };
    return { level: 0, line: `${d.name} was left out: ${d.why}` };
  });
  const notes = [...said, ...entries.flatMap((e) => e.notes)];
  return {
    list: entries.map((e) => ({ id: e.spell.id, name: e.spell.name, gates: e.gates })),
    actions: entries.map((e) => e.action),
    left: leftLines(notes),
    // Approximations are One Button's limits, not mistakes in the list.
    problems: leftLines(notes.filter((n) => n.level < 2 || n.twice)),
  };
}

/**
 * A rotation as a One Button priority list, without measuring it: { v,
 * context ("st" or "aoe"), rotation (its name), list, left? }, or null when
 * nothing could be translated.
 */
export function oneButtonList(model, rotation, spells, context = 'st', { auras = [] } = {}) {
  const cleaned = cleanRotation(model, rotation, spells, { auras });
  if (!cleaned) return null;
  const out = {
    v: ONE_BUTTON_VERSION,
    context: context === 'aoe' ? 'aoe' : 'st',
    rotation: str(rotation.name, NAME_LEN) || 'Rotation',
    list: cleaned.list,
  };
  if (cleaned.left.length) out.left = cleaned.left;
  return out;
}

/**
 * The One Button list for one kind of fight ("short" or "long"): the AI's
 * own list for it (model.oneButton[kind]) when it has one that can be carried
 * over, else the best candidate of that fight (best: { name, actions }).
 * measure(actions) simulates the cleaned list in that fight and returns its
 * value, so what is exported is what was measured. Returns { list: { v,
 * context, source, rotation?, list, left?, value } or null, problems: what
 * was wrong with the AI's list }.
 */
export function oneButtonFor(model, { kind, best, spells, auras = [], context = 'st', measure }) {
  const problems = [];
  const own = model?.oneButton?.[kind];
  let cleaned = null;
  let source = 'ai';
  if (Array.isArray(own) && own.length) {
    cleaned = cleanRotation(model, { actions: own }, spells, { auras });
    if (cleaned) problems.push(...cleaned.problems);
    else problems.push('None of its abilities could be carried over to One Button: the best candidate was used instead.');
  }
  if (!cleaned) {
    cleaned = cleanRotation(model, best, spells, { auras });
    source = 'best';
  }
  if (!cleaned) return { list: null, problems };
  const out = { v: ONE_BUTTON_VERSION, context: context === 'aoe' ? 'aoe' : 'st', source };
  if (source === 'best') out.rotation = str(best.name, NAME_LEN) || 'Rotation';
  out.list = cleaned.list;
  if (cleaned.left.length) out.left = cleaned.left;
  out.value = measure(cleaned.actions);
  return { list: out, problems };
}
