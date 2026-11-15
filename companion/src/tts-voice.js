// Installs / removes the silent "ForeverAICompanion" Windows voice (see
// tts/ForeverAICompanionTts.cs).
//
// Installs from before the rename (see config.LEGACY_NAME) registered it
// differently, and it keeps working that way until the player updates it
// (one administrator prompt, offered by the app window):
//  - until v1.0 the voice itself had the previous name;
//  - until v1.5 its engine was the previous name's DLL and class, in the
//    previous install folder, writing to the previous data folder.
// The engine's COM class id never changed, so installing the current voice
// replaces all of that in the same prompt.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { APP_ID, LEGACY_NAME } from './config.js';
import { err, err as i18nErr } from './i18n.js';

export const VOICE_NAME = 'ForeverAICompanion';
export const LEGACY_VOICE_NAME = LEGACY_NAME;
const VENDOR = 'Forever AI Companion';
export const ENGINE_CLSID = '{DE6988DD-75DB-43E9-9021-43C884474FEE}';
// Must match tts/ForeverAICompanionTts.cs (namespace + class) and the DLL's file name.
export const ENGINE_CLASS = 'ForeverAICompanion.Tts.Engine';
const ENGINE_ASSEMBLY = 'ForeverAICompanionTts, Version=1.0.0.0, Culture=neutral, PublicKeyToken=null';
export const ENGINE_DLL = 'ForeverAICompanionTts.dll';
export const LEGACY_ENGINE_CLASS = `${LEGACY_NAME}.Tts.Engine`;
export const LEGACY_ENGINE_DLL = `${LEGACY_NAME}Tts.dll`;
const TOKEN_KEY = `HKCU\\Software\\Microsoft\\Speech\\Voices\\Tokens\\${VOICE_NAME}`;
const LEGACY_TOKEN_KEY = `HKCU\\Software\\Microsoft\\Speech\\Voices\\Tokens\\${LEGACY_VOICE_NAME}`;
const CLSID_KEY = `HKCU\\Software\\Classes\\CLSID\\${ENGINE_CLSID}`;
const CLSID_KEY_32 = `HKCU\\Software\\Classes\\WOW6432Node\\CLSID\\${ENGINE_CLSID}`;
const CSC = 'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe';

function run(file, args) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { windowsHide: true, timeout: 60000 }, (err, stdout, stderr) => {
      if (err) reject(new Error(`${path.basename(file)}: ${(stderr || stdout || err.message).trim()}`));
      else resolve(stdout);
    });
  });
}

const reg = (...args) => run('reg.exe', [...args, '/f']);

// Compiles the engine with the C# compiler that ships with Windows.
// A process that used the voice (the game) keeps the DLL open, so it is
// compiled next to it and swapped in: an open DLL can still be renamed.
export async function compileEngine(sourceFile, outFile) {
  if (!fs.existsSync(CSC)) throw err('noCsc');
  const target = path.resolve(outFile);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  // The output file name becomes the assembly name, which must match the
  // registered one (ENGINE_ASSEMBLY): build into a temporary folder under the final name.
  const buildDir = path.join(path.dirname(target), `.build-${Date.now()}`);
  fs.mkdirSync(buildDir, { recursive: true });
  const fresh = path.join(buildDir, path.basename(target));
  // csc mis-reads forward slashes in paths: always pass absolute Windows paths.
  try {
    await run(CSC, ['/nologo', '/target:library', '/optimize+', `/out:${fresh}`, path.resolve(sourceFile)]);
  } catch (e) {
    fs.rmSync(buildDir, { recursive: true, force: true });
    throw e;
  }
  if (fs.existsSync(target)) {
    try {
      fs.rmSync(target);
    } catch {
      fs.renameSync(target, `${target}.old-${Date.now()}`);
    }
  }
  fs.renameSync(fresh, target);
  fs.rmSync(buildDir, { recursive: true, force: true });
  cleanupOldEngines(target);
  return target;
}

// Removes swapped-out copies once nothing has them open.
export function cleanupOldEngines(target) {
  const dir = path.dirname(target);
  for (const name of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
    if (name.startsWith(`${path.basename(target)}.old-`)) {
      try { fs.rmSync(path.join(dir, name)); } catch { /* still in use */ }
    }
  }
}

