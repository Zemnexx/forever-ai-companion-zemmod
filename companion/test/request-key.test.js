// Requests are only accepted with a code made with this PC's request key
// (written into the addon folder): HMAC-SHA256 of the request's id.
import crypto from 'node:crypto';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config.js';
import { addonFiles } from '../src/assets.js';
import { install, writeAddonFiles } from '../src/install.js';
import {
  KEY_FILE, MAX_REQUEST_AGE_S, ensureRequestKey, hasRequestKey, readRequestKey, requestCode, requestKeyFile, requestKeyLua,
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

test('the key file loads in the addon, and only the code of the request\'s own, recent id is accepted', () => {
  const key = 'ab'.repeat(32);
  const out = runLua('local f = assert(load(SRC)); f("ForeverAICompanion", ns); RESULT = ns.requestKey', { SRC: requestKeyLua(key) }, []);
  assert.equal(out, key);
  const now = Date.now();
  const id = `${Math.floor(now / 1000)}0042`;
  const req = (fields) => ({ id, ...fields });
  assert.equal(requestCode(key, id), crypto.createHmac('sha256', key).update(id).digest('hex'));
  assert.equal(hasRequestKey(req({ auth: requestCode(key, id) }), key, { now }), true);
  assert.equal(hasRequestKey(req({ auth: requestCode(key, id).toUpperCase() }), key, { now }), false);
  assert.equal(hasRequestKey(req({ auth: key }), key, { now }), false, 'the key itself is never accepted (it would show on screen)');
  assert.equal(hasRequestKey(req({ auth: requestCode(key, `${id.slice(0, -1)}3`) }), key, { now }), false, 'another id\'s code');
  assert.equal(hasRequestKey(req({ auth: requestCode('cd'.repeat(32), id) }), key, { now }), false, 'another PC\'s key');
  assert.equal(hasRequestKey(req({}), key, { now }), false);
  assert.equal(hasRequestKey(req({ auth: 12345 }), key, { now }), false);
  assert.equal(hasRequestKey(req({ auth: requestCode(key, id) }), null, { now }), false, 'no key: nothing is accepted');
  // The end of a voice question's recording ("<id>s").
  assert.equal(hasRequestKey({ id: `${id}s`, auth: requestCode(key, `${id}s`) }, key, { now }), true);
  // Ids not made by the addon, and old ones (a recording replayed), are refused.
  for (const other of ['abc', 'l1', `${id}x`, `9${id}`]) {
    assert.equal(hasRequestKey({ id: other, auth: requestCode(key, other) }, key, { now }), false, other);
  }
  const old = `${Math.floor(now / 1000) - MAX_REQUEST_AGE_S - 60}0042`;
  assert.equal(hasRequestKey({ id: old, auth: requestCode(key, old) }, key, { now }), false, 'older than a day');
});
