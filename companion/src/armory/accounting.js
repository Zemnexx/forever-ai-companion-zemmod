// What a rotation answer says about the character's talents, checked. The AI
// lists every talent the character has, with where its effect is in the
// combat model ("in": ids of abilities, buffs or procs, or "player") or why
// it leaves it out. A talent it forgets, or one it says is somewhere the
// model has nothing, is what lets a model drop a talent without anyone
// noticing, and with the last model shown again the next time, keep it
// dropped. Also: the buffs seen on the character as the AI is shown them.
import { list, num, str, text } from './json.js';

const NAME_LEN = 80;
const TEXT_LEN = 120;
const MAX_AURAS = 120;
const AURA_DESC = 200;
// A line of the correction round names this many talents at most.
const MAX_NAMED = 12;

const key = (v) => str(v, NAME_LEN).toLowerCase();

// The names of the talents the character has points in (armory_talents as
// the addon sent it), as the game gave them, each once.
export function talentNames(section) {
  const names = [];
  for (const tree of list(section?.trees)) {
    for (const t of list(tree?.talents)) {
      const name = str(t?.name, NAME_LEN);
      if (name && (num(t?.rank) || 0) > 0 && !names.some((n) => n.toLowerCase() === name.toLowerCase())) names.push(name);
    }
  }
  return names;
}

// What a reference in "in" can name: "player", or an ability, buff or proc of
// the normalized model by its id. The AI sometimes writes the name instead of
// the id; that names the same thing, so it counts too.
function knownRefs(model) {
  const known = new Set(['player']);
  for (const x of [...list(model?.abilities), ...list(model?.buffs), ...list(model?.procs)]) {
    if (x?.id !== undefined) known.add(key(x.id));
    if (x?.name) known.add(key(x.name));
  }
  return known;
}

const named = (names) => {
  const shown = names.slice(0, MAX_NAMED).join(', ');
  return names.length > MAX_NAMED ? `${shown} and ${names.length - MAX_NAMED} more` : shown;
};

/**
 * The AI's "talents" (raw) against the talents the character has (taken:
 * talentNames()) and the normalized model. Returns { counted: [{ name, how }],
 * left: [{ name, why }], missing: [name], problems: [lines for the AI] }.
 * Entries for talents the character does not have are ignored, and so are
 * repeated ones (the first counts). An entry counts when at least one of its
 * references is in the model; one that names nothing the model has is missing.
 */
export function accountTalents(raw, model, taken) {
  const out = { counted: [], left: [], missing: [], problems: [] };
  const wanted = new Map(list(taken).map((name) => [key(name), name]));
  if (!wanted.size) return out;
  const known = knownRefs(model);
  const seen = new Map();
  for (const entry of list(raw)) {
    const k = key(entry?.name);
    if (!wanted.has(k) || seen.has(k)) continue;
    seen.set(k, entry);
  }
  const unlisted = [];
  for (const [k, name] of wanted) {
    const entry = seen.get(k);
    if (!entry) { unlisted.push(name); out.missing.push(name); continue; }
    const refs = list(entry.in).map((r) => str(r, NAME_LEN)).filter(Boolean);
    const how = text(entry.how, TEXT_LEN);
    if (!refs.length) {
      out.left.push(how ? { name, why: how } : { name });
      continue;
    }
    const absent = refs.filter((r) => !known.has(r.toLowerCase()));
    if (absent.length) {
      out.problems.push(`"talents": "${name}" is in ${absent.map((r) => `"${r}"`).join(', ')}, which the model has no ability, buff or proc for: put its effect in the model, or point "in" at where it is`);
    }
    if (absent.length < refs.length) out.counted.push(how ? { name, how } : { name });
    else out.missing.push(name);
  }
  if (unlisted.length) {
    out.problems.unshift(`"talents" does not account for ${unlisted.length === 1 ? 'this talent' : 'these talents'} the character has: ${named(unlisted)}. Give each one an entry: in the model if it changes the result, or with "in": [] and why it does not`);
  }
  return out;
}

// The accounting as the addon shows it, or null when the request carried no
// talents: each list only when it has something in it.
export function shapeTalents(accounted, taken) {
  if (!list(taken).length) return null;
  const out = {};
  for (const k of ['counted', 'left', 'missing']) if (accounted[k].length) out[k] = accounted[k];
  return out;
}

// The buffs seen on the character as the AI gets them: name, id, what the
// game's tooltip says ("desc") and the most stacks seen, bounded.
export function aurasForPrompt(section) {
  const out = [];
  for (const a of list(section)) {
    const name = str(a?.name, NAME_LEN);
    if (!name) continue;
    const aura = { name };
    if (num(a.id) !== null) aura.id = num(a.id);
    const desc = text(a.desc, AURA_DESC);
    if (desc) aura.desc = desc;
    const stacks = num(a.stacks);
    if (stacks !== null && stacks > 0) aura.stacks = Math.round(stacks);
    out.push(aura);
    if (out.length >= MAX_AURAS) break;
  }
  return out.length ? out : null;
}
