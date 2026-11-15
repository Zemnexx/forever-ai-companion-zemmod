// API keys never reach config.json as plain text where Windows can encrypt them.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig, saveConfig } from '../src/config.js';
import { isSealed, revealSecrets, sealSecrets, setSecretProtector } from '../src/secrets.js';

// Stand-in for DPAPI: reversible, counts calls, and can refuse blobs from "another account".
function fakeDpapi() {
  const calls = { protect: 0, unprotect: 0 };
  return {
    calls,
    protect(values) { calls.protect++; return values.map((v) => `sealed:${Buffer.from(v).toString('base64')}:${Math.random()}`); },
    unprotect(blobs) {
      calls.unprotect++;
      return blobs.map((b) => (b.startsWith('sealed:') ? Buffer.from(b.split(':')[1], 'base64').toString() : null));
    },
  };
}

test('keys are saved encrypted, read back, and never written in plain text', (t) => {
  const dpapi = fakeDpapi();
  setSecretProtector(dpapi);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'faic-keys-'));
  t.after(() => { setSecretProtector(null); fs.rmSync(dir, { recursive: true, force: true }); });
  const file = path.join(dir, 'config.json');

  let cfg = saveConfig({ preset: 'claude', keys: { claude: 'sk-ant-secret-1234' } }, file);
  assert.equal(cfg.keys.claude, 'sk-ant-secret-1234');
  assert.equal(cfg.anthropic.apiKey, 'sk-ant-secret-1234', 'the provider gets the real key');
  const onDisk = fs.readFileSync(file, 'utf8');
  assert.ok(!onDisk.includes('sk-ant-secret-1234'), onDisk);
  assert.ok(isSealed(JSON.parse(onDisk).keys.claude));

  // Another setting changes: the stored key is kept as it is, not decrypted and re-encrypted.
  const before = dpapi.calls.protect;
  cfg = saveConfig({ closeAction: 'tray' }, file);
  assert.equal(cfg.keys.claude, 'sk-ant-secret-1234');
  assert.equal(dpapi.calls.protect, before);
  assert.equal(dpapi.calls.unprotect, 0, 'decrypted once per run (kept in memory)');

  // A second key joins the first.
  cfg = saveConfig({ keys: { chatgpt: 'sk-openai-5678' } }, file);
  assert.equal(cfg.keys.claude, 'sk-ant-secret-1234');
  assert.equal(cfg.keys.chatgpt, 'sk-openai-5678');
  assert.ok(!fs.readFileSync(file, 'utf8').includes('sk-openai-5678'));
});

test('plain-text keys from earlier versions are encrypted on the next start', (t) => {
  const dpapi = fakeDpapi();
  setSecretProtector(dpapi);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'faic-keys-'));
  t.after(() => { setSecretProtector(null); fs.rmSync(dir, { recursive: true, force: true }); });
  const file = path.join(dir, 'config.json');
  fs.writeFileSync(file, JSON.stringify({ preset: 'chatgpt', keys: { chatgpt: 'sk-old-plain' }, openai: { apiKey: 'sk-hand-written' } }));
  const cfg = loadConfig(file);
  assert.equal(cfg.keys.chatgpt, 'sk-old-plain');
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.ok(isSealed(saved.keys.chatgpt) && isSealed(saved.openai.apiKey));
  assert.ok(!JSON.stringify(saved).includes('sk-'), 'no key left in plain text');
  assert.equal(saved.preset, 'chatgpt', 'everything else unchanged');
});

test('a key this Windows account cannot decrypt counts as missing', () => {
  setSecretProtector(fakeDpapi());
  try {
    const { cfg, unreadable } = revealSecrets({ keys: { claude: { dpapi: 'from-another-pc' }, gemini: null } });
    assert.equal(cfg.keys.claude, null);
    assert.equal(unreadable, 1);
  } finally {
    setSecretProtector(null);
  }
});

test('if encryption fails, the key is not saved at all', (t) => {
  setSecretProtector({ protect() { throw new Error('DPAPI could not encrypt the key'); }, unprotect: (b) => b.map(() => null) });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'faic-keys-'));
  t.after(() => { setSecretProtector(null); fs.rmSync(dir, { recursive: true, force: true }); });
  const file = path.join(dir, 'config.json');
  assert.throws(() => saveConfig({ keys: { claude: 'sk-ant-never-on-disk' } }, file), /DPAPI/);
  assert.ok(!fs.existsSync(file) || !fs.readFileSync(file, 'utf8').includes('sk-ant-never-on-disk'));
  assert.deepEqual(sealSecrets({ wowDir: 'C:\\x' }), { wowDir: 'C:\\x' }, 'nothing to encrypt: nothing called');
});
