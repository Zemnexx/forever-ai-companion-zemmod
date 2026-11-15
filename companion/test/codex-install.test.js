// Codex: found however it was installed, and installed by the app when missing.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  codexAssetName, codexInstallState, codexSearchState, codexVersion, findCodex, installCodex, isDesktopApp, isOpenAISignature,
  ownCodexExe, pickCodexAsset, searchCodex, subjectOrganization, walkForCodex,
} from '../src/codex.js';

const touch = (file) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, 'x'); return file; };

test('the disk search finds Codex and skips what is not worth walking', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'faic-walk-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const deep = touch(path.join(root, 'tools', 'ai', 'codex', 'bin', 'codex.exe'));
  const npm = touch(path.join(root, 'npm', 'node_modules', '@openai', 'codex-win32-x64', 'vendor', 'codex.exe'));
  touch(path.join(root, 'npm', 'node_modules', 'left-pad', 'codex.exe')); // other packages are skipped
  touch(path.join(root, 'World of Warcraft', '_forever_', 'codex.exe')); // game folders are skipped
  touch(path.join(root, 'tools', 'codex-code-mode-host.exe')); // Codex helpers are not Codex
  const r = await walkForCodex([[root, 8]]);
  assert.deepEqual(r.found.sort(), [deep, npm].sort());
  assert.ok(r.complete);
  const shallow = await walkForCodex([[root, 1]]);
  assert.deepEqual(shallow.found, [], 'depth is respected');
});

test('Codex is found inside the open desktop app, which itself is never run', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'faic-app-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const app = touch(path.join(root, 'Codex', 'Codex.exe'));
  touch(path.join(root, 'Codex', 'ffmpeg.dll'));
  fs.mkdirSync(path.join(root, 'Codex', 'resources'), { recursive: true });
  const cli = touch(path.join(root, 'Codex', 'resources', 'bin', 'codex.exe'));
  assert.ok(isDesktopApp(app));
  assert.ok(!isDesktopApp(cli));
  const ran = [];
  const check = async (p) => { ran.push(p); return p === cli; };
  const found = await searchCodex({ running: async () => [app], check, roots: [], verify: async () => true });
  assert.equal(found, cli);
  assert.ok(!ran.includes(app), 'the desktop app is never started');
  assert.equal(codexSearchState().status, 'found');
  assert.equal(codexSearchState().runningApp, true);
});

test('nothing found: the window is told so', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'faic-none-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  touch(path.join(root, 'a', 'b', 'notes.txt'));
  const fakeOnly = touch(path.join(root, 'a', 'codex.exe')); // a file named codex.exe that isn't Codex
  const found = await searchCodex({ running: async () => [], check: async () => false, roots: [[root, 4]], verify: async () => true });
  // A real Codex elsewhere on this PC (usual places) could still be found.
  if (found) assert.notEqual(found, fakeOnly);
  else assert.equal(codexSearchState().status, 'notfound');
});

const isWin = process.platform === 'win32';
const CSC = 'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe';
const canBuildExe = isWin && fs.existsSync(CSC);

// A stand-in codex.exe that answers --version like the real one.
function fakeCodexExe(dir, name = 'codex.exe') {
  const src = path.join(dir, 'fake.cs');
  fs.writeFileSync(src, 'class P { static void Main(string[] a) { System.Console.WriteLine("codex-cli 9.9.9"); } }');
  const exe = path.join(dir, name);
  execFileSync(CSC, ['/nologo', `/out:${exe}`, src], { windowsHide: true });
  fs.rmSync(src);
  return exe;
}

// Points the user folders at a temp dir for the test.
function sandboxEnv(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'faic-codex-home-'));
  const saved = {};
  for (const k of ['LOCALAPPDATA', 'APPDATA', 'USERPROFILE', 'HOME', 'FAIC_INSTALL_DIR']) saved[k] = process.env[k];
  Object.assign(process.env, {
    LOCALAPPDATA: path.join(home, 'Local'), APPDATA: path.join(home, 'Roaming'), USERPROFILE: home, HOME: home,
    FAIC_INSTALL_DIR: path.join(home, 'Local', 'Programs', 'ForeverAICompanion'),
  });
  t.after(() => {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    fs.rmSync(home, { recursive: true, force: true });
  });
  return home;
}

test('a file found by the search runs only if Windows says OpenAI signed it', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'faic-sign-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const planted = touch(path.join(root, 'Downloads', 'codex.exe'));
  const launcher = touch(path.join(root, 'share', 'codex.cmd'));
  const odd = touch(path.join(root, 'codexsomething.exe'));
  const real = touch(path.join(root, 'tools', 'codex', 'codex.exe'));
  const ran = [];
  const logs = [];
  const found = await searchCodex({
    running: async () => [odd], roots: [[root, 4]], log: (m) => logs.push(m),
    verify: async (p) => p === real,
    check: async (p) => { ran.push(p); return true; },
  });
  assert.equal(found, real);
  assert.deepEqual(ran, [real], 'nothing else was started, not even with --version');
  assert.ok(logs.some((l) => l.includes(planted) && /not signed by OpenAI/.test(l)));
  assert.ok(!ran.includes(launcher), '.cmd launchers found on the disk are not run');

  // Windows' answer for the real codex.exe 0.169.0 (npm @openai/codex-win32-x64).
  const subject = 'CN="OpenAI OpCo, LLC", O="OpenAI OpCo, LLC", L=San Francisco, S=California, C=US';
  assert.equal(subjectOrganization(subject), 'OpenAI OpCo, LLC');
  assert.equal(isOpenAISignature({ status: 'Valid', subject }), true);
  assert.equal(isOpenAISignature({ status: 'HashMismatch', subject }), false, 'tampered after signing');
  assert.equal(isOpenAISignature({ status: 'NotSigned', subject: '' }), false);
  assert.equal(isOpenAISignature({ status: 'Valid', subject: 'CN=OpenAI OpCo, O=Evil Corp, C=US' }), false, 'the organization must match, not the common name');
  assert.equal(isOpenAISignature({ status: 'Valid', subject: 'CN=x, O="OpenAI OpCo, LLC Fans", C=US' }), false);
  assert.equal(isOpenAISignature(null), false);
});

