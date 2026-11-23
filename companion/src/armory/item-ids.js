// Item ids for gear plans. A pick with the right id gets the item's own
// tooltip in the game; without one it is only a name. The AI in the big gear
// conversation often has no id, so the app checks the ids a plan came with
// against Wowhead's tooltip service for WoW Forever, and asks the AI for the
// missing ones in a short conversation of their own, checked the same way and
// asked once more for what is still missing.
//
// Only id numbers are sent to Wowhead. Nothing here can fail a gear plan: a
// check that gets no answer keeps the id (the game checks every id again),
// and a lookup that fails only leaves picks without an id.
import { extractJson, list, num } from './json.js';
import { buildIdLookupMessage, buildIdLookupSystem } from './prompts.js';

const TOOLTIP_URL = 'https://nether.wowhead.com/forever/tooltip/item/';
// Generic on purpose: nothing about the player, the PC or this app.
const USER_AGENT = 'Mozilla/5.0 (compatible; item-tooltip-check)';
const CONCURRENCY = 6;
export const MAX_LOOKUP = 12;
// The addon waits about 21 minutes for an answer; the main conversation can
// already have taken much of that.
export const LOOKUP_BEFORE_MS = 12 * 60000;
export const RETRY_BEFORE_MS = 15 * 60000;

const validId = (v) => {
  const id = num(v);
  return id !== null && Number.isInteger(id) && id > 0 && id < 10000000 ? id : null;
};

