// The WoW Forever base guide the AI reads before answering.
//
// A copy ships inside the app (knowledge-builtin/wow-forever.md), but Forever
// keeps changing, so the app also downloads the published guide every few
// hours and keeps the newest one on disk. Every guide starts with a small
// header:
//   ---
//   date: 2026-11-13           (when it was last reviewed)
//   gameVersion: 1.60.1        (game version it describes)
//   build: 70938               (game build it describes)
//   ---
// (The first guides used Spanish keys "fecha" and "versionJuego": still accepted.)
//
// The guide goes into the AI's instructions, so a downloaded one is only used
// when it is signed with the project's key (wow-forever.md.sig next to it,
// see signing.js and scripts/sign.js): checked when downloaded and again
// whenever it is read from disk. Without a trusted key, the app keeps the
// guide built into it.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { foreverGuide } from './assets.js';
import { GUIDE_CONTEXT, TRUSTED_KEYS, guideFields, readSmall, verifySignature } from './signing.js';

export const GUIDE_FILE = 'wow-forever.md';
export const GUIDE_SIG_FILE = `${GUIDE_FILE}.sig`;
const MAX_BYTES = 200 * 1024;
const MIN_BODY = 1000;
// Older than this, the AI must double-check facts that may have changed.
export const STALE_DAYS = 21;

// { meta: { date, gameVersion, build }, body } or null if it isn't a guide.
export function parseGuide(text) {
  const m = /^﻿?---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(String(text || ''));
  if (!m) return null;
  const meta = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^\s*([A-Za-z]+)\s*:\s*(.*?)\s*$/.exec(line);
    if (kv) meta[kv[1]] = kv[2];
  }
  meta.date = meta.date || meta.fecha;
  meta.gameVersion = meta.gameVersion || meta.versionJuego;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(meta.date || '')) return null;
  meta.build = meta.build ? Number(meta.build) || null : null;
  return { meta, body: m[2].trim() };
}

// Rejects anything that isn't clearly an updated Forever guide: the text goes
// straight to the AI, so a wrong page or an error page must never replace it.
export function validGuide(text) {
  if (Buffer.byteLength(String(text || '')) > MAX_BYTES) return null;
  const g = parseGuide(text);
  if (!g || g.body.length < MIN_BODY || !/World of Warcraft: Forever/.test(g.body)) return null;
  return g;
}

const newer = (a, b) => (!b || a.meta.date > b.meta.date ? a : b);

// True when `bytes` (the guide file exactly as published) carry a valid signature.
export function signedGuide(bytes, signature, trustedKeys = TRUSTED_KEYS) {
  const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
  return verifySignature(GUIDE_CONTEXT, guideFields({ file: GUIDE_FILE, sha256 }), signature, trustedKeys);
}

// The newest of: the downloaded guide (only if signed), the one inside this app.
export function currentGuide(dir, { trustedKeys = TRUSTED_KEYS } = {}) {
  const builtin = parseGuide(foreverGuide());
  let downloaded = null;
  try {
    const bytes = fs.readFileSync(path.join(dir, GUIDE_FILE));
    const sig = fs.readFileSync(path.join(dir, GUIDE_SIG_FILE), 'utf8');
    if (signedGuide(bytes, sig, trustedKeys)) downloaded = validGuide(bytes.toString('utf8'));
  } catch { /* none yet, or no signature */ }
  if (downloaded) downloaded.source = 'descargada';
  if (builtin) builtin.source = 'incluida';
  return downloaded ? newer(downloaded, builtin) : builtin;
}

const daysBetween = (a, b) => Math.floor((Date.parse(b) - Date.parse(a)) / 86400000);

// "November 13, 2026"
export function longDate(iso) {
  const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const [y, mo, d] = iso.split('-').map(Number);
  return `${months[mo - 1]} ${d}, ${y}`;
}

const localIso = (now) => {
  const pad = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
};

// How fresh the guide is compared with today and with the player's game.
export function guideFreshness(guide, { now = new Date(), client = null } = {}) {
  const today = localIso(now);
  const age = guide ? daysBetween(guide.meta.date, today) : null;
  const gameBuild = Number(client?.build) || null;
  const gameNewer = Boolean(guide?.meta.build && gameBuild && gameBuild > guide.meta.build);
  return { today, age, gameBuild, gameVersion: client?.version || null, gameNewer, stale: age !== null && age > STALE_DAYS };
}