export async function installVoice(dllPath) {
  const codeBase = 'file:///' + dllPath.replace(/\\/g, '/');
  for (const key of [CLSID_KEY, CLSID_KEY_32]) {
    // Starts clean: drops what an install from before the rename left there.
    try { await reg('delete', key); } catch { /* not there */ }
    await reg('add', key, '/ve', '/d', ENGINE_CLASS);
    const inproc = `${key}\\InprocServer32`;
    await reg('add', inproc, '/ve', '/d', 'mscoree.dll');
    await reg('add', inproc, '/v', 'ThreadingModel', '/d', 'Both');
    await reg('add', inproc, '/v', 'Class', '/d', ENGINE_CLASS);
    await reg('add', inproc, '/v', 'Assembly', '/d', ENGINE_ASSEMBLY);
    await reg('add', inproc, '/v', 'RuntimeVersion', '/d', 'v4.0.30319');
    await reg('add', inproc, '/v', 'CodeBase', '/d', codeBase);
  }
  await reg('add', TOKEN_KEY, '/ve', '/d', VOICE_NAME);
  await reg('add', TOKEN_KEY, '/v', '409', '/d', VOICE_NAME);
  await reg('add', TOKEN_KEY, '/v', 'CLSID', '/d', ENGINE_CLSID);
  const attrs = `${TOKEN_KEY}\\Attributes`;
  await reg('add', attrs, '/v', 'Name', '/d', VOICE_NAME);
  await reg('add', attrs, '/v', 'Gender', '/d', 'Female');
  await reg('add', attrs, '/v', 'Age', '/d', 'Adult');
  await reg('add', attrs, '/v', 'Language', '/d', '409');
  await reg('add', attrs, '/v', 'Vendor', '/d', VENDOR);
  try { await reg('delete', LEGACY_TOKEN_KEY); } catch { /* not there */ }
}

export async function uninstallVoice() {
  for (const key of [TOKEN_KEY, LEGACY_TOKEN_KEY, CLSID_KEY, CLSID_KEY_32]) {
    try { await reg('delete', key); } catch { /* not installed */ }
  }
}

// --- Machine-wide registration (what the game actually lists) --------------
// SAPI only enumerates voices under HKLM, so the voice token (and, for
// elevated processes, the COM class) is written there once, with one
// administrator prompt (UAC).
//
// Elevated programs load the engine through the HKLM class, so the DLL it
// points to must not be writable by the user (or by anything running as the
// user): the elevated step copies it to an admin-only folder under Program
// Files, checks the copy's SHA-256 and registers that copy. Non-elevated
// programs (the game) keep using the per-user registration above, which the
// app updates without a prompt.
const HKLM_TOKEN = `HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Speech\\Voices\\Tokens\\${VOICE_NAME}`;
const HKLM_LEGACY_TOKEN = `HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Speech\\Voices\\Tokens\\${LEGACY_VOICE_NAME}`;
const HKLM_CLSID = `HKEY_LOCAL_MACHINE\\SOFTWARE\\Classes\\CLSID\\${ENGINE_CLSID}`;

// %ProgramFiles%\ForeverAICompanion: only administrators and SYSTEM can change it.
export const machineDir = () => path.win32.join(process.env.ProgramW6432 || process.env.ProgramFiles || 'C:\\Program Files', APP_ID);
export const machineDll = () => path.win32.join(machineDir(), ENGINE_DLL);
// Hash of the engine source the admin-only copy was built from.
export const machineSourceHashFile = () => `${machineDll()}.source-sha256`;

