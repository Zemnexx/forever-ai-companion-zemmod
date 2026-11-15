// Codex (OpenAI's official CLI): lets players use their ChatGPT Plus / Pro
// plan. Finds it on this PC, checks the sign-in, helps install it and sign
// in, and turns it into a plain chat model (see codexArgs).
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import { spawnArgs, visibleConsole } from './claude-code.js';
import { t } from './i18n.js';
import { installDir, powershell } from './app/system.js';

const isWin = process.platform === 'win32';

// Models shown in the app window (slug -> name). "default" = the plan's default.
export const CODEX_MODELS = {
  'gpt-6.1-sol': 'GPT-6.1 Sol',
  'gpt-6-luna': 'GPT-6 Luna',
  'gpt-6-astra': 'GPT-6 Astra',
};

// --- Finding Codex ----------------------------------------------------------
// Codex can be installed many ways (OpenAI's installer, winget, npm, Scoop,
// this app...). Windows only gives a running program the PATH it had when it
// started, so the current PATH is also read from the registry: a Codex
// installed after the app was opened is found without restarting it.

// Where this app installs Codex itself (see installCodex).
export const ownCodexDir = () => path.join(installDir(), 'codex');
export const ownCodexExe = () => path.join(ownCodexDir(), 'codex.exe');

function registryPath() {
  if (!isWin) return [];
  const read = (key) => {
    try {
      const out = execFileSync('reg.exe', ['query', key, '/v', 'Path'], { encoding: 'utf8', windowsHide: true, timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] });
      const m = /\sPath\s+REG_(?:EXPAND_)?SZ\s+(.*)$/mi.exec(out);
      return m ? m[1].trim() : '';
    } catch {
      return '';
    }
  };
  const expand = (s) => s.replace(/%([^%]+)%/g, (all, name) => process.env[name] ?? all);
  return [read('HKCU\\Environment'), read('HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment')]
    .flatMap((v) => expand(v).split(';'));
}

let pathCache = { at: 0, dirs: [] };
function pathDirs() {
  if (Date.now() - pathCache.at > 15000) {
    const dirs = [...String(process.env.PATH || '').split(path.delimiter), ...registryPath()]
      .map((d) => d.trim().replace(/^"|"$/g, ''))
      .filter(Boolean);
    pathCache = { at: Date.now(), dirs: [...new Set(dirs.map((d) => d.toLowerCase()))].map((l) => dirs.find((d) => d.toLowerCase() === l)) };
  }
  return pathCache.dirs;
}

// Executables named like Codex inside `dir`, down to `depth` folders.
function findExe(dir, depth, names) {
  const out = [];
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isFile() && names.includes(e.name.toLowerCase())) out.push(p);
    else if (e.isDirectory() && depth > 0 && !/^(node_modules|\.git|cache|logs?)$/i.test(e.name)) out.push(...findExe(p, depth - 1, names));
  }
  return out;
}

const RELEASE_EXE = /^codex-(x86_64|aarch64)-pc-windows-msvc\.exe$/i;

// Every place a Codex install can be, most reliable first: [path, source].
export function codexCandidates(configured) {
  const out = [];
  if (configured && path.isAbsolute(configured)) out.push([configured, 'config']);
  if (!isWin) {
    for (const d of pathDirs()) out.push([path.join(d, 'codex'), 'path']);
    out.push([path.join(os.homedir(), '.local', 'bin', 'codex'), 'native']);
    return out;
  }
  const local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  const roaming = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  out.push([ownCodexExe(), 'app']);
  out.push([path.join(local, 'Programs', 'OpenAI', 'Codex', 'bin', 'codex.exe'), 'native']);
  for (const d of pathDirs()) {
    out.push([path.join(d, 'codex.exe'), 'path']);
    out.push([path.join(d, 'codex.cmd'), 'path']);
  }
  out.push([path.join(local, 'Microsoft', 'WinGet', 'Links', 'codex.exe'), 'winget']);
  for (const pkg of findDirs(path.join(local, 'Microsoft', 'WinGet', 'Packages'), /^OpenAI\.Codex/i)) {
    for (const exe of findExe(pkg, 3, ['codex.exe'])) out.push([exe, 'winget']);
    for (const exe of findExeMatching(pkg, 3, RELEASE_EXE)) out.push([exe, 'winget']);
  }
  out.push([path.join(roaming, 'npm', 'codex.cmd'), 'npm']);
  out.push([path.join(os.homedir(), 'scoop', 'shims', 'codex.exe'), 'scoop']);
  out.push([path.join(local, 'Volta', 'bin', 'codex.exe'), 'volta']);
  out.push([path.join(local, 'pnpm', 'codex.cmd'), 'pnpm']);
  out.push([path.join(os.homedir(), '.bun', 'bin', 'codex.exe'), 'bun']);
  // Anything else installed for this user under Programs or OpenAI (e.g. a desktop app).
  for (const exe of findExe(path.join(local, 'Programs'), 4, ['codex.exe'])) out.push([exe, 'programs']);
  for (const exe of findExe(path.join(local, 'OpenAI'), 4, ['codex.exe'])) out.push([exe, 'programs']);
  return out;
}

