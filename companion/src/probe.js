// Channel probe (/ia probar-canales): watches the files the WoW client might
// write when an addon asks it to, and builds a report of which "invisible"
// channels work on this PC and how fast.
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { env } from './config.js';

// AZIA / AzerothIA: what an addon from before the rename writes (it may still
// be loaded in a game that was running when the app updated).
const MARKER = /(?:FAIC|AZIA)-PROBE-(\d+)/g;
const SLOT_DISABLED = /(?:ForeverAICompanion|AzerothIA)_S50\s*:\s*disabled/i;

function listDir(dir) {
  try { return fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
}

// Files the client could write: Config.wtf, chat log, macro caches, addon lists.
export function candidateFiles(wowDir) {
  const files = [
    { kind: 'cvar', file: path.join(wowDir, 'WTF', 'Config.wtf') },
    { kind: 'chat', file: path.join(wowDir, 'Logs', 'WoWChatLog.txt') },
  ];
  const accounts = path.join(wowDir, 'WTF', 'Account');
  for (const acc of listDir(accounts).filter((d) => d.isDirectory())) {
    const accDir = path.join(accounts, acc.name);
    files.push({ kind: 'macro', file: path.join(accDir, 'macros-cache.txt') });
    files.push({ kind: 'cvar', file: path.join(accDir, 'config-cache.wtf') });
    for (const realm of listDir(accDir).filter((d) => d.isDirectory() && d.name !== 'SavedVariables')) {
      for (const ch of listDir(path.join(accDir, realm.name)).filter((d) => d.isDirectory())) {
        const chDir = path.join(accDir, realm.name, ch.name);
        files.push({ kind: 'macro', file: path.join(chDir, 'macros-cache.txt') });
        files.push({ kind: 'addons', file: path.join(chDir, 'AddOns.txt') });
        files.push({ kind: 'cvar', file: path.join(chDir, 'config-cache.wtf') });
      }
    }
  }
  return files;
}

// How long the monitor keeps watching after a test starts (or reports): the
// game may only write some of these files when the player logs out.
export const PROBE_ACTIVE_MS = 15 * 60000;
const TAIL_BYTES = 2_000_000;

// Watches candidate files and records when a probe marker shows up in them.
// Idle until activate(): it only runs while a channel test is going on (the
// addon asks for it first, see Probe.lua) and for activeMs after, then stops
// on its own. Only markers are kept, never what the files say.
export function startProbeMonitor({ wowDir, log = () => {}, intervalMs = 500, activeMs = PROBE_ACTIVE_MS, now = () => Date.now() }) {
  const events = [];
  const seen = new Map(); // file -> { mtime, size }
  let files = [];
  let lastList = 0;
  let first = true;
  let timer = null;
  let until = 0;

  const scan = () => {
    const t = now();
    if (timer && t > until) { pause(); return; }
    if (t - lastList > 5000 || first) { files = candidateFiles(wowDir); lastList = t; }
    for (const { kind, file } of files) {
      let st;
      try { st = fs.statSync(file); } catch { continue; }
      const prev = seen.get(file);
      seen.set(file, { mtime: st.mtimeMs, size: st.size });
      if (first || !prev || prev.mtime === st.mtimeMs) continue;
      let text;
      try {
        // The chat log only grows: read what was added. Other files are
        // rewritten whole: read their tail.
        const from = kind === 'chat' && st.size >= prev.size ? Math.max(prev.size, st.size - TAIL_BYTES) : Math.max(0, st.size - TAIL_BYTES);
        const len = st.size - from;
        const buf = Buffer.alloc(len);
        const fd = fs.openSync(file, 'r');
        try { fs.readSync(fd, buf, 0, len, from); } finally { fs.closeSync(fd); }
        text = buf.toString('latin1');
      } catch { continue; }
      const tokens = [...text.matchAll(MARKER)].map((m) => m[1]);
      const slotDisabled = kind === 'addons' && SLOT_DISABLED.test(text);
      if (tokens.length || slotDisabled) {
        const ev = { kind, file, time: t, tokens: [...new Set(tokens)], slotDisabled };
        events.push(ev);
        log(`Channel test: marked change in ${path.basename(file)} (${kind})`);
      }
    }
    first = false;
    while (events.length > 200) events.shift();
  };

  function pause() {
    clearInterval(timer);
    timer = null;
    first = true; // the next test starts from a fresh look at the files
    seen.clear();
    log('Channel test: stopped watching the game\'s files.');
  }

  // Starts watching (or keeps watching longer). The first look only notes
  // how the files are, so changes are counted from now on.
  function activate(ms = activeMs) {
    until = Math.max(until, now() + ms);
    if (timer) return;
    scan();
    timer = setInterval(scan, intervalMs);
    timer.unref?.();
  }

  return {
    events,
    scan,
    activate,
    active: () => Boolean(timer),
    stop: () => { clearInterval(timer); timer = null; },
  };
}

// Voices Windows offers: classic SAPI (third parties can add voices) and
// OneCore (Narrator voices, closed). Tells which family the game uses.
export function windowsVoices() {
  if (process.platform !== 'win32') return Promise.resolve({ sapi: [], onecore: [] });
  const script = `
$ErrorActionPreference = 'SilentlyContinue'
Add-Type -AssemblyName System.Speech
$s = New-Object System.Speech.Synthesis.SpeechSynthesizer
$sapi = @($s.GetInstalledVoices() | ForEach-Object { $_.VoiceInfo.Name })
$one = @(Get-ChildItem 'HKLM:\\SOFTWARE\\Microsoft\\Speech_OneCore\\Voices\\Tokens' | ForEach-Object { (Get-ItemProperty $_.PSPath).'(default)' })
[pscustomobject]@{ sapi = $sapi; onecore = $one } | ConvertTo-Json -Compress`;
  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script],
      { windowsHide: true, timeout: 20000, encoding: 'utf8' }, (err, stdout) => {
        try {
          const j = JSON.parse(stdout);
          resolve({ sapi: [].concat(j.sapi || []), onecore: [].concat(j.onecore || []) });
        } catch {
          resolve({ sapi: [], onecore: [], error: err?.message });
        }
      });
  });
}