const codeBaseOf = (dllPath) => 'file:///' + dllPath.replace(/\\/g, '/');
// "file:///C:/x/y.dll" -> "c:\x\y.dll", to compare registered paths.
const codeBasePath = (codeBase) => String(codeBase || '').replace(/^file:\/+/i, '').replace(/\//g, '\\').toLowerCase();

export function machineRegFile(dllPath = machineDll()) {
  const codeBase = codeBaseOf(dllPath);
  return [
    'Windows Registry Editor Version 5.00',
    '',
    `[-${HKLM_LEGACY_TOKEN}]`,
    '',
    `[${HKLM_TOKEN}]`,
    `@="${VOICE_NAME}"`,
    `"409"="${VOICE_NAME}"`,
    `"CLSID"="${ENGINE_CLSID}"`,
    '',
    `[${HKLM_TOKEN}\\Attributes]`,
    `"Name"="${VOICE_NAME}"`,
    '"Gender"="Female"',
    '"Age"="Adult"',
    '"Language"="409"',
    `\"Vendor\"=\"${VENDOR}\"`,
    '',
    // Same class id as before the rename: cleared first, then registered with
    // the current DLL and class.
    `[-${HKLM_CLSID}]`,
    '',
    `[${HKLM_CLSID}]`,
    `@="${ENGINE_CLASS}"`,
    '',
    `[${HKLM_CLSID}\\InprocServer32]`,
    '@="mscoree.dll"',
    '"ThreadingModel"="Both"',
    `"Class"="${ENGINE_CLASS}"`,
    `"Assembly"="${ENGINE_ASSEMBLY}"`,
    '"RuntimeVersion"="v4.0.30319"',
    `"CodeBase"="${codeBase}"`,
    '',
  ].join('\r\n');
}

export function machineUnregFile() {
  return ['Windows Registry Editor Version 5.00', '', `[-${HKLM_TOKEN}]`, '', `[-${HKLM_LEGACY_TOKEN}]`, '', `[-${HKLM_CLSID}]`, ''].join('\r\n');
}

// PowerShell single-quoted literal. PowerShell also ends a literal at the
// typographic quotes U+2018..U+201B, so those are doubled too.
export const psQuote = (s) => `'${String(s).replace(/['\u2018\u2019\u201A\u201B]/g, '$&$&')}'`;

// Exit codes of the elevated script (see elevatedScript).
const ELEVATED_ERRORS = {
  20: 'the protected folder could not be locked down',
  21: 'the protected folder is a link',
  22: 'the copied voice file does not match the one just built (SHA-256)',
  23: 'the registry import failed',
  30: 'the elevated script was changed before it ran',
};

// What runs as administrator. mode "install": copy + register; "uninstall":
// unregister + remove the copy. Native tools are called by full path.
export function elevatedScript({ mode, sourceDll = null, dllSha256 = null, sourceHash = null }) {
  const dir = machineDir();
  const dll = machineDll();
  const sys32 = '(Join-Path $env:SystemRoot "System32")';
  const lines = [
    `$sys32 = ${sys32}`,
    `$dir = ${psQuote(dir)}`,
    `$dll = ${psQuote(dll)}`,
    // A junction or symlink (attributes of the link itself; 1024 = ReparsePoint).
    'function IsLink($p) { try { ([int][IO.File]::GetAttributes($p) -band 1024) -ne 0 } catch { $false } }',
  ];
  if (mode === 'install') {
    lines.push(
      'if (IsLink $dir) { exit 21 }',
      'New-Item -ItemType Directory -Force -Path $dir | Out-Null',
      'if (IsLink $dir) { exit 21 }',
      // Administrators and SYSTEM: full control. Users: read and run. Nothing inherited.
      "& (Join-Path $sys32 'icacls.exe') $dir /inheritance:r /grant:r '*S-1-5-32-544:(OI)(CI)F' '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-545:(OI)(CI)RX' | Out-Null",
      'if ($LASTEXITCODE -ne 0) { exit 20 }',
      '$new = "$dll.new"',
      `Copy-Item -LiteralPath ${psQuote(sourceDll)} -Destination $new -Force -ErrorAction Stop`,
      `if ((Get-FileHash -LiteralPath $new -Algorithm SHA256).Hash -ne ${psQuote(dllSha256)}) { Remove-Item -LiteralPath $new -Force; exit 22 }`,
      // A program using the voice keeps the DLL open: an open DLL can still be renamed.
      'if (Test-Path -LiteralPath $dll) { try { Remove-Item -LiteralPath $dll -Force -ErrorAction Stop } catch { Rename-Item -LiteralPath $dll -NewName ((Split-Path $dll -Leaf) + ".old-" + [DateTime]::UtcNow.Ticks) } }',
      'Move-Item -LiteralPath $new -Destination $dll -Force -ErrorAction Stop',
      'Get-ChildItem -LiteralPath $dir -Filter ((Split-Path $dll -Leaf) + ".old-*") | ForEach-Object { try { Remove-Item -LiteralPath $_.FullName -Force -ErrorAction Stop } catch { } }',
      `[IO.File]::WriteAllText("$dll.source-sha256", ${psQuote(sourceHash || '')})`,
      '$reg = Join-Path $dir ("voice-" + [Guid]::NewGuid().ToString("N") + ".reg")',
      `[IO.File]::WriteAllText($reg, ${psQuote(machineRegFile(dll))}, [Text.Encoding]::Unicode)`,
      "& (Join-Path $sys32 'reg.exe') import $reg /reg:64",
      '$code = $LASTEXITCODE',
      'Remove-Item -LiteralPath $reg -Force',
      'if ($code -ne 0) { exit 23 }',
      'exit 0',
    );
  } else {
    for (const key of [HKLM_TOKEN, HKLM_LEGACY_TOKEN, HKLM_CLSID]) {
      lines.push(`& (Join-Path $sys32 'reg.exe') delete ${psQuote(key.replace('HKEY_LOCAL_MACHINE', 'HKLM'))} /f /reg:64 | Out-Null`);
    }
    lines.push(
      'if ((Test-Path -LiteralPath $dir) -and -not (IsLink $dir)) { Remove-Item -LiteralPath $dir -Recurse -Force -ErrorAction SilentlyContinue }',
      'exit 0',
    );
  }
  return lines.join('\r\n');
}

// Small enough for UAC (ShellExecuteEx caps arguments at about 2048
// characters): reads the full script, checks its SHA-256 and runs those same
// bytes from memory, so a change to the file after it was written is refused.
export function elevatedBootstrap(scriptFile, scriptSha256) {
  const cmd = `$b=[IO.File]::ReadAllBytes(${psQuote(scriptFile)});`
    + "$h=-join([Security.Cryptography.SHA256]::Create().ComputeHash($b)|ForEach-Object{$_.ToString('x2')});"
    + `if($h -ne ${psQuote(scriptSha256)}){exit 30};`
    + '&([ScriptBlock]::Create([Text.Encoding]::UTF8.GetString($b)))';
  return Buffer.from(cmd, 'utf16le').toString('base64');
}

// Runs elevatedScript as administrator (shows the Windows UAC prompt).
async function runElevated(script, tmpDir) {
  fs.mkdirSync(tmpDir, { recursive: true });
  const file = path.join(tmpDir, `forever-ai-companion-voice-${Date.now()}.ps1`);
  const bytes = Buffer.from(script, 'utf8');
  fs.writeFileSync(file, bytes);
  const encoded = elevatedBootstrap(file, crypto.createHash('sha256').update(bytes).digest('hex'));
  const outer = `
try {
  $ps = Join-Path $env:SystemRoot 'System32\\WindowsPowerShell\\v1.0\\powershell.exe'
  $p = Start-Process -FilePath $ps -ArgumentList @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', $env:FAIC_ELEVATED) -Verb RunAs -Wait -PassThru -WindowStyle Hidden
  exit $p.ExitCode
} catch { exit 1223 }`;
  try {
    await new Promise((resolve, reject) => {
      execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', outer],
        { windowsHide: true, timeout: 300000, env: { ...process.env, FAIC_ELEVATED: encoded } }, (e) => {
          if (!e) return resolve();
          if (e.code === 1223) reject(i18nErr('adminCancelled'));
          else {
            const why = ELEVATED_ERRORS[e.code];
            reject(i18nErr('voiceRegisterFailed', { code: why ? `${e.code}: ${why}` : e.code }));
          }
        });
    });
  } finally {
    fs.rmSync(file, { force: true });
  }
}

