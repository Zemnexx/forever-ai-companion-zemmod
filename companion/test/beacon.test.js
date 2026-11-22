// The app's status for the game: sig/*.wav files that play (a silent WAV) or
// not (empty), read by the addon (Live:CheckApp).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { REASONS, createStatusFiles, startBeacon, statusFile } from '../src/beacon.js';
import { wowPaths } from '../src/config.js';
import { ensureAddon, install } from '../src/install.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'faic-beacon-'));
const playing = (p, name) => fs.statSync(statusFile(p, name)).size > 0;
const snapshot = (p) => Object.fromEntries(['st', 'beat1', 'beat2', ...REASONS].map((n) => [n, playing(p, n)]));

test('the installer creates every status file: only the marker plays', () => {
  const dir = tmp();
  try {
    const cfg = { slots: 2, signals: 3 };
    install(cfg, { wowDir: dir, log: () => {}, resetState: false, wowRunning: false });
    const p = wowPaths(dir);
    assert.deepEqual(snapshot(p), { st: true, beat1: false, beat2: false, 'need-ai': false, 'need-login': false, problem: false });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the addon follows the app\'s files even while its version stays the same', () => {
  const dir = tmp();
  try {
    const cfg = { slots: 2, signals: 3 };
    install(cfg, { wowDir: dir, log: () => {}, resetState: false, wowRunning: false });
    const p = wowPaths(dir);
    const file = path.join(p.addonDir, 'Live.lua');
    const original = fs.readFileSync(file, 'utf8');
    const key = fs.readFileSync(path.join(p.addonDir, 'RequestKey.lua'), 'utf8');
    fs.writeFileSync(file, `${original}\n-- from an earlier test build`);
    const logs = [];
    assert.equal(ensureAddon(cfg, { wowDir: dir, wowRunning: false, log: (m) => logs.push(m) }), true);
    assert.equal(fs.readFileSync(file, 'utf8'), original, 'a version being tested keeps its number: the files follow the app all the same');
    assert.equal(fs.readFileSync(path.join(p.addonDir, 'RequestKey.lua'), 'utf8'), key, 'this PC\'s request key is left alone');
    assert.equal(logs.filter((m) => /replaced: its files were not the ones this app carries/.test(m)).length, 1);
    // Already the app's files: nothing is written again.
    logs.length = 0;
    assert.equal(ensureAddon(cfg, { wowDir: dir, wowRunning: false, log: (m) => logs.push(m) }), true);
    assert.equal(logs.filter((m) => /replaced|updated/.test(m)).length, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('updating an older install adds the missing status files and keeps the rest', () => {
  const dir = tmp();
  try {
    const cfg = { slots: 2, signals: 3 };
    install(cfg, { wowDir: dir, log: () => {}, resetState: false, wowRunning: false });
    const p = wowPaths(dir);
    for (const n of ['st', 'beat1', 'beat2', ...REASONS]) fs.rmSync(statusFile(p, n));
    fs.writeFileSync(statusFile(p, 'beat1'), Buffer.from('RIFF')); // something already there stays
    assert.equal(ensureAddon(cfg, { wowDir: dir, wowRunning: false }), true);
    assert.equal(playing(p, 'st'), true);
    assert.equal(playing(p, 'beat1'), true);
    assert.equal(playing(p, 'need-ai'), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the beat switches, the reason follows the app, and closing silences everything', () => {
  const dir = tmp();
  try {
    const p = wowPaths(dir);
    createStatusFiles(p);
    let reason = 'need-ai';
    const b = startBeacon({ paths: () => p, reason: () => reason, intervalMs: 60000 });
    const first = snapshot(p);
    assert.equal(first.beat1 !== first.beat2, true, 'exactly one beat plays');
    assert.equal(first['need-ai'], true);

    // refresh(): the reason changes now, the beat doesn't move.
    reason = 'need-login';
    b.refresh();
    const second = snapshot(p);
    assert.deepEqual([second.beat1, second.beat2], [first.beat1, first.beat2]);
    assert.deepEqual([second['need-ai'], second['need-login'], second.problem], [false, true, false]);

    reason = null;
    b.refresh();
    assert.deepEqual(REASONS.map((r) => playing(p, r)), [false, false, false], 'ready: no reason plays');

    b.stop();
    assert.deepEqual(snapshot(p), { st: true, beat1: false, beat2: false, 'need-ai': false, 'need-login': false, problem: false });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the beat switches on every tick', async () => {
  const dir = tmp();
  try {
    const p = wowPaths(dir);
    createStatusFiles(p);
    const b = startBeacon({ paths: () => p, reason: () => null, intervalMs: 30 });
    const seen = new Set();
    for (let i = 0; i < 12; i++) {
      await new Promise((r) => setTimeout(r, 15));
      const s = snapshot(p);
      assert.equal(s.beat1 && s.beat2, false, 'never both at once');
      if (s.beat1 || s.beat2) seen.add(s.beat1 ? 1 : 2);
    }
    b.stop();
    assert.deepEqual([...seen].sort(), [1, 2]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('no game folder, or an addon without status files: nothing is written', () => {
  const dir = tmp();
  try {
    const p = wowPaths(dir);
    const none = startBeacon({ paths: () => null, reason: () => null });
    none.stop();
    const old = startBeacon({ paths: () => p, reason: () => null });
    old.stop();
    assert.equal(fs.existsSync(p.sigDir), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