function findDirs(dir, re) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory() && re.test(e.name)).map((e) => path.join(dir, e.name));
  } catch {
    return [];
  }
}

function findExeMatching(dir, depth, re) {
  const out = [];
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isFile() && re.test(e.name)) out.push(p);
    else if (e.isDirectory() && depth > 0) out.push(...findExeMatching(p, depth - 1, re));
  }
  return out;
}

// Returns { path, source } or null.
export function findCodex(configured) {
  const hit = codexCandidates(configured).find(([p]) => p && fs.existsSync(p));
  return hit ? { path: hit[0], source: hit[1] } : null;
}

// `codex --version` -> "0.169.0", or null if that file doesn't run as Codex.
export function codexVersion(bin, timeout = 20000) {
  return new Promise((resolve) => {
    const { file, shell } = spawnArgs(bin);
    execFile(file, ['--version'], { shell, windowsHide: true, timeout, encoding: 'utf8' }, (err, stdout) => {
      const m = /codex[-\w]*\s+v?(\d+\.\d+\.\d+)/i.exec(String(stdout || ''));
      resolve(!err && m ? m[1] : null);
    });
  });
}

// --- Installing Codex -------------------------------------------------------
// OpenAI's install script fails on some PCs with Windows PowerShell
// ("OSArchitecture" not found), so the app installs Codex itself: the official
// build from OpenAI's GitHub releases, checked against the SHA-256 GitHub
// publishes, unpacked with the tar.exe that ships with Windows.
export const CODEX_RELEASES_API = 'https://api.github.com/repos/openai/codex/releases/latest';
const CODEX_DOWNLOAD_PREFIX = 'https://github.com/openai/codex/releases/download/';

export function codexAssetName(arch = process.arch) {
  return `codex-${arch === 'arm64' ? 'aarch64' : 'x86_64'}-pc-windows-msvc.exe.tar.gz`;
}

// The asset to download from GitHub's "latest release" answer, or null.
export function pickCodexAsset(json, arch = process.arch) {
  if (!json || json.draft || json.prerelease) return null;
  const asset = (json.assets || []).find((a) => a.name === codexAssetName(arch));
  if (!asset || !String(asset.browser_download_url || '').startsWith(CODEX_DOWNLOAD_PREFIX)) return null;
  const digest = /^sha256:([0-9a-f]{64})$/i.exec(asset.digest || '');
  if (!digest) return null; // never install something that can't be checked
  return { url: asset.browser_download_url, size: Number(asset.size) || null, sha256: digest[1].toLowerCase(), version: json.tag_name };
}

const installState = { status: 'idle', progress: 0, error: null };
export const codexInstallState = () => ({ ...installState });
let installing = null;

