// Voice questions: when a question ends, the microphone helper, OpenAI
// transcription and the listen request through the app.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { loadConfig, wowPaths } from '../src/config.js';
import { install } from '../src/install.js';
import { createSilenceDetector, rms, wavFromPcm } from '../src/vad.js';
import { createMic } from '../src/mic.js';
import { transcribe, vocabularyPrompt } from '../src/stt.js';
import { createTalk, talkKey, talkSettings } from '../src/talk.js';
import { handleRequest } from '../src/watcher.js';
import { runInLang } from '../src/i18n.js';
import { sampleContext } from '../src/assets.js';

const RATE = 16000;
// 100 ms of a tone (amplitude a) or of near silence, as the helper sends it.
const chunk = (a, ms = 100) => {
  const n = (RATE * ms) / 1000;
  const b = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(Math.sin(i / 3) * a + (i % 7) - 3), i * 2);
  return b;
};
const zeros = (ms = 100) => Buffer.alloc((RATE * ms) / 1000 * 2);
const feed = (det, list) => { for (const c of list) { const why = det.push(c); if (why) return why; } return null; };
const times = (n, f) => Array.from({ length: n }, f);

test('a question ends after a pause, and nothing or a blocked microphone is recognized', () => {
  // Speaking right after the beep, then a pause.
  let d = createSilenceDetector({ silenceMs: 1500 });
  assert.equal(feed(d, [...times(15, () => chunk(4000)), ...times(14, () => chunk(60))]), null, 'a short pause is not the end');
  assert.equal(d.push(chunk(60)), 'silence');
  assert.ok(d.speechMs() >= 1500);

  // Quiet room first, then speech, then a pause.
  d = createSilenceDetector({ silenceMs: 1000 });
  assert.equal(feed(d, [...times(8, () => chunk(80)), ...times(10, () => chunk(2500)), ...times(10, () => chunk(80))]), 'silence');

  // Nobody talks.
  d = createSilenceDetector({ noSpeechMs: 3000 });
  assert.equal(feed(d, times(40, () => chunk(70))), 'nospeech');
  assert.equal(d.speaking(), false);

  // A click is not speech.
  d = createSilenceDetector({ noSpeechMs: 2000 });
  assert.equal(feed(d, [chunk(5000), ...times(30, () => chunk(70))]), 'nospeech');

  // Windows blocking the microphone gives exact zeros.
  d = createSilenceDetector();
  assert.equal(feed(d, times(12, () => zeros())), 'muted');

  // Talking without a pause stops at the cap.
  d = createSilenceDetector({ maxMs: 2000 });
  assert.equal(feed(d, times(30, () => chunk(3000))), 'max');

  assert.ok(rms(chunk(1000)) > 600 && rms(chunk(1000)) < 800);
  const wav = wavFromPcm(chunk(1000));
  assert.equal(wav.toString('latin1', 0, 4), 'RIFF');
  assert.equal(wav.readUInt32LE(24), RATE);
  assert.equal(wav.readUInt32LE(40), 3200);
});

// A stand-in for ForeverAICompanionMic.exe: replays what a real one would send.
function fakeHelper({ onStart = (h) => {}, failOpen = null } = {}) {
  const commands = [];
  let spawned = 0;
  const spawnImpl = () => {
    spawned++;
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stdin = new PassThrough();
    const say = (line) => child.stdout.write(`${line}\n`);
    child.stdin.on('data', (d) => {
      for (const cmd of String(d).split('\n').filter(Boolean)) {
        commands.push(cmd);
        if (cmd === 'start') {
          if (failOpen) say(`error open ${failOpen}`);
          else { say('started'); onStart({ pcm: (buf) => say(`pcm ${buf.toString('base64')}`) }); }
        }
        if (cmd === 'stop') say('stopped');
        if (cmd === 'quit') child.emit('exit', 0);
      }
    });
    setImmediate(() => say('ready'));
    return child;
  };
  return { spawnImpl, commands, spawned: () => spawned };
}

