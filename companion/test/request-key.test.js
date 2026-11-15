// Requests are only accepted with this PC's request key (written into the addon folder).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config.js';
import { addonFiles } from '../src/assets.js';
import { install, writeAddonFiles } from '../src/install.js';
import {
  KEY_FILE, ensureRequestKey, hasRequestKey, readRequestKey, requestKeyFile, requestKeyLua,
} from '../src/request-key.js';
import { runLua } from './helpers.js';

const tempWow = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'faic-key-'));
  fs.mkdirSync(path.join(dir, 'Interface', 'AddOns'), { recursive: true });
  return dir;
};

test('each install gets its own key, kept across reinstalls and updates', (t) => {
  const wow = tempWow();
  t.after(() => fs.rmSync(wow, { recursive: true, force: true }));
  const cfg = { ...loadConfig(path.join(os.tmpdir(), 'no-config.json')), wowDir: wow, slots: 2, signals: 3 };
  install(cfg, { log: () => {}, resetState: false });
  const key = readRequestKey(wow);
  assert.match(key, /^[0-9a-f]{64}$/);
  assert.equal(ensureRequestKey(wow), key, 'not replaced once it exists');
  install(cfg, { log: () => {}, resetState: false });
  writeAddonFiles(wow, { ...addonFiles(), [KEY_FILE]: requestKeyLua('0'.repeat(64)) });
  assert.equal(readRequestKey(wow), key, 'reinstalling or updating the addon keeps it, even if a copy was bundled by mistake');
  assert.ok(!Object.keys(addonFiles()).includes(KEY_FILE), 'never shipped with the addon');
  const toc = fs.readFileSync(path.join(path.dirname(requestKeyFile(wow)), 'ForeverAICompanion.toc'), 'utf8');
  assert.ok(toc.indexOf(KEY_FILE) > toc.indexOf('Locale.lua') && toc.indexOf(KEY_FILE) < toc.indexOf('Core.lua'), 'loaded before Core.lua');

  const other = tempWow();
  t.after(() => fs.rmSync(other, { recursive: true, force: true }));
  assert.notEqual(ensureRequestKey(other), key, 'another PC or game folder has another key');
});

test('the key file loads in the addon, and only the exact key is accepted', () => {
  const key = 'ab'.repeat(32);
  const out = runLua('local f = assert(load(SRC)); f("ForeverAICompanion", ns); RESULT = ns.requestKey', { SRC: requestKeyLua(key) }, []);
  assert.equal(out, key);
  assert.equal(hasRequestKey({ auth: key }, key), true);
  assert.equal(hasRequestKey({ auth: key.slice(0, -1) + 'c' }, key), false);
  assert.equal(hasRequestKey({ auth: key.slice(0, 10) }, key), false);
  assert.equal(hasRequestKey({}, key), false);
  assert.equal(hasRequestKey({ auth: 12345 }, key), false);
  assert.equal(hasRequestKey({ auth: key }, null), false, 'no key: nothing is accepted');
});
