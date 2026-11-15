import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LEGACY_NAME, env } from '../src/config.js';
import { probeReport, startProbeMonitor } from '../src/probe.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('probe monitor sees which files the game wrote, and how fast', async () => {
  const wow = fs.mkdtempSync(path.join(os.tmpdir(), 'faic-probe-'));
  env.dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'faic-data-'));
  const charDir = path.join(wow, 'WTF', 'Account', 'ACC', 'Forever', 'Sharp');
  fs.mkdirSync(charDir, { recursive: true });
  fs.mkdirSync(path.join(wow, 'Logs'), { recursive: true });
  const config = path.join(wow, 'WTF', 'Config.wtf');
  const addons = path.join(charDir, 'AddOns.txt');
  const macros = path.join(wow, 'WTF', 'Account', 'ACC', 'macros-cache.txt');
  fs.writeFileSync(config, 'SET gxMaximize "1"\n');
  fs.writeFileSync(addons, 'ForeverAICompanion: enabled\nForeverAICompanion_S50: enabled\n');
  fs.writeFileSync(macros, 'VER 3 0000 "OTRA" "INV"\nEND\n');

  const monitor = startProbeMonitor({ wowDir: wow, intervalMs: 50 });
  monitor.activate(); // the addon's "start recording" request
  try {
    const t = Math.floor(Date.now() / 1000);
    // The "game" writes two of the channels right away; the macro never.
    fs.writeFileSync(config, 'SET gxMaximize "1"\nSET faicProbe "FAIC-PROBE-1234"\n');
    fs.writeFileSync(addons, 'ForeverAICompanion: enabled\nForeverAICompanion_S50: disabled\n');
    await sleep(300);
    const probe = {
      token: '1234',
      actions: { cvar: t, addons: t, macro: t, chat: t, tts: t },
      results: { cvar: 'ok', addons: 'ok', macro: 'ok', chat: 'not available', tts: 'not available' },
      ttsVoices: [],
      flashClientIcon: true,
    };
    const { text, report } = await probeReport(probe, monitor);
    assert.equal(report.channels.cvar.works, true);
    assert.equal(report.channels.addons.works, true);
    assert.equal(report.channels.macro.works, false);
    assert.equal(report.channels.chat.works, false);
    assert.ok(report.channels.cvar.seconds < 3);
    assert.match(text, /Config\.wtf\): YES/);
    assert.match(text, /macros-cache\.txt\): NO/);
    assert.match(text, /^Invisible channel test results:/);
    assert.match(text, /the game answered: not available/, 'the addon\'s probe values are shown as sent');
    assert.ok(fs.existsSync(path.join(env.dataDir, 'probe-report.json')));

    // Real names reported by WoW Forever on the user's PC: classic (SAPI) voices.
    if (process.platform === 'win32') {
      const r2 = await probeReport({ ...probe, ttsVoices: [{ name: 'Microsoft Zira Desktop - English (United States)' }] }, monitor);
      if (r2.report.tts.windowsSapi.some((v) => /Zira Desktop/.test(v))) assert.equal(r2.report.tts.family, 'sapi');
    }
  } finally {
    monitor.stop();
  }
});

test('the probe still recognizes an addon from before the rename', async () => {
  const wow = fs.mkdtempSync(path.join(os.tmpdir(), 'faic-probe-'));
  const charDir = path.join(wow, 'WTF', 'Account', 'ACC', 'Forever', 'Sharp');
  fs.mkdirSync(charDir, { recursive: true });
  const config = path.join(wow, 'WTF', 'Config.wtf');
  const addons = path.join(charDir, 'AddOns.txt');
  fs.writeFileSync(config, 'SET gxMaximize "1"\n');
  fs.writeFileSync(addons, `${LEGACY_NAME}_S50: enabled\n`);
  const monitor = startProbeMonitor({ wowDir: wow, intervalMs: 50 });
  monitor.activate();
  try {
    await sleep(100);
    fs.writeFileSync(config, 'SET gxMaximize "1"\nSET aziaProbe "AZIA-PROBE-77"\n');
    fs.writeFileSync(addons, `${LEGACY_NAME}_S50: disabled\n`);
    await sleep(300);
    const cvar = monitor.events.find((e) => e.kind === 'cvar');
    const list = monitor.events.find((e) => e.kind === 'addons');
    assert.deepEqual(cvar?.tokens, ['77']);
    assert.equal(list?.slotDisabled, true);
  } finally {
    monitor.stop();
    fs.rmSync(wow, { recursive: true, force: true });
  }
});