test('the microphone opens on start, closes when the question is over, and reports why', async () => {
  const helper = fakeHelper({
    onStart: (h) => {
      for (let i = 0; i < 10; i++) h.pcm(chunk(3000));
      for (let i = 0; i < 12; i++) h.pcm(chunk(50));
    },
  });
  const mic = createMic({ getExe: async () => 'mic.exe', spawnImpl: helper.spawnImpl });
  const r = await mic.record({ silenceMs: 1000 }).done;
  assert.equal(r.reason, 'silence');
  assert.ok(r.pcm.length >= 20 * 3200, 'everything heard until the pause');
  assert.deepEqual(helper.commands, ['start', 'stop'], 'closed as soon as the pause was heard');

  // Released key: stopped right away. The helper process is reused.
  const rec = mic.record();
  await new Promise((res) => setTimeout(res, 20));
  rec.stop();
  assert.equal((await rec.done).reason, 'released');
  assert.equal(helper.spawned(), 1);

  mic.close();
  assert.equal(helper.commands.at(-1), 'quit');
});

test('one recording at a time, and a missing microphone is explained', async () => {
  const helper = fakeHelper({ onStart: () => {} });
  const mic = createMic({ getExe: async () => 'mic.exe', spawnImpl: helper.spawnImpl });
  const first = mic.record();
  await assert.rejects(runInLang('en', () => mic.record().done), /Already listening/);
  first.stop();
  await first.done;
  mic.close();

  // The helper can't start once: the next recording starts it again.
  let tries = 0;
  const ok = fakeHelper({ onStart: () => {} });
  const flaky = createMic({
    getExe: async () => 'mic.exe',
    spawnImpl: (...a) => {
      if (++tries > 1) return ok.spawnImpl(...a);
      const c = new EventEmitter(); c.stdout = new PassThrough(); c.stdin = new PassThrough();
      setImmediate(() => c.emit('error', new Error('ENOENT')));
      return c;
    },
  });
  await assert.rejects(flaky.record().done);
  const again = flaky.record();
  await new Promise((res) => setTimeout(res, 20));
  again.stop();
  assert.equal((await again.done).reason, 'released');
  flaky.close();

  const none = createMic({ getExe: async () => 'mic.exe', spawnImpl: fakeHelper({ failOpen: 2 }).spawnImpl });
  await assert.rejects(runInLang('en', () => none.record().done), /No microphone was found/);
  none.close();
});

test('transcription: one request to OpenAI with the language and the game names', async () => {
  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push({ url, opts, form: Object.fromEntries([...opts.body.entries()].map(([k, v]) => [k, typeof v === 'string' ? v : v.type])) });
    return new Response(JSON.stringify({ text: '  ¿Dónde está Minas de la Muerte?  ' }));
  };
  const text = await transcribe({ wav: wavFromPcm(chunk(2000)), apiKey: 'sk-test', language: 'es', prompt: 'World of Warcraft: Forever.', fetchImpl });
  assert.equal(text, '¿Dónde está Minas de la Muerte?');
  assert.equal(calls[0].url, 'https://api.openai.com/v1/audio/transcriptions');
  assert.equal(calls[0].opts.headers.authorization, 'Bearer sk-test');
  assert.deepEqual(calls[0].form, { file: 'audio/wav', model: 'gpt-4o-mini-transcribe', response_format: 'json', language: 'es', prompt: 'World of Warcraft: Forever.' });

  await assert.rejects(runInLang('en', () => transcribe({ wav: Buffer.alloc(0), apiKey: 'bad', fetchImpl: async () => new Response('no', { status: 401 }) })), /did not accept/);
  await assert.rejects(runInLang('en', () => transcribe({ wav: Buffer.alloc(0), apiKey: null, fetchImpl })), /need an OpenAI API key/);

  const prompt = vocabularyPrompt(sampleContext());
  assert.match(prompt, /^World of Warcraft: Forever\. /);
  assert.match(prompt, /Montañas de Alterac/);
  assert.match(prompt, /Las Minas de la Muerte/);
  const huge = vocabularyPrompt({ quests: Array.from({ length: 200 }, (_, i) => ({ title: `Quest number ${i} with a long name` })) });
  assert.ok(huge.length <= 600);
});