const NAMES = {
  cvar: 'Custom setting variable (Config.wtf)',
  addons: 'Addon list (AddOns.txt)',
  macro: 'Macro (macros-cache.txt)',
  chat: 'Chat log (WoWChatLog.txt)',
};

// Builds the verdict for a probe request. Returns { text, report }.
// The monitor keeps watching a while longer for writes made at logout.
export async function probeReport(probe, monitor) {
  const wasActive = monitor.active();
  if (wasActive) monitor.scan();
  monitor.activate();
  const actions = probe.actions || {};
  const channels = {};
  for (const kind of Object.keys(NAMES)) {
    const at = (actions[kind] || 0) * 1000;
    const hit = monitor.events.find((e) => e.kind === kind && e.time >= at - 2000 &&
      (kind === 'addons' ? e.slotDisabled : e.tokens.includes(String(probe.token))));
    channels[kind] = {
      api: probe.results?.[kind] ?? 'not tested',
      works: Boolean(hit),
      seconds: hit ? Math.max(0, (hit.time - at) / 1000) : null,
      file: hit?.file,
    };
  }

  const voices = await windowsVoices();
  const gameVoices = (probe.ttsVoices || []).map((v) => v.name).filter(Boolean);
  // The game appends the language: "Microsoft Sabina Desktop - Spanish (Mexico)".
  const base = (n) => n.replace(/\s+-\s+.*$/, '').trim().toLowerCase();
  const sapi = new Set(voices.sapi.map(base));
  const onecore = new Set(voices.onecore.map(base));
  const inSapi = gameVoices.filter((n) => sapi.has(base(n)));
  const inOneCore = gameVoices.filter((n) => onecore.has(base(n)) && !sapi.has(base(n)));
  const tts = {
    api: probe.results?.tts ?? 'not tested',
    gameVoices,
    windowsSapi: voices.sapi,
    windowsOneCore: voices.onecore,
    family: inSapi.length ? 'sapi' : inOneCore.length ? 'onecore' : 'unknown',
  };

  const report = { at: new Date().toISOString(), token: probe.token, channels, tts, flashClientIcon: probe.flashClientIcon };
  try {
    fs.mkdirSync(env.dataDir, { recursive: true });
    fs.writeFileSync(path.join(env.dataDir, 'probe-report.json'), JSON.stringify(report, null, 2));
  } catch { /* report is also in the answer and the log */ }

  const lines = ['Invisible channel test results:'];
  for (const [kind, c] of Object.entries(channels)) {
    const verdict = c.works
      ? `YES, written after ${c.seconds.toFixed(1)} s`
      : `NO, not written during the test${c.api !== 'ok' ? ` (the game answered: ${c.api})` : ''}`;
    lines.push(`- ${NAMES[kind]}: ${verdict}`);
  }
  const fam = {
    sapi: 'classic Windows voices (a ForeverAICompanion voice can be added)',
    onecore: 'modern Windows voices (custom voices cannot be added)',
    unknown: 'could not be determined',
  }[tts.family];
  lines.push(`- Text to speech: ${gameVoices.length ? `${gameVoices.length} voices in the game, ${fam}` : 'the game offers no voices'}` +
    `${tts.api !== 'ok' ? ` (speak: ${tts.api})` : ''}`);
  lines.push(`- Icon flashing: ${probe.flashClientIcon ? 'available' : 'not available'}`);
  if (!wasActive) lines.push('The app was not recording when the test ran (an addon from an earlier version?): run the test again.');
  lines.push('If something says NO, the game may only save it when you log out: log out and the app will keep recording it.');
  return { text: lines.join('\n'), report };
}