// Downloads, checks and installs Codex into this app's folder. Returns { path, version }.
// verify: whether the unpacked program is signed by OpenAI (checked before it is installed or run).
export function installCodex({
  log = () => {}, fetchImpl = fetch, apiUrl = CODEX_RELEASES_API, tarExe = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe'),
  pickAsset = pickCodexAsset, verify = isSignedByOpenAI,
} = {}) {
  if (installing) return installing;
  installing = (async () => {
    Object.assign(installState, { status: 'downloading', progress: 0, error: null });
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'faic-codex-'));
    try {
      const res = await fetchImpl(apiUrl, { headers: { accept: 'application/vnd.github+json', 'user-agent': 'ForeverAICompanion' }, signal: AbortSignal.timeout(20000) });
      if (!res.ok) throw new Error(`GitHub: HTTP ${res.status}`);
      const asset = pickAsset(await res.json());
      if (!asset) throw new Error('no verifiable Codex download for Windows was found');
      const archive = path.join(work, 'codex.tar.gz');
      const dl = await fetchImpl(asset.url, { headers: { 'user-agent': 'ForeverAICompanion' }, signal: AbortSignal.timeout(30 * 60000) });
      if (!dl.ok || !dl.body) throw new Error(`download: HTTP ${dl.status}`);
      const total = asset.size || Number(dl.headers.get('content-length')) || 0;
      const hash = crypto.createHash('sha256');
      const fd = fs.openSync(archive, 'w');
      let got = 0;
      try {
        for await (const chunk of dl.body) {
          const buf = Buffer.from(chunk);
          got += buf.length;
          hash.update(buf);
          fs.writeSync(fd, buf);
          if (total) installState.progress = Math.min(99, Math.floor((got / total) * 100));
        }
      } finally {
        fs.closeSync(fd);
      }
      if (asset.size && got !== asset.size) throw new Error(`incomplete download (${got} of ${asset.size} bytes)`);
      if (hash.digest('hex') !== asset.sha256) throw new Error('the download does not match the file OpenAI published (SHA-256)');

      installState.status = 'extracting';
      const out = path.join(work, 'x');
      fs.mkdirSync(out);
      await new Promise((resolve, reject) => {
        execFile(tarExe, ['-xzf', archive, '-C', out], { windowsHide: true, timeout: 10 * 60000 }, (err, so, se) => (err ? reject(new Error(`tar: ${(se || err.message).trim()}`)) : resolve()));
      });
      const exe = findExeMatching(out, 2, RELEASE_EXE)[0] || findExe(out, 2, ['codex.exe'])[0];
      if (!exe) throw new Error('codex.exe was not in the download');
      if (!(await verify(exe))) throw new Error('the downloaded Codex is not signed by OpenAI');

      fs.mkdirSync(ownCodexDir(), { recursive: true });
      const target = ownCodexExe();
      if (fs.existsSync(target)) {
        try { fs.rmSync(target); } catch { fs.renameSync(target, `${target}.old-${Date.now()}`); }
      }
      fs.copyFileSync(exe, target);
      const version = await codexVersion(target);
      if (!version) throw new Error('the installed Codex does not start');
      Object.assign(installState, { status: 'done', progress: 100 });
      log(`Codex ${version} installed in ${target}`);
      return { path: target, version };
    } catch (e) {
      Object.assign(installState, { status: 'error', error: e.message });
      log(`Codex install failed: ${e.message}`);
      throw e;
    } finally {
      fs.rmSync(work, { recursive: true, force: true });
      installing = null;
    }
  })();
  return installing;
}

// --- Searching the PC for Codex ----------------------------------------------
// When Codex isn't in any usual place: look at running programs first (Codex
// open in a terminal, or the Codex desktop app, which carries the command-line
// Codex inside its folder), then walk the disks for a while. Nothing found is
// run except with --version, and desktop apps (Electron) are never run.

const CLI_NAMES = ['codex.exe', 'codex.cmd'];
const isCliName = (name) => CLI_NAMES.includes(name.toLowerCase()) || RELEASE_EXE.test(name);

// A desktop (Electron) app next to its runtime files: running it would open a window.
export function isDesktopApp(exe) {
  const dir = path.dirname(exe);
  return fs.existsSync(path.join(dir, 'resources'))
    && ['ffmpeg.dll', 'v8_context_snapshot.bin', 'resources.pak', 'icudtl.dat'].some((f) => fs.existsSync(path.join(dir, f)));
}

// Folders never worth walking (system, caches, big game and cloud folders).
const SKIP_DIRS = new Set([
  'windows', '$recycle.bin', 'system volume information', 'recovery', 'perflogs', '$windows.~bt', '$windows.~ws',
  '.git', '.cache', 'cache', 'caches', 'temp', 'tmp', 'logs', 'crashdumps', 'packages', 'onedrive',
  'steamapps', 'steamlibrary', 'world of warcraft', 'battle.net', 'riot games', 'epic games', 'ea games', 'xboxgames',
  'windowsapps', 'windows kits', 'microsoft visual studio', 'dotnet', 'nvidia corporation', 'intel', 'amd',
]);