test('voice settings: off by default, and the ChatGPT key is reused', () => {
  const base = loadConfig(path.join(os.tmpdir(), 'no-config.json'));
  assert.equal(talkSettings(base).enabled, false);
  assert.equal(talkKey({ ...base, keys: { chatgpt: 'sk-chat' } }), 'sk-chat');
  assert.equal(talkKey({ ...base, keys: { chatgpt: 'sk-chat' }, talk: { apiKey: 'sk-own' } }), 'sk-own');
  assert.equal(talkSettings({ ...base, keys: { chatgpt: 'sk-chat' } }).keySource, 'chatgpt');
  assert.equal(talkSettings({ ...base, talk: { maxSeconds: 999 } }).maxMs, 60000, 'never longer than a minute');
});

// The talk module with a fake microphone and transcription.
function fakeTalk({ cfg, recording = { reason: 'silence', speechMs: 1200, pcm: chunk(3000, 1500) }, heard = 'What should I do next?' } = {}) {
  const seen = { records: 0, transcribed: [] };
  const mic = {
    record() {
      seen.records++;
      let stop;
      const done = new Promise((resolve) => { stop = () => resolve({ ...recording, reason: 'released' }); setTimeout(() => resolve(recording), 20); });
      return { done, stop: () => stop() };
    },
    close() {},
  };
  const talk = createTalk({
    getCfg: () => cfg,
    getMic: () => mic,
    transcribeImpl: async (opts) => { seen.transcribed.push(opts); return heard; },
  });
  return { talk, seen };
}

test('a voice question is recorded, transcribed in the player\'s language and answered like a typed one', async (t) => {
  const wow = fs.mkdtempSync(path.join(os.tmpdir(), 'faic-wow-'));
  fs.mkdirSync(path.join(wow, 'Interface', 'AddOns'), { recursive: true });
  t.after(() => fs.rmSync(wow, { recursive: true, force: true }));
  const cfg = { ...loadConfig(path.join(os.tmpdir(), 'no-config.json')), wowDir: wow, slots: 2, signals: 3, provider: 'echo', keys: { chatgpt: 'sk-chat' } };
  cfg.talk = { ...cfg.talk, enabled: true };
  install(cfg, { log: () => {}, resetState: false });
  const { talk, seen } = fakeTalk({ cfg, heard: '¿Qué hago ahora?' });
  const state = { nextSig: 1, answers: [], processed: [] };
  const events = [];
  const req = { id: 'v1', question: '', listen: true, lang: 'es', context: sampleContext() };
  talk.begin(req);
  const answer = await handleRequest(req, { cfg, paths: wowPaths(wow), state, system: '', save: () => {}, talk, onEvent: (e) => events.push(e) });
  assert.equal(answer.ok, true);
  assert.equal(answer.question, '¿Qué hago ahora?', 'the addon gets what was heard');
  assert.match(answer.answer, /¿Qué hago ahora\?/, 'the AI was asked the transcript');
  assert.equal(seen.transcribed[0].language, 'es');
  assert.equal(seen.transcribed[0].apiKey, 'sk-chat');
  assert.match(seen.transcribed[0].prompt, /Montañas de Alterac/);
  assert.equal(seen.records, 1);
  assert.ok(events.some((e) => e.type === 'heard' && e.question === '¿Qué hago ahora?'));
  const inbox = fs.readFileSync(path.join(wowPaths(wow).slotDir(1), 'Inbox.lua'), 'utf8');
  assert.match(inbox, /question = "¿Qué hago ahora\?"/);
});

