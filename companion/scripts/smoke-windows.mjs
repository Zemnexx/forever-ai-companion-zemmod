// Smoke test of the built ForeverAICompanion.exe on Windows, the way a player
// uses it (run by .github/workflows/build-windows.yml after the build):
//   1. opening the exe installs it (into a test folder) and starts it;
//   2. the addon is installed into a stand-in WoW folder;
//   3. invisible sending: the silent voice is registered (administrator, like
//      on a PC) and a question is "spoken" with Windows' speech system, as WoW
//      does; the answer must reach the addon's inboxes;
//   4. updating: a stand-in GitHub offers a newer version; the app downloads,
//      checks and installs it, and starts again;
//   5. a screenshot of the app window in Edge (and the app keeps running
//      when that window closes);
//   6. uninstalling removes the addon and the voice.
//
//   node scripts/smoke-windows.mjs dist/ForeverAICompanion.exe <out folder>
//
// Nothing outside the test folders is left behind (the uninstall step removes
// the voice registration). Exits with an error at the first step that fails.
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { adler32 } from '../src/grid.js';

const exe = path.resolve(process.argv[2] || 'dist/ForeverAICompanion.exe');
const out = path.resolve(process.argv[3] || 'smoke-out');
fs.mkdirSync(out, { recursive: true });

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'faic-smoke-'));
const dataDir = path.join(root, 'data');
const installDir = path.join(root, 'install');
const wowDir = path.join(root, 'World of Warcraft', '_forever_');
fs.mkdirSync(path.join(wowDir, 'Interface', 'AddOns'), { recursive: true });
fs.mkdirSync(path.join(wowDir, 'WTF'), { recursive: true });
const addons = path.join(wowDir, 'Interface', 'AddOns');
const logFile = path.join(dataDir, 'forever-ai-companion.log');

const HEADER = { 'x-forever-ai-companion': '1', 'content-type': 'application/json' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const step = (msg) => console.log(`\n=== ${msg}`);
const ok = (msg) => console.log(`  OK  ${msg}`);

function fail(msg) {
  console.error(`  FAIL ${msg}`);
  try { console.error(`\n--- app log ---\n${fs.readFileSync(logFile, 'utf8')}`); } catch { /* no log yet */ }
  try { fs.copyFileSync(logFile, path.join(out, 'app.log')); } catch { /* none */ }
  try {
    console.error(`--- running: ${execFileSync('tasklist', ['/FI', 'IMAGENAME eq ForeverAICompanion.exe', '/FO', 'CSV', '/NH'], { encoding: 'utf8' }).trim()}`);
  } catch { /* no tasklist */ }
  for (const dir of [installDir, path.join(dataDir, 'updates')]) {
    try { console.error(`--- ${dir}: ${fs.readdirSync(dir).join(', ')}`); } catch { /* none */ }
  }
  process.exit(1);
}

// Any unexpected error: report it with the app's log, like a failed step.
process.on('uncaughtException', (e) => fail(`unexpected error: ${e.stack || e}`));
process.on('unhandledRejection', (e) => fail(`unexpected error: ${e?.stack || e}`));

async function until(what, fn, ms = 60000, every = 500) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { const v = await fn(); if (v) return v; } catch { /* not yet */ }
    await sleep(every);
  }
  return fail(`${what} (waited ${ms / 1000} s)`);
}

// Requests to the app on a fresh connection each time. (fetch reuses idle
// connections, and the app's server closes them after 5 s: a POST sent on one
// that just closed fails with ECONNRESET and is not retried. Browsers retry.)
function request(method, url, body = null, timeout = 300000) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const data = body === null ? null : Buffer.from(JSON.stringify(body));
    const req = http.request({
      host: u.hostname, port: u.port, path: u.pathname, method, agent: false, timeout,
      headers: { ...HEADER, ...(data ? { 'content-length': data.length } : {}) },
    }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { text += c; });
      res.on('end', () => {
        try { resolve({ ok: res.statusCode < 400, status: res.statusCode, json: JSON.parse(text) }); } catch (e) { reject(e); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('timed out')));
    req.on('error', reject);
    req.end(data);
  });
}

async function findApp() {
  for (let port = 47365; port < 47375; port++) {
    try {
      const r = await request('GET', `http://127.0.0.1:${port}/api/ping`, null, 800);
      if (r.json.app === 'ForeverAICompanion') return `http://127.0.0.1:${port}/`;
    } catch { /* not here */ }
  }
  return null;
}

const api = async (base, name, body = {}, timeout = 300000) => {
  const r = await request('POST', `${base}api/${name}`, body, timeout);
  if (!r.ok) throw new Error(`${name}: ${r.json.error || r.status}`);
  return r.json;
};
const status = async (base) => (await request('GET', `${base}api/status`)).json;
const log = () => { try { return fs.readFileSync(logFile, 'utf8'); } catch { return ''; } };