// Prompt section: today's date, the guide's date and whether the game changed since.
export function freshnessSection(guide, opts = {}) {
  const f = guideFreshness(guide, opts);
  const lines = [`## Date and version\nToday is ${longDate(f.today)}. Use this date for everything that depends on the calendar (raids, events, patches): what the guide announces for a date that has passed has already happened.`];
  if (guide) {
    const ver = guide.meta.gameVersion ? ` for game version ${guide.meta.gameVersion}${guide.meta.build ? ` (build ${guide.meta.build})` : ''}` : '';
    lines.push(`The WoW Forever base guide was last reviewed on ${longDate(guide.meta.date)}${ver}.`);
  }
  if (f.gameVersion) lines.push(`The player has version ${f.gameVersion}${f.gameBuild ? ` (build ${f.gameBuild})` : ''}.`);
  if (f.gameNewer || f.stale) {
    const why = f.gameNewer ? 'Blizzard updated the game after the guide' : `the guide is ${f.age} days old`;
    lines.push(`Warning: ${why}, so there may be changes it doesn't include. For facts that change with patches (levels, loot, rewards, class tuning, dates, events), the most recent information wins: if you can search the internet, check before stating them; if not, say they may have changed.`);
  } else {
    lines.push('If the internet shows something more recent that contradicts the guide, the most recent information wins.');
  }
  return lines.join('\n');
}

// Downloads the published guide now and then. Keeps it only if it is valid,
// signed with a trusted key and newer than what the app already has.
// sigUrl: its signature (default: the guide's address + ".sig").
// Returns { check(reason), stop() }.
export function startGuideUpdates({
  url, sigUrl = url ? `${url}.sig` : null, dir, log = () => {}, intervalMs = 6 * 3600000, fetchImpl = fetch,
  onUpdate = () => {}, trustedKeys = TRUSTED_KEYS,
}) {
  if (!url || !trustedKeys?.length) return { check: async () => false, stop() {} };
  const etagFile = path.join(dir, `${GUIDE_FILE}.etag`);
  let busy = null;
  let lastAt = 0;

  async function download() {
    const headers = {};
    try { headers['if-none-match'] = fs.readFileSync(etagFile, 'utf8'); } catch { /* first time */ }
    const res = await fetchImpl(url, { headers, signal: AbortSignal.timeout(20000) });
    if (res.status === 304) return false;
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    if (Number(res.headers.get('content-length')) > MAX_BYTES) throw new Error('the downloaded file is not a valid guide');
    // Exactly the bytes that were signed.
    const bytes = Buffer.from(await res.arrayBuffer());
    const guide = validGuide(bytes.toString('utf8'));
    if (!guide) throw new Error('the downloaded file is not a valid guide');
    const sigRes = await fetchImpl(sigUrl, { signal: AbortSignal.timeout(20000) });
    if (!sigRes.ok) throw new Error(`the guide has no signature (HTTP ${sigRes.status})`);
    const signature = await readSmall(sigRes);
    if (!signedGuide(bytes, signature, trustedKeys)) throw new Error('the guide is not signed with this project\'s key');
    const have = currentGuide(dir, { trustedKeys });
    if (have && guide.meta.date <= have.meta.date) return false;
    fs.mkdirSync(dir, { recursive: true });
    const tmp = path.join(dir, `${GUIDE_FILE}.tmp`);
    const sigTmp = path.join(dir, `${GUIDE_SIG_FILE}.tmp`);
    fs.writeFileSync(tmp, bytes);
    fs.writeFileSync(sigTmp, signature);
    fs.renameSync(sigTmp, path.join(dir, GUIDE_SIG_FILE));
    fs.renameSync(tmp, path.join(dir, GUIDE_FILE));
    const etag = res.headers.get('etag');
    if (etag) fs.writeFileSync(etagFile, etag);
    log(`WoW Forever guide updated (${guide.meta.date}).`);
    onUpdate(guide);
    return true;
  }

  // reason "patch": the game is newer than the guide; at most every 30 minutes.
  function check(reason = 'timer') {
    if (busy) return busy;
    if (reason === 'patch' && Date.now() - lastAt < 30 * 60000) return Promise.resolve(false);
    lastAt = Date.now();
    busy = download()
      .catch((e) => { log(`Could not update the WoW Forever guide: ${e.message}`); return false; })
      .finally(() => { busy = null; });
    return busy;
  }

  const first = setTimeout(() => check('start'), 5000);
  const timer = setInterval(() => check('timer'), intervalMs);
  timer.unref?.();
  first.unref?.();
  return { check, stop() { clearTimeout(first); clearInterval(timer); } };
}