// Walks `roots` breadth-first (each [dir, depth]) for Codex files, giving the
// event loop a turn now and then. Stops after `budgetMs`.
export async function walkForCodex(roots, { budgetMs = 60000, onProgress = () => {}, shouldStop = () => false } = {}) {
  const found = [];
  const queue = roots.filter(([d]) => d).map(([d, depth]) => [d, depth]);
  const seen = new Set();
  const until = Date.now() + budgetMs;
  let dirs = 0;
  while (queue.length && Date.now() < until && !shouldStop()) {
    const [dir, depth] = queue.shift();
    const key = dir.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    dirs++;
    const inNodeModules = /[\\/]node_modules$/i.test(dir);
    for (const e of entries) {
      if (e.isFile() && isCliName(e.name)) found.push(path.join(dir, e.name));
      else if (e.isDirectory() && !e.isSymbolicLink() && depth > 0) {
        const name = e.name.toLowerCase();
        if (SKIP_DIRS.has(name)) continue;
        // node_modules: only OpenAI's packages (npm installs Codex there).
        if (inNodeModules && !(name === '@openai' || name.startsWith('codex'))) continue;
        queue.push([path.join(dir, e.name), depth - 1]);
      }
    }
    if (dirs % 200 === 0) {
      onProgress(dirs);
      await new Promise((r) => setImmediate(r));
    }
  }
  onProgress(dirs);
  return { found, dirs, complete: queue.length === 0 };
}

// Executable paths of running programs named like Codex.
export function runningCodexPaths() {
  if (!isWin) return Promise.resolve([]);
  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      "Get-CimInstance Win32_Process -Filter \"Name LIKE 'codex%'\" | ForEach-Object { $_.ExecutablePath }"],
    { windowsHide: true, timeout: 20000, encoding: 'utf8' }, (err, stdout) => {
      resolve([...new Set(String(stdout || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean))]);
    });
  });
}

function driveRoots() {
  if (!isWin) return [];
  const out = [];
  for (let c = 67; c <= 90; c++) { // C: to Z:
    const root = `${String.fromCharCode(c)}:\\`;
    try { if (fs.statSync(root).isDirectory()) out.push(root); } catch { /* no drive */ }
  }
  return out;
}

const searchState = { status: 'idle', dirs: 0, path: null, runningApp: false, error: null };
export const codexSearchState = () => ({ ...searchState });
let searching = null;

// Finds a working Codex anywhere on this PC. Resolves to its path or null.
// Only programs signed by OpenAI (verify) are run, and npm's codex.cmd
// launchers only in the places npm and pnpm put them.
export function searchCodex({
  log = () => {}, budgetMs = 60000, roots = null, running = runningCodexPaths, check = (p) => codexVersion(p, 8000),
  verify = isSignedByOpenAI,
} = {}) {
  if (searching) return searching;
  searching = (async () => {
    Object.assign(searchState, { status: 'searching', dirs: 0, path: null, runningApp: false, error: null });
    const tried = new Set();
    // launchers: whether a .cmd may run (only from the usual places).
    const tryOne = async (file, { launchers = false } = {}) => {
      const k = file.toLowerCase();
      if (tried.has(k) || !fs.existsSync(file)) return null;
      tried.add(k);
      if (!isCliName(path.basename(file)) || isDesktopApp(file)) return null;
      if (/\.cmd$/i.test(file)) {
        if (!launchers) return null;
      } else if (!(await verify(file))) {
        log(`Codex search: skipped ${file} (not signed by OpenAI).`);
        return null;
      }
      return (await check(file)) ? file : null;
    };
    try {
      // 1. Codex running right now (in a terminal, or inside the desktop app).
      for (const exe of await running()) {
        if (isDesktopApp(exe)) {
          searchState.runningApp = true;
          const inside = await walkForCodex([[path.dirname(exe), 6]], { budgetMs: 15000 });
          for (const f of inside.found) { const ok = await tryOne(f); if (ok) return finish(ok, 'running app'); }
        } else {
          const ok = await tryOne(exe);
          if (ok) return finish(ok, 'running');
        }
      }
      // 2. The usual places.
      for (const [f] of codexCandidates(null)) { const ok = await tryOne(f, { launchers: true }); if (ok) return finish(ok, 'known place'); }
      // 3. The disks.
      const home = os.homedir();
      const walkRoots = roots || [
        [home, 7],
        [process.env.ProgramFiles, 5], [process.env['ProgramFiles(x86)'], 5], [process.env.ProgramData, 5],
        ...driveRoots().map((d) => [d, 5]),
      ];
      const walk = await walkForCodex(walkRoots, { budgetMs, onProgress: (n) => { searchState.dirs = n; } });
      // Prefer real executables over npm's .cmd launchers, shallow paths first.
      walk.found.sort((a, b) => (a.endsWith('.cmd') - b.endsWith('.cmd')) || (a.split(/[\\/]/).length - b.split(/[\\/]/).length));
      for (const f of walk.found) { const ok = await tryOne(f); if (ok) return finish(ok, 'disk search'); }
      Object.assign(searchState, { status: 'notfound' });
      log(`Codex search: not found (${walk.dirs} folders${walk.complete ? '' : ', time limit reached'}).`);
      return null;
    } catch (e) {
      Object.assign(searchState, { status: 'notfound', error: e.message });
      return null;
    } finally {
      searching = null;
    }
    function finish(file, how) {
      Object.assign(searchState, { status: 'found', path: file });
      log(`Codex found (${how}): ${file}`);
      return file;
    }
  })();
  return searching;
}

