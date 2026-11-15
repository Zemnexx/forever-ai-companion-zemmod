// Updating from inside the app: only newer, published, verified versions.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ASSET_NAME, REPO, SIG_ASSET_NAME, compareVersions, createUpdater, parseRelease } from '../src/updater.js';
import { UPDATE_CONTEXT, encodeSignature, signedMessage, updateFields } from '../src/signing.js';

const exeBytes = Buffer.concat([Buffer.from('MZ'), crypto.randomBytes(5000)]);
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
// The project's signing key (a throwaway one for the tests) and someone else's.
const keyPair = () => crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const project = keyPair();
const stranger = keyPair();
const trustedKeys = [project.publicKey.export({ type: 'spki', format: 'der' }).toString('base64')];
const signFor = (version, bytes = exeBytes, key = project.privateKey) => encodeSignature(crypto.sign('sha256',
  signedMessage(UPDATE_CONTEXT, updateFields({ file: ASSET_NAME, version, size: bytes.length, sha256: sha(bytes) })),
  { key, dsaEncoding: 'ieee-p1363' }));
const release = (version, over = {}) => ({
  tag_name: `v${version}`,
  draft: false,
  prerelease: false,
  html_url: `https://github.com/${REPO}/releases/tag/v${version}`,
  assets: [{
    name: ASSET_NAME,
    size: exeBytes.length,
    digest: `sha256:${sha(exeBytes)}`,
    browser_download_url: `https://github.com/${REPO}/releases/download/v${version}/${ASSET_NAME}`,
  }, {
    name: SIG_ASSET_NAME,
    size: 89,
    browser_download_url: `https://github.com/${REPO}/releases/download/v${version}/${SIG_ASSET_NAME}`,
  }],
  ...over,
});
const unsigned = (r) => ({ ...r, assets: r.assets.filter((a) => a.name !== SIG_ASSET_NAME) });

// GitHub stand-in: the releases API, the download and its signature.
function fakeGitHub({ latest, file = exeBytes, sig = (version) => signFor(version) }) {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    if (url.includes('api.github.com')) return new Response(JSON.stringify(latest()), { status: 200 });
    if (url.endsWith('.sig')) return new Response(sig(/\/v([^/]+)\//.exec(url)[1]), { status: 200 });
    return new Response(file, { status: 200, headers: { 'content-length': String(file.length) } });
  };
  return { fetchImpl, calls };
}

test('versions compare numerically', () => {
  assert.ok(compareVersions('1.10.0', '1.9.9') > 0);
  assert.ok(compareVersions('v1.7.0', '1.6.0') > 0);
  assert.equal(compareVersions('1.6.0', 'v1.6'), 0);
  assert.ok(compareVersions('1.6.0', '1.6.1') < 0);
});

test('only a published release from this project, with the exe, is trusted', () => {
  assert.equal(parseRelease(release('1.7.0')).sha256, sha(exeBytes));
  assert.equal(parseRelease(release('1.7.0', { prerelease: true })), null, 'no pre-releases');
  assert.equal(parseRelease(release('1.7.0', { draft: true })), null);
  const elsewhere = release('1.7.0');
  elsewhere.assets[0].browser_download_url = `https://evil.example/${ASSET_NAME}`;
  assert.equal(parseRelease(elsewhere), null, 'downloads only from this repository');
  const otherRepo = release('1.7.0');
  otherRepo.assets[0].browser_download_url = `https://github.com/someone/fork/releases/download/v1.7.0/${ASSET_NAME}`;
  assert.equal(parseRelease(otherRepo), null);
  assert.equal(parseRelease(release('1.7.0', { assets: [] })), null, 'no exe, no update');
});

test('a newer version is offered once, downloaded and verified', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'faic-upd-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'ForeverAICompanion-1.5.0.exe'), 'old download'); // cleaned at start
  let latest = release('1.6.0');
  const gh = fakeGitHub({ latest: () => latest });
  const announced = [];
  const u = createUpdater({ currentVersion: '1.6.0', dir, fetchImpl: gh.fetchImpl, intervalMs: 1e9, trustedKeys, onAvailable: (v) => announced.push(v) });
  t.after(() => u.stop());
  assert.deepEqual(fs.readdirSync(dir), [], 'old downloads removed');

  assert.equal((await u.check()).status, 'latest');
  latest = release('1.7.0');
  const s = await u.check();
  assert.equal(s.status, 'available');
  assert.equal(s.latest, '1.7.0');
  await u.check();
  assert.deepEqual(announced, ['1.7.0'], 'the notice is shown once per version');

  const file = await u.download();
  assert.equal(sha(fs.readFileSync(file)), sha(exeBytes));
  assert.equal(u.state().status, 'ready');
  assert.equal(u.state().progress, 100);
  assert.equal(await u.download(), file, 'not downloaded twice');
});