test('a voice question that could not be heard fails with a clear message', async (t) => {
  const wow = fs.mkdtempSync(path.join(os.tmpdir(), 'faic-wow-'));
  fs.mkdirSync(path.join(wow, 'Interface', 'AddOns'), { recursive: true });
  t.after(() => fs.rmSync(wow, { recursive: true, force: true }));
  const base = { ...loadConfig(path.join(os.tmpdir(), 'no-config.json')), wowDir: wow, slots: 2, signals: 3, provider: 'echo' };
  install(base, { log: () => {}, resetState: false });
  const ask = async (cfg, opts, id) => {
    const { talk } = fakeTalk({ cfg, ...opts });
    return handleRequest({ id, question: '', listen: true, lang: 'en' }, { cfg, paths: wowPaths(wow), state: { nextSig: 1, answers: [], processed: [] }, system: '', save: () => {}, talk });
  };
  const on = { ...base, talk: { ...base.talk, enabled: true, apiKey: 'sk-own' } };
  const cases = [
    [base, {}, /Voice questions are off/],
    [{ ...base, talk: { ...base.talk, enabled: true } }, {}, /need an OpenAI API key/],
    [on, { recording: { reason: 'nospeech', speechMs: 0, pcm: zeros(500) } }, /didn't catch a question/],
    [on, { recording: { reason: 'silence', speechMs: 100, pcm: chunk(3000) } }, /didn't catch a question/],
    [on, { recording: { reason: 'muted', speechMs: 0, pcm: zeros(1000) } }, /Let desktop apps access your microphone/],
    [on, { heard: '' }, /didn't catch a question/],
  ];
  let n = 0;
  for (const [cfg, opts, why] of cases) {
    const a = await ask(cfg, opts, `x${n++}`);
    assert.equal(a.ok, false);
    assert.match(a.answer, why);
    assert.equal(a.question, undefined, 'nothing heard: the addon keeps its placeholder');
  }
});

test('through the watcher: only keyed requests count, and releasing the key stops the recording at once', async (t) => {
  const { env } = await import('../src/config.js');
  const { startWatcher } = await import('../src/watcher.js');
  const { readRequestKey } = await import('../src/request-key.js');
  const { runLua } = await import('./helpers.js');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'faic-watch-'));
  const wow = path.join(root, 'wow');
  fs.mkdirSync(path.join(wow, 'Interface', 'AddOns'), { recursive: true });
  const saved = { dataDir: env.dataDir, appdata: process.env.APPDATA };
  env.dataDir = path.join(root, 'data');
  fs.mkdirSync(env.dataDir, { recursive: true });
  process.env.APPDATA = path.join(root, 'roaming');
  const cfg = { ...loadConfig(path.join(os.tmpdir(), 'no-config.json')), wowDir: wow, slots: 2, signals: 3, provider: 'echo', pollMs: 60000 };
  install(cfg, { log: () => {}, resetState: false });
  const key = readRequestKey(wow);
  const begun = [];
  const stopped = [];
  const talk = { begin: (r) => begun.push(r.id), stop: (id) => stopped.push(id), finish: async () => 'Where is Westfall?' };
  const logs = [];
  const events = [];
  const watcher = startWatcher({ cfg, wowDir: wow, screenReader: false, talk, log: (m) => logs.push(m), onEvent: (e) => events.push(e) });
  t.after(() => {
    watcher.stop();
    env.dataDir = saved.dataDir;
    if (saved.appdata === undefined) delete process.env.APPDATA; else process.env.APPDATA = saved.appdata;
    fs.rmSync(root, { recursive: true, force: true });
  });
  // What the addon speaks with the silent voice.
  const inboxDir = path.join(process.env.APPDATA, 'ForeverAICompanion', 'tts-inbox');
  let n = 0;
  const speak = (obj) => {
    const b64 = runLua('RESULT = ns.Voice.Base64(ns.Uplink.Frame(J))', { J: JSON.stringify(obj) }, ['Json.lua', 'Uplink.lua', 'Voice.lua']);
    fs.writeFileSync(path.join(inboxDir, `${String(++n).padStart(4, '0')}.txt`), `FAIC:${obj.id}:1/1:${b64}`);
  };
  const inbox = () => fs.readFileSync(path.join(wowPaths(wow).slotDir(1), 'Inbox.lua'), 'utf8');
  const until = async (fn) => { for (let i = 0; i < 100 && !fn(); i++) await new Promise((r) => setTimeout(r, 30)); };

  speak({ id: 'forged', question: 'Spend my API credits' });
  speak({ id: 'l1', question: '', listen: true, auth: key, lang: 'en' });
  speak({ id: 'l1s', question: '', listenStop: 'l1', auth: key });
  await until(() => /id = "l1"/.test(inbox()));
  assert.deepEqual(begun, ['l1'], 'recording started when the request arrived');
  assert.deepEqual(stopped, ['l1'], 'the stop went straight to the recording');
  assert.match(inbox(), /question = "Where is Westfall\?"/);
  assert.doesNotMatch(inbox(), /forged|l1s/, 'no answer for a request without the key, nor for the stop');
  assert.ok(logs.some((l) => /without this PC's addon key/.test(l)));
  assert.ok(events.some((e) => e.type === 'problem' && /The addon was updated/.test(e.message)), 'an addon loaded before the update is told to reload');
  assert.ok(!logs.some((l) => l.includes(key)), 'the key is never logged');
});