// --- Who signed a Codex file ------------------------------------------------
// OpenAI signs its Windows builds (Authenticode, "OpenAI OpCo, LLC" through
// Microsoft's code signing service). Files found by searching the PC are only
// run when Windows confirms that signature, so a file that is merely named
// codex.exe (a download, a USB stick, a network share) is never started.
export const OPENAI_SIGNERS = ['OpenAI OpCo, LLC', 'OpenAI OpCo LLC', 'OpenAI, LLC', 'OpenAI, L.L.C.'];

// The organization (O=) of a certificate subject such as
// 'CN="OpenAI OpCo, LLC", O="OpenAI OpCo, LLC", L=San Francisco, C=US'.
export function subjectOrganization(subject) {
  const m = /(?:^|,\s*)O=(?:"((?:[^"]|"")*)"|([^,]*))/.exec(String(subject || ''));
  return m ? (m[1] !== undefined ? m[1].replace(/""/g, '"') : m[2]).trim() : null;
}

export const isOpenAISignature = (sig) => Boolean(sig && sig.status === 'Valid' && OPENAI_SIGNERS.includes(subjectOrganization(sig.subject)));

// Windows' verdict on a file's Authenticode signature: { status, subject } or null.
export async function authenticodeSignature(file) {
  if (!isWin) return null;
  try {
    const out = await powershell(`$s = Get-AuthenticodeSignature -LiteralPath $env:FAIC_FILE
@{ status = [string]$s.Status; subject = [string]$s.SignerCertificate.Subject } | ConvertTo-Json -Compress`, { vars: { FILE: file }, timeout: 30000 });
    const j = JSON.parse(out);
    return { status: String(j.status || ''), subject: String(j.subject || '') };
  } catch {
    return null;
  }
}

export const isSignedByOpenAI = async (file) => isOpenAISignature(await authenticodeSignature(file));

// `codex login status`: "Logged in using ChatGPT" / "Not logged in" (exit 1).
export function parseLoginStatus(text) {
  const s = String(text || '');
  if (/not logged in/i.test(s) || !/logged in/i.test(s)) return { loggedIn: false, method: null };
  return { loggedIn: true, method: /chatgpt/i.test(s) ? 'chatgpt' : /api key/i.test(s) ? 'api-key' : 'other' };
}

export function codexAuthStatus(bin) {
  return new Promise((resolve) => {
    const { file, shell } = spawnArgs(bin);
    execFile(file, ['login', 'status'], { shell, windowsHide: true, timeout: 20000, encoding: 'utf8' }, (err, stdout, stderr) => {
      const text = `${stdout || ''}\n${stderr || ''}`;
      if (err && !/logged in/i.test(text)) {
        resolve({ loggedIn: false, method: null, error: t('codexStatusFailed') });
      } else {
        resolve(parseLoginStatus(text));
      }
    });
  });
}

export function openCodexLogin(bin) {
  visibleConsole(t('consoleSignInChatGPT'), `cmd /k ""${bin}" login && echo. && echo ${t('consoleDone')}"`);
}