export async function sha256File(file) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

// dllPath: the engine just built in the user's folder. sourceHash: SHA-256 of
// its C# source (to tell later whether the admin-only copy is current).
export async function installVoiceMachineWide(dllPath, tmpDir, { sourceHash = null } = {}) {
  await installVoice(dllPath); // per-user part (no prompt)
  const dllSha256 = (await sha256File(dllPath)).toUpperCase();
  await runElevated(elevatedScript({ mode: 'install', sourceDll: path.resolve(dllPath), dllSha256, sourceHash }), tmpDir);
}

export async function uninstallVoiceMachineWide(tmpDir) {
  await uninstallVoice();
  if (await isVoiceVisible() || await isLegacyVoiceVisible() || fs.existsSync(machineDir())) {
    await runElevated(elevatedScript({ mode: 'uninstall' }), tmpDir);
  }
}

async function hklmKeyExists(key) {
  try {
    await run('reg.exe', ['query', key.replace('HKEY_LOCAL_MACHINE', 'HKLM'), '/reg:64']);
    return true;
  } catch {
    return false;
  }
}

// True when SAPI (and so the game) can list the voice.
export const isVoiceVisible = () => hklmKeyExists(HKLM_TOKEN);
// The voice under the previous name (until v1.0): still works, should be renamed.
export const isLegacyVoiceVisible = () => hklmKeyExists(HKLM_LEGACY_TOKEN);

