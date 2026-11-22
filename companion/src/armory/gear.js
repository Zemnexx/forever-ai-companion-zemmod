// Gear plans: the AI researches what to wear next and where to get it; this
// module keeps only what the addon can show and check. Items go back with
// their id when the AI is sure of one, and the addon verifies every id
// against the game before it shows a link or scores the item.
import { num, str, strings, list } from './json.js';

export const SLOTS = [
  'head', 'neck', 'shoulder', 'back', 'chest', 'wrist', 'hands', 'waist', 'legs', 'feet',
  'finger1', 'finger2', 'trinket1', 'trinket2', 'mainHand', 'offHand', 'ranged',
];
export const SOURCE_TYPES = ['dungeon', 'raid', 'quest', 'vendor', 'reputation', 'crafted', 'pvp', 'world', 'auction'];
const CONFIDENCE = ['high', 'medium', 'low'];
const MAX_PICKS = 3;
const MAX_WEIGHTS = 16;

// Loose spellings a model may use for a slot.
const SLOT_ALIASES = {
  helm: 'head', helmet: 'head', shoulders: 'shoulder', cloak: 'back', cape: 'back', bracers: 'wrist', wrists: 'wrist',
  gloves: 'hands', hand: 'hands', belt: 'waist', leggings: 'legs', boots: 'feet', ring1: 'finger1', ring2: 'finger2',
  ring: 'finger1', finger: 'finger1', trinket: 'trinket1', mainhand: 'mainHand', weapon: 'mainHand', offhand: 'offHand',
  shield: 'offHand', relic: 'ranged', wand: 'ranged', necklace: 'neck', amulet: 'neck', robe: 'chest',
};
export function slotName(value) {
  const s = str(value, 30);
  if (SLOTS.includes(s)) return s;
  const key = s.toLowerCase().replace(/[^a-z0-9]/g, '');
  return SLOTS.find((x) => x.toLowerCase() === key) || SLOT_ALIASES[key] || null;
}

// Stat weights keyed like the game's item stats ("STRENGTH", "DAMAGE_PER_SECOND").
export function cleanWeights(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [k, v] of Object.entries(raw)) {
    const key = String(k).trim().toUpperCase().replace(/[^A-Z0-9_]/g, '_');
    const value = num(v);
    if (!key || value === null || value === 0 || Math.abs(value) > 1000) continue;
    out[key] = Math.round(value * 1000) / 1000;
    if (Object.keys(out).length >= MAX_WEIGHTS) break;
  }
  return out;
}

function cleanPick(raw) {
  const name = str(raw?.name, 100);
  if (!name) return null;
  const pick = { name, why: str(raw.why, 240) };
  const id = num(raw.itemId);
  if (id !== null && Number.isInteger(id) && id > 0 && id < 10000000) pick.itemId = id;
  const level = num(raw.level);
  if (level !== null && level >= 1 && level <= 60) pick.level = Math.round(level);
  const src = raw.source && typeof raw.source === 'object' ? raw.source : {};
  const type = str(src.type, 20).toLowerCase();
  pick.source = {
    type: SOURCE_TYPES.includes(type) ? type : 'world',
    where: str(src.where, 80) || undefined,
    from: str(src.from, 80) || undefined,
    note: str(src.note, 160) || undefined,
  };
  if (raw.auction === true || pick.source.type === 'auction') pick.auction = true;
  const confidence = str(raw.confidence, 10).toLowerCase();
  pick.confidence = CONFIDENCE.includes(confidence) ? confidence : 'low';
  return pick;
}

// The data the addon gets for a gear plan. `raw`: the AI's parsed answer.
export function shapeGear(raw) {
  const bySlot = new Map();
  for (const entry of list(raw?.slots)) {
    const slot = slotName(entry?.slot);
    if (!slot) continue;
    const picks = bySlot.get(slot) || [];
    for (const p of list(entry.picks)) {
      const pick = cleanPick(p);
      if (pick && picks.length < MAX_PICKS && !picks.some((x) => x.name.toLowerCase() === pick.name.toLowerCase())) picks.push(pick);
    }
    if (picks.length) bySlot.set(slot, picks);
  }
  return {
    v: 1,
    kind: 'gear',
    summary: str(raw?.summary, 600),
    weights: cleanWeights(raw?.weights),
    weightsNote: str(raw?.weightsNote, 240) || undefined,
    slots: SLOTS.filter((s) => bySlot.has(s)).map((s) => ({ slot: s, picks: bySlot.get(s) })),
    next: strings(raw?.next, { max: 5, len: 240 }),
    notes: strings(raw?.notes, { max: 4, len: 300 }),
  };
}

// Only what can be worn, without the fields that don't help choose gear.
export function equippable(items) {
  const out = list(items).filter((it) => it && typeof it === 'object' && (it.equipSlot || it.slot));
  return out.length ? out : undefined;
}