// Codex features that only matter to a coding agent. Unknown names are an
// error in Codex, so this list is dropped and the call retried if a future
// version removes one (see providers.js).
export const CODEX_DISABLE = [
  'shell_tool', 'unified_exec', 'apps', 'plugins', 'image_generation', 'browser_use',
  'computer_use', 'view_image', 'skill_search', 'tool_suggest', 'goals', 'multi_agent', 'hooks',
];
// The ones that would let Codex run commands, drive the browser or the
// desktop, read local files or reach other accounts. These are never dropped:
// if Codex stops accepting one, the question fails instead.
export const CODEX_MUST_DISABLE = ['shell_tool', 'unified_exec', 'apps', 'plugins', 'browser_use', 'computer_use', 'view_image', 'hooks'];

// The features a Codex "unknown feature" error names, or null if the error is
// something else. An empty list: it could not be told which (fail closed).
export function rejectedCodexFeatures(text) {
  const s = String(text || '');
  if (!/unknown feature/i.test(s)) return null;
  const names = new Set();
  for (const m of s.matchAll(/unknown feature(?:\s+(?:flag|name))?s?\s*[:=]?\s*[`'"]?([A-Za-z0-9_.-]+)/gi)) names.add(m[1]);
  return [...names];
}

// TOML literal string ('...'): no escapes, so Windows paths work as they are.
const tomlLiteral = (s) => `'${String(s).replace(/\\/g, '/').replace(/'/g, '')}'`;

// Arguments for `codex exec` so it behaves as a plain chat model, not as a
// coding agent: our own instructions instead of Codex's (~22k characters),
// read-only, no user config/rules/AGENTS.md/skills, nothing saved to disk.
// The question goes in on stdin ("-").
export function codexArgs(c, { instructionsFile, outFile, workDir, webSearch = false, disable = CODEX_DISABLE }) {
  const args = [
    'exec', '--json', '--ephemeral', '--skip-git-repo-check', '--ignore-user-config', '--ignore-rules',
    '--sandbox', 'read-only', '--cd', workDir, '--output-last-message', outFile,
    '-c', `model_instructions_file=${tomlLiteral(instructionsFile)}`,
    '-c', `web_search=${webSearch ? "'live'" : "'disabled'"}`,
    '-c', 'project_doc_max_bytes=0',
    '-c', 'skills.include_instructions=false',
    '-c', 'skills.bundled.enabled=false',
    '-c', "personality='none'",
  ];
  if (c.effort) args.push('-c', `model_reasoning_effort=${tomlLiteral(c.effort)}`);
  if (c.model && c.model !== 'default') args.push('--model', c.model);
  for (const f of disable) args.push('--disable', f);
  args.push(...(c.extraArgs || []), '-');
  return args;
}

// cmd.exe (for codex.cmd) splits on spaces: quote what needs it.
export function shellQuote(args) {
  return args.map((a) => (/[\s&|<>^()]/.test(a) ? `"${a}"` : a));
}

// Reads the --json event stream: the answer and, if the turn failed, why.
export function parseCodexEvents(stdout) {
  let text = '';
  let error = null;
  let usage = null;
  for (const line of String(stdout || '').split(/\r?\n/)) {
    if (!line.startsWith('{')) continue;
    let ev;
    try { ev = JSON.parse(line); } catch { continue; }
    if (ev.type === 'item.completed' && ev.item?.type === 'agent_message' && ev.item.text) text = ev.item.text;
    else if (ev.type === 'turn.failed') error = ev.error?.message || 'error';
    else if (ev.type === 'turn.completed') usage = ev.usage || null;
    else if (ev.type === 'error' && !/^Reconnecting/i.test(ev.message || '')) error = error || ev.message;
  }
  return { text, error, usage };
}

// Turns Codex's English errors into something a player can act on.
export function friendlyCodexError(message) {
  const m = String(message || '');
  if (/401|unauthori[sz]ed|not logged in|login/i.test(m)) {
    return t('codexSignedOut');
  }
  if (/usage limit|rate limit|429|quota/i.test(m)) {
    return t('codexLimit');
  }
  if (/model.*(not (supported|available|found))|does not exist|access to model/i.test(m)) {
    return t('codexModel');
  }
  return t('codexError', { error: m.slice(0, 300) });
}
