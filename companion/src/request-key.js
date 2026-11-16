// Every request from the addon carries a code made with this PC's request
// key, and the app ignores requests without a valid one.
//
// Any program that can speak with the silent Windows voice can hand the app
// a request (Chrome doesn't offer the voice to web pages; other programs
// using Windows' classic voices can). A random key written into the addon's
// folder (RequestKey.lua, created by this app, never part of the addon's
// published files) tells the addon's requests apart from anything else.
// The same check covers the on-screen line and screenshots.
//
// The key itself never travels: the code is HMAC-SHA256(key, the request's
// id) (Core:AuthCode in the addon), because the on-screen line can be seen
// by screenshots, recordings and streams. A code fits only its own id, the
// app answers an id once (state.processed), and an id holds the second it
// was made, so an old one is refused too.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { wowPaths } from './config.js';
import { writeAtomic } from './inbox.js';

export const KEY_FILE = 'RequestKey.lua';
const KEY_RE = /^ns\.requestKey\s*=\s*"([0-9a-f]{64})"\s*$/m;

export const requestKeyFile = (wowDir) => path.join(wowPaths(wowDir).addonDir, KEY_FILE);

export function requestKeyLua(key) {
  return [
    '-- Written by the Forever AI Companion app for this PC. Every request the',
    '-- addon sends carries this key, so the app ignores requests that did not',
    '-- come from this addon. Do not share it.',
    'local _, ns = ...',
    `ns.requestKey = "${key}"`,
    '',
  ].join('\n');
}

export function readRequestKey(wowDir) {
  try {
    return KEY_RE.exec(fs.readFileSync(requestKeyFile(wowDir), 'utf8'))?.[1] || null;
  } catch {
    return null;
  }
}

// The key in this addon folder, created the first time. Reinstalling and
// updating the addon keep it, so a game already running keeps working.
export function ensureRequestKey(wowDir) {
  const existing = readRequestKey(wowDir);
  if (existing) return existing;
  const key = crypto.randomBytes(32).toString('hex');
  const file = requestKeyFile(wowDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeAtomic(file, requestKeyLua(key));
  return key;
}

// The code for request `id` (lowercase hex).
export const requestCode = (key, id) => crypto.createHmac('sha256', String(key)).update(String(id)).digest('hex');

// Request ids: the second it was made and 4 random digits ("s" after it: the
// end of a voice question's recording).
const ID_RE = /^(\d{10})\d{4}s?$/;
export const MAX_REQUEST_AGE_S = 24 * 3600;

// True when the request carries the code of its own id, made with `key` in
// the last day. Compared in constant time.
export function hasRequestKey(req, key, { now = Date.now() } = {}) {
  if (!key || !req || typeof req.auth !== 'string' || typeof req.id !== 'string') return false;
  const made = ID_RE.exec(req.id);
  if (!made || Math.abs(now / 1000 - Number(made[1])) > MAX_REQUEST_AGE_S) return false;
  const given = Buffer.from(req.auth);
  const want = Buffer.from(requestCode(key, req.id));
  return given.length === want.length && crypto.timingSafeEqual(given, want);
}
