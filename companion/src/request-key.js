// Every request from the addon carries this PC's request key, and the app
// ignores requests without it.
//
// Anything that can speak with the silent Windows voice can hand the app a
// request, including a web page using the browser's text-to-speech. A page
// can't read files on the PC, so a random key written into the addon's
// folder (RequestKey.lua, created by this app, never part of the addon's
// published files) tells the addon's requests apart from anything else.
// The same check covers the on-screen line and screenshots.
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

// True when the request carries `key`. Compared in constant time.
export function hasRequestKey(req, key) {
  const given = req && typeof req.auth === 'string' ? Buffer.from(req.auth) : null;
  const want = key ? Buffer.from(String(key)) : null;
  return Boolean(given && want && given.length === want.length && crypto.timingSafeEqual(given, want));
}
