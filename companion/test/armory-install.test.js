// The Armory addon travels with the app: a copy of its files is in this
// repository (scripts/sync-armory.js), the player installs it from the app's
// window, and from then on the app keeps it at its own version, like the
// main addon. Its analyses are asked as thorough and with the model the
// player chose for them.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ARMORY_ADDON, ARMORY_SRC, DEFAULTS, loadConfig, wowPaths } from '../src/config.js';
import { armoryFiles } from '../src/assets.js';
import {
  ARMORY_TOC, armoryBuildId, armoryDir, bundledArmoryVersion, ensureArmory, install, installArmory, installedArmoryBuild, installedArmoryVersion,
  sameArmoryFiles, stampedArmoryFiles, uninstall, uninstallArmory,
} from '../src/install.js';
import { ARMORY_EFFORTS, armoryConfig, armoryModel, armoryPatch } from '../src/armory/index.js';
import { createServer } from '../src/app/server.js';
import { SOURCE_FILE, armoryAddonFiles, armoryRepo } from '../scripts/sync-armory.js';
import { luaSyntaxError } from './helpers.js';

const tempWow = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'faic-armory-'));
  fs.mkdirSync(path.join(dir, 'Interface', 'AddOns'), { recursive: true });
  return dir;
};

test('the app carries the Armory: every file its .toc loads, and nothing else', () => {
  const files = armoryFiles();
  const toc = files[ARMORY_TOC];
  assert.ok(toc, 'the .toc is there');
  assert.match(toc, /^## Dependencies: ForeverAICompanion$/m);
  const listed = toc.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  assert.deepEqual(Object.keys(files).sort(), [ARMORY_TOC, ...listed].sort());
  for (const name of listed) assert.equal(luaSyntaxError(files[name], name), null, name);
  assert.match(bundledArmoryVersion(), /^\d+\.\d+\.\d+$/);
  // Where the copy came from.
  const source = JSON.parse(fs.readFileSync(SOURCE_FILE, 'utf8'));
  assert.equal(source.version, bundledArmoryVersion());
  assert.equal(source.files, Object.keys(files).length);
  assert.match(source.commit, /^[0-9a-f]{40}$/);
  assert.equal(source.uncommitted, undefined, 'copied from committed files');
});

test('the copy matches the Armory repository, when a checkout of it is at hand', (t) => {
  const repo = armoryRepo(null);
  if (!repo) return t.skip('no checkout of the Armory repository next to this one');
  assert.deepEqual(armoryFiles(), armoryAddonFiles(repo), 'run "node scripts/sync-armory.js" after changing the Armory');
});

test('installing copies the files next to the main addon; removing takes them away', (t) => {
  const wow = tempWow();
  t.after(() => fs.rmSync(wow, { recursive: true, force: true }));
  assert.equal(installedArmoryVersion(wow), null);
  const dir = installArmory(wow);
  assert.equal(dir, path.join(wowPaths(wow).addons, ARMORY_ADDON));
  assert.equal(dir, armoryDir(wow));
  assert.deepEqual(fs.readdirSync(dir).sort(), Object.keys(armoryFiles()).sort());
  assert.equal(installedArmoryVersion(wow), bundledArmoryVersion());
  assert.equal(fs.readFileSync(path.join(dir, 'Core.lua'), 'utf8'), fs.readFileSync(path.join(ARMORY_SRC, 'Core.lua'), 'utf8'));
  uninstallArmory(wow);
  assert.equal(fs.existsSync(dir), false);
  assert.equal(installedArmoryVersion(wow), null);
  // A copy of the app built without the Armory says so.
  assert.throws(() => installArmory(wow, { files: {} }), /does not carry the Forever AI Armory addon/);
});

test('an installed Armory follows the app\'s version; one that is not installed is left alone', (t) => {
  const wow = tempWow();
  t.after(() => fs.rmSync(wow, { recursive: true, force: true }));
  const logs = [];
  assert.equal(ensureArmory(wow, { log: (m) => logs.push(m) }), false);
  assert.equal(fs.existsSync(armoryDir(wow)), false, 'never installed without being asked');

  // An older version, with a file the newer one no longer has and a note of the player's.
  const old = { ...armoryFiles(), [ARMORY_TOC]: armoryFiles()[ARMORY_TOC].replace(/^## Version: .+$/m, '## Version: 0.0.1'), 'Gone.lua': '-- old', 'notes.txt': 'mine' };
  installArmory(wow, { files: old });
  assert.equal(installedArmoryVersion(wow), '0.0.1');
  assert.equal(ensureArmory(wow, { log: (m) => logs.push(m) }), true);
  assert.equal(installedArmoryVersion(wow), bundledArmoryVersion());
  assert.equal(fs.existsSync(path.join(armoryDir(wow), 'Gone.lua')), false, 'Lua files of the old version are removed');
  assert.equal(fs.readFileSync(path.join(armoryDir(wow), 'notes.txt'), 'utf8'), 'mine', 'anything else in the folder is left');
  assert.deepEqual(logs, [`Forever AI Armory updated to ${bundledArmoryVersion()}`]);
  // Already current: nothing is written.
  const before = fs.statSync(path.join(armoryDir(wow), 'Core.lua')).mtimeMs;
  assert.equal(ensureArmory(wow, { log: (m) => logs.push(m) }), true);
  assert.equal(fs.statSync(path.join(armoryDir(wow), 'Core.lua')).mtimeMs, before);
  assert.equal(logs.length, 1);

  // The same version with other contents (a test build keeps the number): replaced too.
  const core = armoryFiles()['Core.lua'];
  fs.writeFileSync(path.join(armoryDir(wow), 'Core.lua'), `${core}\n-- from an earlier test build`);
  fs.rmSync(path.join(armoryDir(wow), 'Scan.lua'));
  assert.equal(ensureArmory(wow, { log: (m) => logs.push(m) }), true);
  assert.equal(fs.readFileSync(path.join(armoryDir(wow), 'Core.lua'), 'utf8'), core);
  assert.equal(fs.existsSync(path.join(armoryDir(wow), 'Scan.lua')), true, 'a file that was missing is back');
  assert.equal(logs[1], `Forever AI Armory ${bundledArmoryVersion()} replaced: its files were not the ones this app carries`);
  assert.equal(ensureArmory(wow, { log: (m) => logs.push(m) }), true);
  assert.equal(logs.length, 2);
});

test('the app stamps the Armory it installs with a short id of its files', (t) => {
  const wow = tempWow();
  t.after(() => fs.rmSync(wow, { recursive: true, force: true }));
  const files = armoryFiles();
  const id = armoryBuildId(files);
  assert.match(id, /^[0-9a-f]{8}$/);
  assert.equal(armoryBuildId({ ...files }), id, 'the same files give the same id');
  assert.equal(armoryBuildId(Object.fromEntries(Object.entries(files).reverse())), id, 'in whatever order they come');
  assert.notEqual(armoryBuildId({ ...files, 'Core.lua': `${files['Core.lua']} ` }), id, 'one changed character gives another');
  assert.notEqual(armoryBuildId({ 'a.lua': 'bc' }), armoryBuildId({ 'a.luab': 'c' }), 'names and contents cannot run into each other');

  // The .toc as written: the stamp after the version line; nothing else changes.
  const toc = stampedArmoryFiles(files)[ARMORY_TOC];
  assert.match(toc, new RegExp(`^## Version: ${bundledArmoryVersion()}\\n## X-Build: ${id}$`, 'm'));
  assert.equal(toc.replace(`## X-Build: ${id}\n`, ''), files[ARMORY_TOC]);
  assert.equal(stampedArmoryFiles({ ...files, [ARMORY_TOC]: toc })[ARMORY_TOC].match(/X-Build/g).length, 1, 'never stamped twice');
  const crlf = stampedArmoryFiles({ ...files, [ARMORY_TOC]: files[ARMORY_TOC].replace(/\n/g, '\r\n') })[ARMORY_TOC];
  assert.ok(crlf.includes(`\r\n## X-Build: `), 'with the file\'s own line endings');

  installArmory(wow);
  assert.equal(installedArmoryBuild(wow), id);
  assert.equal(fs.readFileSync(path.join(armoryDir(wow), ARMORY_TOC), 'utf8'), toc);
  // A stamped copy is up to date: nothing is written on the next start.
  assert.equal(sameArmoryFiles(wow), true);
  const before = fs.statSync(path.join(armoryDir(wow), ARMORY_TOC)).mtimeMs;
  const logs = [];
  ensureArmory(wow, { log: (m) => logs.push(m) });
  assert.deepEqual(logs, []);
  assert.equal(fs.statSync(path.join(armoryDir(wow), ARMORY_TOC)).mtimeMs, before);
  // A real difference is still one, the .toc's included.
  fs.writeFileSync(path.join(armoryDir(wow), 'UI.lua'), '-- changed');
  assert.equal(sameArmoryFiles(wow), false);
  installArmory(wow);
  fs.writeFileSync(path.join(armoryDir(wow), ARMORY_TOC), files[ARMORY_TOC]);
  assert.equal(installedArmoryBuild(wow), null, 'a copy put there by hand has no stamp');
  assert.equal(sameArmoryFiles(wow), false);
  ensureArmory(wow);
  assert.equal(installedArmoryBuild(wow), id);
});

test('uninstalling the app takes the Armory with it', (t) => {
  const wow = tempWow();
  t.after(() => fs.rmSync(wow, { recursive: true, force: true }));
  const cfg = { ...loadConfig(path.join(os.tmpdir(), 'no-config.json')), wowDir: wow, slots: 2, signals: 3 };
  install(cfg, { log: () => {}, resetState: false });
  installArmory(wow);
  uninstall(cfg, wow);
  assert.deepEqual(fs.readdirSync(wowPaths(wow).addons), []);
});

test('the Armory can be asked as thorough as chosen, with a model of its own per AI option', () => {
  const base = { ...DEFAULTS, preset: 'claude-code', provider: 'claude-code', claudeCode: { ...DEFAULTS.claudeCode, model: 'sonnet' } };
  assert.deepEqual(ARMORY_EFFORTS, ['low', 'medium', 'high']);
  assert.equal(armoryModel(base), null);
  assert.equal(armoryConfig(base).claudeCode.model, 'sonnet', 'the chat\'s model unless another is chosen');
  assert.equal(armoryConfig(base).claudeCode.effort, 'high');

  // What the window sends becomes a change to the saved settings.
  assert.deepEqual(armoryPatch(base, { effort: 'medium', model: ' opus ' }), { armory: { effort: 'medium', models: { 'claude-code': 'opus' } } });
  assert.deepEqual(armoryPatch(base, { model: '' }), { armory: { models: { 'claude-code': null } } }, 'empty: back to the chat\'s model');
  assert.deepEqual(armoryPatch(base, { effort: 'low' }), { armory: { effort: 'low' } });
  assert.deepEqual(armoryPatch(base, {}), { armory: {} });
  assert.throws(() => armoryPatch(base, { effort: 'max' }), /Unknown option/);
  assert.throws(() => armoryPatch(base, { model: 'opus; rm -rf' }), /Unknown option/);
  assert.throws(() => armoryPatch(base, { model: 'x'.repeat(81) }), /Unknown option/);

  const chosen = { ...base, armory: { ...DEFAULTS.armory, effort: 'medium', models: { 'claude-code': 'opus', claude: 'claude-opus-5-5' } } };
  assert.equal(armoryModel(chosen), 'opus');
  const cfg = armoryConfig(chosen);
  assert.equal(cfg.claudeCode.model, 'opus');
  assert.equal(cfg.claudeCode.effort, 'medium');
  assert.equal(cfg.codex.model, 'opus', 'only the chosen option is ever asked');
  assert.equal(chosen.claudeCode.model, 'sonnet', 'the chat keeps its own');
  // Another AI option has its own choice, or none.
  const api = { ...chosen, preset: 'claude', provider: 'anthropic' };
  assert.equal(armoryConfig(api).anthropic.model, 'claude-opus-5-5');
  assert.equal(armoryModel({ ...chosen, preset: 'gemini', provider: 'openai' }), null);
  // Set up through config.json, without a preset: kept by provider.
  assert.deepEqual(armoryPatch({ ...base, preset: null, provider: 'openai' }, { model: 'llama3.3' }), { armory: { models: { openai: 'llama3.3' } } });
  assert.equal(armoryConfig({ ...base, preset: null, provider: 'openai', armory: { models: { openai: 'llama3.3' } } }).openai.model, 'llama3.3');
});

test('the window\'s Armory buttons reach the app', async () => {
  const calls = [];
  const controller = {
    status: async () => ({}),
    installArmory: () => { calls.push('install'); return { version: '0.1.0', wowRunning: false }; },
    uninstallArmory: () => { calls.push('uninstall'); return {}; },
    setArmory: (body) => { calls.push(body); return { effort: body.effort, model: null }; },
  };
  const server = createServer(controller);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const post = async (action, body) => (await fetch(`http://127.0.0.1:${server.address().port}/api/${action}`, {
    method: 'POST', headers: { 'x-forever-ai-companion': '1', 'content-type': 'application/json' }, body: JSON.stringify(body || {}),
  })).json();
  assert.deepEqual(await post('armory-install'), { version: '0.1.0', wowRunning: false });
  assert.deepEqual(await post('set-armory', { effort: 'medium', model: 'opus' }), { effort: 'medium', model: null });
  assert.deepEqual(await post('armory-uninstall'), {});
  assert.deepEqual(calls, ['install', { effort: 'medium', model: 'opus' }, 'uninstall']);
  server.close();
});