test('only the official, checkable Codex build is downloaded', () => {
  const asset = (name, over = {}) => ({ name, size: 10, digest: `sha256:${'a'.repeat(64)}`, browser_download_url: `https://github.com/openai/codex/releases/download/rust-v1/${name}`, ...over });
  const rel = { tag_name: 'rust-v1', assets: [asset(codexAssetName('x64')), asset(codexAssetName('arm64'))] };
  assert.equal(codexAssetName('x64'), 'codex-x86_64-pc-windows-msvc.exe.tar.gz');
  assert.match(pickCodexAsset(rel, 'arm64').url, /aarch64/);
  assert.equal(pickCodexAsset({ ...rel, prerelease: true }, 'x64'), null);
  assert.equal(pickCodexAsset({ assets: [asset(codexAssetName('x64'), { digest: undefined })] }, 'x64'), null, 'no SHA-256, no install');
  assert.equal(pickCodexAsset({ assets: [asset(codexAssetName('x64'), { browser_download_url: 'https://evil.example/codex.tar.gz' })] }, 'x64'), null);
});

test('Codex installed with winget (or by this app) is found', { skip: !canBuildExe }, async (t) => {
  const home = sandboxEnv(t);
  // Nothing installed in the sandbox folders (a Codex on this PC's PATH may still be found).
  const before = findCodex(null);
  assert.ok(!before || ['path', 'config'].includes(before.source));

  const links = path.join(home, 'Local', 'Microsoft', 'WinGet', 'Links');
  fs.mkdirSync(links, { recursive: true });
  const exe = fakeCodexExe(links);
  const found = findCodex(null);
  if (found.source !== 'path') assert.deepEqual(found, { path: exe, source: 'winget' });
  assert.equal(await codexVersion(exe), '9.9.9');
  assert.equal(await codexVersion(path.join(home, 'nope.exe')), null);
});

test('the app installs the official Codex when it is missing, verified', { skip: !canBuildExe }, async (t) => {
  const home = sandboxEnv(t);
  // The release archive, as OpenAI publishes it.
  const build = fs.mkdtempSync(path.join(os.tmpdir(), 'faic-codex-build-'));
  t.after(() => fs.rmSync(build, { recursive: true, force: true }));
  fakeCodexExe(build, 'codex-x86_64-pc-windows-msvc.exe');
  const archive = path.join(build, 'codex.tar.gz');
  execFileSync(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe'), ['-czf', archive, '-C', build, 'codex-x86_64-pc-windows-msvc.exe'], { windowsHide: true });
  const bytes = fs.readFileSync(archive);
  const sha = crypto.createHash('sha256').update(bytes).digest('hex');
  const release = (digest) => ({
    tag_name: 'rust-v9.9.9',
    assets: [{ name: codexAssetName('x64'), size: bytes.length, digest: `sha256:${digest}`, browser_download_url: `https://github.com/openai/codex/releases/download/rust-v9.9.9/${codexAssetName('x64')}` }],
  });
  let published = release(sha);
  const fetchImpl = async (url) => (url.includes('api.github.com')
    ? new Response(JSON.stringify(published))
    : new Response(bytes, { headers: { 'content-length': String(bytes.length) } }));
  const pickAsset = (json) => pickCodexAsset(json, 'x64');

  // A tampered download is refused and nothing is installed.
  published = release('b'.repeat(64));
  await assert.rejects(installCodex({ fetchImpl, pickAsset, verify: async () => true }), /SHA-256/);
  assert.equal(codexInstallState().status, 'error');
  assert.ok(!fs.existsSync(ownCodexExe()));

  published = release(sha);
  // Right checksum but not signed by OpenAI: refused before it is installed or run.
  await assert.rejects(installCodex({ fetchImpl, pickAsset, verify: async () => false }), /not signed by OpenAI/);
  assert.ok(!fs.existsSync(ownCodexExe()));
  const r = await installCodex({ fetchImpl, pickAsset, verify: async () => true });
  assert.equal(r.path, ownCodexExe());
  assert.equal(r.version, '9.9.9');
  assert.equal(codexInstallState().status, 'done');
  assert.ok(ownCodexExe().startsWith(home));
  const found = findCodex(null);
  if (found.source !== 'path') assert.deepEqual(found, { path: ownCodexExe(), source: 'app' });
});