// Names compared the way a person would: case, accents, apostrophes, hyphens
// and spacing do not make two items different ("X'caliboar" is "Xcaliboar").
export function nameKey(name) {
  return String(name ?? '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}
export function sameName(a, b) {
  const x = nameKey(a);
  return x !== '' && x === nameKey(b);
}

async function checkOnce(id, fetchImpl, timeoutMs) {
  try {
    const res = await fetchImpl(`${TOOLTIP_URL}${id}`, {
      headers: { 'user-agent': USER_AGENT, accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.status === 404) return { status: 'missing' };
    if (res.status !== 200) return { status: 'unreachable' };
    const body = JSON.parse(await res.text());
    const name = typeof body?.name === 'string' ? body.name.trim() : '';
    return name ? { status: 'found', name } : { status: 'unreachable' };
  } catch {
    return { status: 'unreachable' };
  }
}

// What Wowhead says about one id: { status: 'found', name } | { status:
// 'missing' } | { status: 'unreachable' }. No answer is tried once more.
export async function checkItem(id, { fetchImpl = globalThis.fetch, timeoutMs = 8000 } = {}) {
  const first = await checkOnce(id, fetchImpl, timeoutMs);
  return first.status === 'unreachable' ? checkOnce(id, fetchImpl, timeoutMs) : first;
}

// Several ids, a few at a time so the service is not flooded. Map id -> result.
export async function checkItems(ids, options = {}) {
  const queue = [...new Set(ids)];
  const out = new Map();
  const worker = async () => {
    while (queue.length) {
      const id = queue.shift();
      out.set(id, await checkItem(id, options));
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, worker));
  return out;
}

// Whether Wowhead's answer confirms `id` for an item called `name`. The
// service names items in English, so for another language only an id that
// does not exist is known to be wrong.
function verdict(result, name, english) {
  if (result.status === 'missing') return false;
  if (result.status === 'found' && english && !sameName(result.name, name)) return false;
  return true;
}

// Ids the game itself gave in the character data, with the name seen there.
function knownIds(ctx) {
  const known = new Map();
  const add = (items) => {
    for (const it of list(items)) {
      const id = validId(it?.itemId);
      if (id) known.set(id, it.name);
    }
  };
  add(ctx?.gear);
  add(ctx?.inventory);
  add(ctx?.bank?.items);
  add(ctx?.armory_seen);
  return known;
}

// Names to look up: picks without an id, the first pick of each slot before
// the others, each name once.
export function namesToLookUp(slots, max = MAX_LOOKUP) {
  const names = [];
  const seen = new Set();
  const take = (p) => {
    const key = nameKey(p.name);
    if (p.itemId || !key || seen.has(key) || names.length >= max) return;
    seen.add(key);
    names.push(p.name);
  };
  for (const s of slots) if (s.picks[0]) take(s.picks[0]);
  for (const s of slots) for (const p of s.picks.slice(1)) take(p);
  return names;
}

// The ids in a lookup answer for the names that were asked, by exact name or,
// failing that, by the same name spelled differently.
function readIds(reply, names) {
  const raw = extractJson(reply)?.ids;
  const out = new Map();
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  const entries = Object.entries(raw);
  for (const name of names) {
    const hit = Object.hasOwn(raw, name) ? raw[name] : entries.find(([k]) => sameName(k, name))?.[1];
    const id = validId(hit);
    if (id) out.set(name, id);
  }
  return out;
}

// One lookup round: the AI's ids for `names`, each checked with Wowhead.
// Returns { accepted: Map name -> id, wrong: Map name -> id }.
async function lookupRound(names, wrongBefore, { lookup, check, english, log }) {
  const accepted = new Map();
  const wrong = new Map();
  let reply;
  try {
    reply = await lookup(buildIdLookupSystem(), [{ role: 'user', content: buildIdLookupMessage(names, wrongBefore) }]);
  } catch (e) {
    log(`Item id lookup failed: ${e.message}`);
    return { accepted, wrong };
  }
  const given = readIds(reply, names);
  const results = await check([...given.values()]);
  for (const [name, id] of given) {
    if (verdict(results.get(id) || { status: 'unreachable' }, name, english)) accepted.set(name, id);
    else wrong.set(name, id);
  }
  return { accepted, wrong };
}

// Confirms the ids of a shaped gear plan and fills in missing ones, in place.
// lookup(system, messages) -> reply text: the AI, asked cheaply. canLookUp:
// the AI can search the web. elapsed(): ms since the request started.
export async function fillIds(plan, {
  ctx = {}, lookup, canLookUp = false, english = true, fetchImpl = globalThis.fetch, timeoutMs = 8000,
  elapsed = () => 0, log = () => {},
} = {}) {
  const stats = { came: 0, confirmed: 0, dropped: 0, unchecked: 0, asked: 0, found: 0, missing: 0, skipped: '' };
  const picks = plan.slots.flatMap((s) => s.picks);
  const check = async (ids) => {
    try {
      return await checkItems(ids, { fetchImpl, timeoutMs });
    } catch {
      return new Map();
    }
  };
  const wrongFromPlan = new Map();

  // a. The ids the plan came with. Ids the game gave in the data need no check.
  const known = knownIds(ctx);
  const withId = picks.filter((p) => p.itemId);
  stats.came = withId.length;
  const toCheck = withId.filter((p) => !(known.has(p.itemId) && (!english || sameName(known.get(p.itemId), p.name))));
  const results = await check(toCheck.map((p) => p.itemId));
  for (const p of withId) {
    if (!toCheck.includes(p)) { stats.confirmed++; continue; }
    const r = results.get(p.itemId) || { status: 'unreachable' };
    if (!verdict(r, p.name, english)) {
      wrongFromPlan.set(p.name, p.itemId);
      delete p.itemId;
      stats.dropped++;
    } else if (r.status === 'unreachable') stats.unchecked++;
    else stats.confirmed++;
  }

  // b to d. The missing ones, looked up and checked, then asked once more.
  let names = namesToLookUp(plan.slots);
  const give = (accepted) => {
    for (const p of picks) {
      if (p.itemId) continue;
      const hit = [...accepted].find(([n]) => n.toLowerCase() === p.name.toLowerCase());
      if (hit) p.itemId = hit[1];
    }
  };
  if (!names.length) {
    // Every pick has its id.
  } else if (!canLookUp || typeof lookup !== 'function') {
    stats.skipped = 'the AI cannot search the web';
  } else if (elapsed() > LOOKUP_BEFORE_MS) {
    stats.skipped = 'no time left';
  } else {
    stats.asked = names.length;
    const env = { lookup, check, english, log };
    const wrongOf = (asked) => new Map([...wrongFromPlan].filter(([n]) => asked.includes(n)));
    const first = await lookupRound(names, wrongOf(names), env);
    give(first.accepted);
    stats.found += first.accepted.size;
    names = names.filter((n) => !first.accepted.has(n));
    if (names.length && elapsed() <= RETRY_BEFORE_MS) {
      const wrong = new Map([...wrongOf(names), ...first.wrong]);
      const second = await lookupRound(names, wrong, env);
      give(second.accepted);
      stats.found += second.accepted.size;
      names = names.filter((n) => !second.accepted.has(n));
    } else if (names.length) stats.skipped = 'no time left for the retry';
    stats.missing = names.length;
  }

  log(`Item ids: ${stats.came} came with the plan (${stats.confirmed} confirmed, ${stats.dropped} dropped, ${stats.unchecked} unchecked); `
    + (stats.asked ? `${stats.asked} looked up, ${stats.found} found, ${stats.missing} not found after the retry` : 'none looked up')
    + (stats.skipped ? ` (${stats.skipped})` : '') + '.');
  return stats;
}