test('the probe monitor is idle until a test starts, and stops by itself afterwards', async () => {
  const wow = fs.mkdtempSync(path.join(os.tmpdir(), 'faic-probe-'));
  fs.mkdirSync(path.join(wow, 'Logs'), { recursive: true });
  fs.mkdirSync(path.join(wow, 'WTF'), { recursive: true });
  const chat = path.join(wow, 'Logs', 'WoWChatLog.txt');
  const config = path.join(wow, 'WTF', 'Config.wtf');
  fs.writeFileSync(chat, 'old chat line\n'.repeat(1000));
  fs.writeFileSync(config, 'SET a "1"\n');
  const reads = [];
  const realRead = fs.readSync;
  fs.readSync = (fd, buf, off, len, pos) => { reads.push(len); return realRead(fd, buf, off, len, pos); };
  const monitor = startProbeMonitor({ wowDir: wow, intervalMs: 20, activeMs: 300 });
  try {
    // No test running: the game's files are not even opened.
    fs.appendFileSync(chat, 'FAIC-PROBE-1 private chat\n');
    await sleep(120);
    assert.equal(monitor.active(), false);
    assert.deepEqual(reads, []);
    assert.deepEqual(monitor.events, []);

    monitor.activate();
    assert.equal(monitor.active(), true);
    await sleep(40);
    const line = 'You whisper: FAIC-PROBE-42\n';
    fs.appendFileSync(chat, line);
    await sleep(120);
    assert.deepEqual(monitor.events.map((e) => e.tokens), [['42']]);
    assert.ok(reads.every((n) => n <= line.length), `only what was added to the chat log is read (${reads})`);

    await sleep(400);
    assert.equal(monitor.active(), false, 'stopped after activeMs');
    const before = reads.length;
    fs.appendFileSync(chat, 'FAIC-PROBE-43\n');
    await sleep(100);
    assert.equal(reads.length, before);
  } finally {
    fs.readSync = realRead;
    monitor.stop();
    fs.rmSync(wow, { recursive: true, force: true });
  }
});

test('the addon\'s "start recording" request turns the monitor on and is answered by the app, not the AI', async () => {
  const { loadConfig, wowPaths } = await import('../src/config.js');
  const { install } = await import('../src/install.js');
  const { handleRequest } = await import('../src/watcher.js');
  const wow = fs.mkdtempSync(path.join(os.tmpdir(), 'faic-wow-'));
  fs.mkdirSync(path.join(wow, 'Interface', 'AddOns'), { recursive: true });
  const cfg = { ...loadConfig(path.join(os.tmpdir(), 'no-config.json')), wowDir: wow, slots: 2, signals: 3, provider: 'nope' };
  install(cfg, { log: () => {}, resetState: false });
  let activated = 0;
  const probeMonitor = { activate: () => { activated++; }, active: () => true, scan: () => {}, events: [] };
  const state = { nextSig: 1, answers: [], processed: [] };
  try {
    const answer = await handleRequest({ id: 'p1', question: 'Invisible channel test: start recording', probeStart: '123', lang: 'en' },
      { cfg, paths: wowPaths(wow), state, system: '', save: () => {}, probeMonitor });
    assert.equal(activated, 1);
    assert.equal(answer.ok, true, 'no AI was asked (the provider "nope" does not exist)');
    assert.match(answer.answer, /Recording/);
  } finally {
    fs.rmSync(wow, { recursive: true, force: true });
  }
});
