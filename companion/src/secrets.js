// API keys in config.json are encrypted with Windows DPAPI for the current
// user (CurrentUser scope): only this Windows account on this PC can read
// them, so a copied config.json (backup, sync folder, another account) does
// not give the keys away. Stored as { "dpapi": "<base64>" } in place of the key.
//
// DPAPI is reached through PowerShell and .NET's ProtectedData, which ship
// with Windows: nothing is added to the app. Elsewhere (development on
// Linux/macOS) keys stay as plain text, as before.
import { execFileSync } from 'node:child_process';

// Extra secret mixed into the encryption, so other programs' DPAPI calls
// can't read the keys by accident (it is not a password).
const ENTROPY = 'ForeverAICompanion API keys v1';

const DPAPI_PS = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security
$req = [Console]::In.ReadToEnd() | ConvertFrom-Json
$entropy = [Text.Encoding]::UTF8.GetBytes($req.entropy)
$scope = [Security.Cryptography.DataProtectionScope]::CurrentUser
$out = @(foreach ($v in @($req.items)) {
  try {
    $b = [Convert]::FromBase64String($v)
    if ($req.mode -eq 'protect') { [Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect($b, $entropy, $scope)) }
    else { [Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Unprotect($b, $entropy, $scope)) }
  } catch { '' }
})
ConvertTo-Json -InputObject $out -Compress`;

// Values go in on stdin (never on the command line), as base64.
function runDpapi(mode, items) {
  if (!items.length) return [];
  const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', DPAPI_PS], {
    input: JSON.stringify({ mode, entropy: ENTROPY, items }), encoding: 'utf8', windowsHide: true, timeout: 60000,
    stdio: ['pipe', 'pipe', 'ignore'],
  });
  const list = [].concat(JSON.parse(out.trim() || '[]'));
  if (list.length !== items.length) throw new Error('DPAPI: unexpected answer');
  return list.map((v) => (v ? String(v) : null));
}

export const windowsDpapi = {
  // plain texts -> blobs (base64). Throws when nothing could be encrypted.
  protect(values) {
    const blobs = runDpapi('protect', values.map((v) => Buffer.from(String(v), 'utf8').toString('base64')));
    if (blobs.some((b) => !b)) throw new Error('DPAPI could not encrypt the key');
    return blobs;
  },
  // blobs -> plain texts, null for the ones this account can't read.
  unprotect(blobs) {
    return runDpapi('unprotect', blobs).map((b) => (b === null ? null : Buffer.from(b, 'base64').toString('utf8')));
  },
};

let protector = process.platform === 'win32' ? windowsDpapi : null;
// Tests: a stand-in protector (or null for plain text).
export const setSecretProtector = (p) => { protector = p; cache.clear(); };
export const secretsProtected = () => Boolean(protector);

// blob -> plain text, so the keys are decrypted once per run.
const cache = new Map();

export const isSealed = (v) => Boolean(v && typeof v === 'object' && !Array.isArray(v) && typeof v.dpapi === 'string');

// Where keys can be in config.json: the app window's keys per AI, and the
// apiKey of a hand-written anthropic / openai section.
function secretSlots(cfg) {
  const slots = [];
  if (cfg?.keys && typeof cfg.keys === 'object') {
    for (const k of Object.keys(cfg.keys)) slots.push([cfg.keys, k]);
  }
  for (const section of ['anthropic', 'openai']) {
    if (cfg?.[section] && typeof cfg[section] === 'object' && 'apiKey' in cfg[section]) slots.push([cfg[section], 'apiKey']);
  }
  return slots;
}

const clone = (v) => (v === undefined ? v : JSON.parse(JSON.stringify(v)));

// Config as saved -> config with plain keys. { cfg, plainFound, unreadable }:
// plainFound = keys still stored as plain text (to be encrypted); unreadable
// = keys this account can't decrypt (they count as missing).
export function revealSecrets(saved) {
  const cfg = clone(saved) || {};
  const slots = secretSlots(cfg);
  const sealed = slots.filter(([o, k]) => isSealed(o[k]));
  const todo = [...new Set(sealed.map(([o, k]) => o[k].dpapi).filter((b) => !cache.has(b)))];
  if (todo.length) {
    let plain = todo.map(() => null);
    try { if (protector) plain = protector.unprotect(todo); } catch { /* unreadable */ }
    todo.forEach((b, i) => { if (plain[i] !== null) cache.set(b, plain[i]); });
  }
  let unreadable = 0;
  for (const [o, k] of sealed) {
    const v = cache.get(o[k].dpapi);
    if (v === undefined) unreadable++;
    o[k] = v ?? null;
  }
  const plainFound = slots.some(([o, k]) => typeof o[k] === 'string' && o[k] && !sealed.some(([so, sk]) => so === o && sk === k));
  return { cfg, plainFound, unreadable };
}

// Config about to be saved -> same config with every plain key encrypted.
// Without DPAPI (not Windows) it is returned as is.
export function sealSecrets(cfg) {
  const out = clone(cfg) || {};
  if (!protector) return out;
  const plain = secretSlots(out).filter(([o, k]) => typeof o[k] === 'string' && o[k]);
  if (!plain.length) return out;
  const blobs = protector.protect(plain.map(([o, k]) => o[k]));
  plain.forEach(([o, k], i) => {
    cache.set(blobs[i], o[k]);
    o[k] = { dpapi: blobs[i] };
  });
  return out;
}