test('a download that does not match what GitHub published is thrown away', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'faic-upd-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const [file, why] of [
    [Buffer.concat([Buffer.from('MZ'), crypto.randomBytes(5000)]), /SHA-256/],
    [exeBytes.subarray(0, 100), /incomplete/],
  ]) {
    const gh = fakeGitHub({ latest: () => release('1.7.0'), file });
    const u = createUpdater({ currentVersion: '1.6.0', dir, fetchImpl: gh.fetchImpl, intervalMs: 1e9, trustedKeys });
    await u.check();
    await assert.rejects(u.download(), why);
    assert.equal(u.state().status, 'available', 'can try again');
    assert.deepEqual(fs.readdirSync(dir), [], 'nothing left behind');
    u.stop();
  }
  // Same size and no published digest, but not a Windows program.
  const notExe = Buffer.alloc(exeBytes.length, 0x41);
  const noDigest = release('1.7.0');
  delete noDigest.assets[0].digest;
  const gh = fakeGitHub({ latest: () => noDigest, file: notExe });
  const u = createUpdater({ currentVersion: '1.6.0', dir, fetchImpl: gh.fetchImpl, intervalMs: 1e9, trustedKeys });
  await u.check();
  await assert.rejects(u.download(), /not a Windows program/);
  u.stop();
});

test('only a build signed with the project\'s key, for that version, is installed', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'faic-upd-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const attempt = async ({ latest, sig, keys = trustedKeys }) => {
    const gh = fakeGitHub({ latest: () => latest, sig });
    const logs = [];
    const u = createUpdater({ currentVersion: '1.6.0', dir, fetchImpl: gh.fetchImpl, intervalMs: 1e9, trustedKeys: keys, log: (m) => logs.push(m) });
    try {
      const s = await u.check();
      if (s.status !== 'available') return { status: s.status, logs };
      try { await u.download(); return { status: 'installed', logs }; } catch (e) { return { status: 'refused', error: e.message, logs }; }
    } finally {
      u.stop();
    }
  };
  // Published without a signature (e.g. upstream builds): never offered.
  const plain = await attempt({ latest: unsigned(release('1.7.0')) });
  assert.equal(plain.status, 'latest');
  assert.ok(plain.logs.some((l) => /without a signature/.test(l)));
  // Signed by someone else, or the signature of an older build reused for a newer tag.
  for (const sig of [() => signFor('1.7.0', exeBytes, stranger.privateKey), () => signFor('1.6.5'), () => 'not a signature']) {
    const r = await attempt({ latest: release('1.7.0'), sig });
    assert.equal(r.status, 'refused');
    assert.match(r.error, /not signed with this project's key/);
    assert.deepEqual(fs.readdirSync(dir), [], 'nothing left behind to run');
  }
  // A copy with no trusted key accepts nothing.
  assert.equal((await attempt({ latest: release('1.7.0'), keys: [] })).status, 'refused');
  assert.equal((await attempt({ latest: release('1.7.0') })).status, 'installed');
});

test('no internet: it says so and keeps working', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'faic-upd-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const u = createUpdater({ currentVersion: '1.6.0', dir, intervalMs: 1e9, trustedKeys, fetchImpl: async () => { throw new Error('offline'); } });
  const s = await u.check();
  assert.equal(s.status, 'error');
  assert.match(s.error, /offline/);
  u.stop();
});
