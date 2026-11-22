// What the Armory keeps per character between requests, on this PC: the
// combat model and the stat weights of the last rotation simulation, so a
// gear plan can use measured weights and an idea can be tested against the
// same baseline without the game sending anything back.
import fs from 'node:fs';
import path from 'node:path';
import { env } from '../config.js';

const MAX_CHARACTERS = 40;
const storeFile = () => path.join(env.dataDir, 'armory.json');

export function loadArmoryStore(file = storeFile()) {
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
  } catch {
    return {};
  }
}

export function saveArmoryStore(store, file = storeFile()) {
  // Keep the characters used most recently.
  const keys = Object.keys(store);
  if (keys.length > MAX_CHARACTERS) {
    keys.sort((a, b) => (store[b]?.at || 0) - (store[a]?.at || 0));
    for (const k of keys.slice(MAX_CHARACTERS)) delete store[k];
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(store));
  fs.renameSync(tmp, file);
}

// An in-memory store for one run of the app, written through to disk.
export function openArmoryStore(file) {
  const store = loadArmoryStore(file);
  return {
    get: (charKey) => (charKey && Object.hasOwn(store, charKey) ? store[charKey] : null),
    set(charKey, patch) {
      if (!charKey) return;
      store[charKey] = { ...(Object.hasOwn(store, charKey) ? store[charKey] : {}), ...patch, at: Date.now() };
      try { saveArmoryStore(store, file); } catch { /* kept in memory for this run */ }
    },
  };
}