// Class and DLL Windows loads for the voice's engine, per registry view.
// The game (not elevated) uses the per-user one when it exists.
async function engineAt(key, args = []) {
  try {
    const out = await run('reg.exe', ['query', `${key}\\InprocServer32`, ...args]);
    const value = (name) => (out.match(new RegExp(`^\\s*${name}\\s+REG_\\w+\\s+(.*)$`, 'mi')) || [])[1]?.trim() || null;
    return { className: value('Class'), codeBase: value('CodeBase') };
  } catch {
    return null; // not registered there
  }
}

export async function registeredEngines() {
  const found = await Promise.all([
    engineAt(CLSID_KEY), engineAt(CLSID_KEY_32), engineAt(HKLM_CLSID.replace('HKEY_LOCAL_MACHINE', 'HKLM'), ['/reg:64']),
  ]);
  return found.filter(Boolean);
}

// An engine registered by an install from before the rename: its class or
// DLL has the previous name (and the DLL lives in the previous install folder).
export function isLegacyEngine(engine) {
  if (!engine) return false;
  const cls = String(engine.className || '').toLowerCase();
  const dll = path.basename(String(engine.codeBase || '').replace(/^file:\/+/i, '')).toLowerCase();
  return cls === LEGACY_ENGINE_CLASS.toLowerCase() || dll === LEGACY_ENGINE_DLL.toLowerCase();
}

// Whether the machine-wide engine is the protected, current copy:
//  "ok"       registered from the admin-only folder and built from this source;
//  "outside"  registered from somewhere else (installs before this change
//             pointed at the user's own folder, which the user can overwrite);
//  "stale"    the protected copy was built from an older source;
//  "none"     no machine-wide engine.
export async function machineEngineState(sourceHash) {
  const engine = await engineAt(HKLM_CLSID.replace('HKEY_LOCAL_MACHINE', 'HKLM'), ['/reg:64']);
  if (!engine) return 'none';
  return machineEngineVerdict(engine, { sourceHash, readMarker: () => fs.readFileSync(machineSourceHashFile(), 'utf8') });
}

export function machineEngineVerdict(engine, { sourceHash, readMarker }) {
  if (!engine) return 'none';
  if (codeBasePath(engine.codeBase) !== machineDll().toLowerCase()) return 'outside';
  let marker = null;
  try { marker = String(readMarker()).trim(); } catch { /* none */ }
  return sourceHash && marker !== sourceHash ? 'stale' : 'ok';
}

// True while Windows would still load the engine from before the rename.
export async function isLegacyEngineRegistered() {
  return (await registeredEngines()).some(isLegacyEngine);
}

export async function isVoiceInstalled() {
  try {
    await run('reg.exe', ['query', TOKEN_KEY]);
    return true;
  } catch {
    return false;
  }
}