// A stand-in for GitHub's "latest release" answer, offering this same exe as 9.9.9.
const exeBytes = fs.readFileSync(exe);
const sha = crypto.createHash('sha256').update(exeBytes).digest('hex');
const gh = http.createServer((req, res) => {
  const port = gh.address().port;
  if (req.url === '/release') {
    res.end(JSON.stringify({
      tag_name: 'v9.9.9', draft: false, prerelease: false, html_url: 'http://127.0.0.1/notes',
      assets: [{ name: 'ForeverAICompanion.exe', size: exeBytes.length, digest: `sha256:${sha}`, browser_download_url: `http://127.0.0.1:${port}/exe` }],
    }));
  } else if (req.url === '/exe') {
    res.writeHead(200, { 'content-length': exeBytes.length });
    res.end(exeBytes);
  } else {
    res.writeHead(404).end();
  }
});
await new Promise((r) => gh.listen(0, '127.0.0.1', r));

const env = {
  ...process.env,
  FAIC_DATA_DIR: dataDir, FAIC_INSTALL_DIR: installDir, FAIC_NO_SHORTCUTS: '1', FAIC_WOW_DIR: wowDir,
  FAIC_PROVIDER: 'echo', FAIC_LANG: 'es', FAIC_UPDATE_API: `http://127.0.0.1:${gh.address().port}/release`,
};

// Screenshots of the app window with Edge (headless); each one opens and
// closes the page, like a player opening and closing the window.
async function screenshots(url, prefix) {
  const edge = ['C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'].find((p) => fs.existsSync(p));
  if (!edge) { console.log('  (Edge not found: no screenshot)'); return; }
  for (const [name, w, h] of [['window.png', 1000, 860], ['window-tall.png', 1000, 2200]]) {
    try {
      execFileSync(edge, ['--headless=new', '--disable-gpu', `--window-size=${w},${h}`, '--virtual-time-budget=8000',
        `--user-data-dir=${path.join(root, 'edge')}`, `--screenshot=${path.join(out, prefix + name)}`, url], { timeout: 120000, stdio: 'ignore' });
      ok(`${prefix}${name} saved`);
    } catch (e) {
      console.log(`  (screenshot failed: ${e.message})`);
    }
  }
}

// 1. Opening the downloaded exe ----------------------------------------------
step('1. Opening the exe: it installs itself and starts');
if (await findApp()) fail('another copy of the app is already running');
spawn(exe, ['--no-window'], { env, detached: true, stdio: 'ignore' }).unref();
const base = await until('the app answers on 127.0.0.1', findApp, 90000);
const installed = path.join(installDir, 'ForeverAICompanion.exe');
if (!fs.existsSync(installed)) fail(`not installed in ${installed}`);
ok(`installed in ${installed}, running at ${base}`);
let s = await status(base);
if (s.platform !== 'win32') fail(`platform is ${s.platform}`);
if (!s.wow.valid) fail('the WoW folder was not taken');
ok(`version ${s.version}, Windows, game folder found`);
await until('the icon next to the clock starts', async () => (await status(base)).tray, 60000);
ok('icon next to the clock (tray) running');
await api(base, 'close-action', { action: 'tray' }); // the Edge screenshot below closes a window

// 2. The addon ------------------------------------------------------------------
step('2. Installing the addon');
const inst = await api(base, 'install-addon');
s = await status(base);
if (!s.wow.addonInstalled) fail('the addon is not installed');
if (!fs.existsSync(path.join(addons, 'ForeverAICompanion', 'ForeverAICompanion.toc'))) fail('addon files missing');
if (!fs.existsSync(path.join(addons, 'ForeverAICompanion_S50', 'Inbox.lua'))) fail('inboxes missing');
ok(`addon ${s.wow.addonVersion} and its 50 inboxes installed (wowRunning=${inst.wowRunning})`);

// 3. Invisible sending, end to end ----------------------------------------------
step('3. Invisible sending: silent voice + a question spoken like WoW does');
const v = await api(base, 'voice-install', {}, 600000).catch((e) => fail(`voice install: ${e.message}`));
if (!v.active) fail('the voice is not visible to Windows after installing it');
ok('silent voice registered (administrator step done)');

