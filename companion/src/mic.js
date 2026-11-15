// The microphone for voice questions: a small helper program (mic/Mic.cs)
// compiled with the C# compiler that ships with Windows, like the tray icon.
// The helper only captures audio; this module decides when a question is over
// (vad.js) and hands back the samples. Nothing is written to disk.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import readline from 'node:readline';
import { err } from './i18n.js';
import { createSilenceDetector } from './vad.js';

const CSC = 'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe';
export const MIC_EXE = 'ForeverAICompanionMic.exe';

function run(file, args) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { windowsHide: true, timeout: 120000 }, (e, stdout, stderr) => {
      if (e) reject(new Error(`${path.basename(file)}: ${(stderr || stdout || e.message).trim()}`));
      else resolve(stdout);
    });
  });
}

// Compiles the helper when it is missing or its source changed.
export async function ensureMicExe({ source, dir }) {
  const exe = path.join(dir, MIC_EXE);
  const hash = crypto.createHash('sha256').update(source).digest('hex');
  const hashFile = `${exe}.source-sha256`;
  if (fs.existsSync(exe) && fs.existsSync(hashFile) && fs.readFileSync(hashFile, 'utf8') === hash) return exe;
  if (!fs.existsSync(CSC)) throw err('noCsc');
  fs.mkdirSync(dir, { recursive: true });
  const src = path.join(dir, 'Mic.cs');
  fs.writeFileSync(src, source);
  const fresh = path.join(dir, `.mic-${Date.now()}.exe`);
  try {
    await run(CSC, ['/nologo', '/codepage:65001', '/target:winexe', '/optimize+', `/out:${fresh}`, path.resolve(src)]);
    // A running helper keeps its exe open: an open file can still be renamed.
    if (fs.existsSync(exe)) {
      try { fs.rmSync(exe); } catch { fs.renameSync(exe, `${exe}.old-${Date.now()}`); }
    }
    fs.renameSync(fresh, exe);
    fs.writeFileSync(hashFile, hash);
  } finally {
    fs.rmSync(fresh, { force: true });
    fs.rmSync(src, { force: true });
  }
  for (const name of fs.readdirSync(dir)) {
    if (name.startsWith(`${MIC_EXE}.old-`)) { try { fs.rmSync(path.join(dir, name)); } catch { /* in use */ } }
  }
  return exe;
}

// Why opening the microphone failed (waveInOpen codes).
const OPEN_ERRORS = { 2: 'micMissing', 4: 'micBusy', 6: 'micMissing', 32: 'micMissing' };

// getExe(): path of the helper (compiled on first use). One recording at a
// time. record() -> { done: Promise<{ pcm, reason, speechMs }>, stop() }.
export function createMic({ getExe, spawnImpl = spawn, log = () => {} }) {
  let child = null;
  let ready = null;
  let current = null; // { chunks, detector, resolve, reject, stopping }

  function finish(fn) {
    const c = current;
    if (!c) return;
    current = null;
    fn(c);
  }

  async function ensureChild() {
    if (child && ready) return ready;
    const exe = await getExe();
    const proc = spawnImpl(exe, [], { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
    child = proc;
    ready = new Promise((resolve, reject) => {
      const rl = readline.createInterface({ input: proc.stdout });
      rl.on('line', (line) => {
        if (line === 'ready') return resolve();
        const c = current;
        if (!c) return;
        if (line.startsWith('pcm ')) {
          const chunk = Buffer.from(line.slice(4), 'base64');
          c.chunks.push(chunk);
          const why = c.detector.push(chunk);
          if (why && !c.stopping) stopCurrent(why);
        } else if (line === 'stopped') {
          finish((r) => r.resolve({ pcm: Buffer.concat(r.chunks), reason: r.reason, speechMs: r.detector.speechMs() }));
        } else if (line.startsWith('error ')) {
          const [, what, code] = line.split(' ');
          log(`Microphone: ${line.slice(6)}`);
          finish((r) => r.reject(err(what === 'open' ? OPEN_ERRORS[code] || 'micFailed' : 'micFailed', { code })));
        }
      });
      // Could not start (e.g. the exe is gone): the next recording tries again.
      proc.on('error', (e) => {
        if (child === proc) { child = null; ready = null; }
        reject(e);
      });
      proc.on('exit', () => {
        if (child === proc) { child = null; ready = null; }
        finish((r) => r.reject(err('micFailed', { code: 'exit' })));
        reject(new Error('the microphone helper stopped'));
      });
    });
    ready.catch(() => {});
    return ready;
  }

  const send = (cmd) => { try { child?.stdin.write(`${cmd}\n`); } catch { /* gone */ } };

  function stopCurrent(reason) {
    if (!current || current.stopping) return;
    current.stopping = true;
    current.reason = reason;
    send('stop');
  }

  return {
    busy: () => Boolean(current),
    record({ silenceMs = 1500, noSpeechMs = 6000, maxMs = 30000 } = {}) {
      if (current) return { done: Promise.reject(err('talkBusy')), stop() {} };
      const detector = createSilenceDetector({ silenceMs, noSpeechMs, maxMs });
      const done = new Promise((resolve, reject) => {
        current = { chunks: [], detector, resolve, reject, stopping: false, reason: null };
      });
      const me = current;
      ensureChild()
        .then(() => { if (current === me) send('start'); })
        .catch((e) => { if (current === me) finish((r) => r.reject(err('micFailed', { code: e.message }))); });
      // Safety net: never keep the microphone open past the cap.
      const guard = setTimeout(() => { if (current === me) stopCurrent('max'); }, maxMs + 2000);
      guard.unref?.();
      done.finally(() => clearTimeout(guard)).catch(() => {});
      return { done, stop: () => { if (current === me) stopCurrent('released'); } };
    },
    close() {
      if (current) stopCurrent('closed');
      send('quit');
      try { child?.stdin.end(); } catch { /* gone */ }
      child = null;
      ready = null;
    },
  };
}