const req = { id: 'smoke-voice-1', question: 'Hola desde la prueba de Windows', lang: 'es', context: { character: { name: 'Smoke', class: 'Hunter', level: 20, race: 'Dwarf' } }, history: [] };
const payload = Buffer.from(JSON.stringify(req), 'utf8');
const head = Buffer.alloc(8);
head.write('FAIC', 0, 'latin1');
head[4] = 1;
head[5] = (payload.length >> 16) & 255; head[6] = (payload.length >> 8) & 255; head[7] = payload.length & 255;
const sum = Buffer.alloc(4);
sum.writeUInt32BE(adler32(payload) >>> 0);
const message = `FAIC:${req.id}:1/1:${Buffer.concat([head, payload, sum]).toString('base64')}`;
// SAPI, like WoW: the voice is chosen from SAPI's own list, and the "audio"
// goes to a file (GitHub's machines have no sound device).
const voices = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-STA', '-Command', `
$ErrorActionPreference = 'Stop'
$v = New-Object -ComObject SAPI.SpVoice
$tokens = $v.GetVoices()
$names = @(); $ours = $null
for ($i = 0; $i -lt $tokens.Count; $i++) {
  $t = $tokens.Item($i); $n = $t.GetDescription(); $names += $n
  if ($n -like 'ForeverAICompanion*') { $ours = $t }
}
$names -join ', '
if (-not $ours) { throw 'SAPI does not list the ForeverAICompanion voice' }
$v.Voice = $ours
$fs = New-Object -ComObject SAPI.SpFileStream
$fs.Open($env:FAIC_WAV, 3, $false)
$v.AudioOutputStream = $fs
$v.Volume = 0
[void]$v.Speak($env:FAIC_MSG, 0)
$fs.Close()
'spoken'`], { env: { ...process.env, FAIC_MSG: message, FAIC_WAV: path.join(root, 'spoken.wav') }, encoding: 'utf8', timeout: 120000 });
console.log(`  voices: ${voices.trim().replace(/\s*\r?\n\s*/g, ' | ')}`);
const answered = await until('the answer reached the addon inboxes', () => {
  const file = path.join(addons, 'ForeverAICompanion_S01', 'Inbox.lua');
  return fs.existsSync(file) && fs.readFileSync(file, 'utf8').includes('smoke-voice-1');
}, 60000);
if (answered) ok('question received through the silent voice and answered into the inboxes');
if (!log().includes('Hola desde la prueba de Windows')) fail('the question is not in the app log');

// The window opened and closed right after the first start.
step('3b. The app window opens and closes (Edge) after the first start');
await screenshots(base, 'first-');
// Right away, while the app is handling the closed window (this order once
// lost the app without a trace on GitHub's machine).
const early = await api(base, 'update-check').catch((e) => fail(`the app stopped answering right after its window closed: ${e.message}`));
ok(`the app answers right after its window closed (update ${early.status})`);
await sleep(3000);
if (!(await findApp())) fail('the app closed after the Edge window closed (first start)');
ok('the app keeps running after its window closed');

// 4. Updating -------------------------------------------------------------------
step('4. Updating from GitHub (stand-in): download, check, replace, start again');
const u = await api(base, 'update-check');
if (u.status !== 'available' || u.latest !== '9.9.9') fail(`update not offered: ${JSON.stringify(u)}`);
ok('update 9.9.9 offered');
const before = log();
await api(base, 'update-install', {}, 600000);
await until('the updated app starts again', async () => {
  const now = log();
  return now.length > before.length && /Installed in/.test(now.slice(before.length)) && await findApp();
}, 120000);
if (!/downloaded and verified \(SHA-256\)/.test(log())) fail('the download was not verified');
ok('downloaded and verified (SHA-256), replaced and started again');
const base2 = await findApp();
s = await status(base2);
if (!s.wow.addonInstalled) fail('after updating, the addon is no longer seen');
ok(`running again at ${base2}, settings kept`);
fs.writeFileSync(path.join(out, 'app.log'), log());

// 5. The app window --------------------------------------------------------------
step('5. Screenshot of the app window (Edge), again after updating');
await screenshots(base2, '');
await sleep(3000); // the app hears that the page closed
if (!(await findApp())) fail('the app closed after the Edge window closed');
ok('the app keeps running after its window closed');
fs.writeFileSync(path.join(out, 'app.log'), log());

// 6. Uninstalling ---------------------------------------------------------------
step('6. Uninstalling');
await api(base2, 'uninstall', {}, 600000);
await until('the app closes', async () => !(await findApp()), 60000);
if (fs.existsSync(path.join(addons, 'ForeverAICompanion'))) fail('the addon is still there');
if (fs.existsSync(path.join(addons, 'ForeverAICompanion_S01'))) fail('the inboxes are still there');
let voiceLeft = true;
try {
  execFileSync('reg.exe', ['query', 'HKLM\\SOFTWARE\\Microsoft\\Speech\\Voices\\Tokens\\ForeverAICompanion', '/reg:64'], { stdio: 'ignore' });
} catch { voiceLeft = false; }
if (voiceLeft) fail('the voice is still registered');
ok('addon, inboxes, voice and settings removed; app closed');

gh.close();
console.log('\nAll steps passed.');
process.exit(0);
