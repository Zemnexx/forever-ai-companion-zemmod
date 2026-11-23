// Installs the addon into WoW Forever and creates the slot addons and signal
// files. WoW must be fully restarted afterwards: it only discovers files that
// exist when it starts.
//
// Installs from before the rename have the addon under the project's previous
// name (see config.LEGACY_NAME). Installing or updating moves the player to the
// current addon: their saved chats and settings are copied over (migrate.js)
// and the old folders are removed once the game is closed (a game started
// before the update keeps the old addon loaded and still gets its answers,
// see inbox.js).
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { ADDON_NAME, ARMORY_ADDON, LEGACY_NAME, wowPaths } from './config.js';
import { addonFiles, armoryFiles } from './assets.js';
import { isWowRunning } from './detect.js';
import { inboxSource, silentWav, writeAtomic } from './inbox.js';
import { createStatusFiles } from './beacon.js';
import { migrateSavedVariables } from './migrate.js';
import { saveState, loadState } from './state.js';
import { KEY_FILE, ensureRequestKey } from './request-key.js';

export const TOC_NAME = `${ADDON_NAME}.toc`;

export function addonVersion(tocText) {
  return (String(tocText || '').match(/^## Version:\s*(.+)$/m) || [])[1]?.trim() || null;
}

// Version of the bundled addon files.
export const bundledAddonVersion = (files = addonFiles()) => addonVersion(files[TOC_NAME]);

// Version of the installed addon, or null when the current addon is not there
// (also when only the addon under the previous name is: it needs installing).
export function installedAddonVersion(wowDir) {
  const toc = path.join(wowPaths(wowDir).addonDir, TOC_NAME);
  return fs.existsSync(toc) ? addonVersion(fs.readFileSync(toc, 'utf8')) : null;
}

export function isAddonInstalled(wowDir, cfg) {
  const p = wowPaths(wowDir);
  return fs.existsSync(path.join(p.addonDir, TOC_NAME)) &&
    fs.existsSync(path.join(p.slotDir(cfg.slots), 'Inbox.lua')) &&
    fs.existsSync(p.signal(cfg.signals));
}

// Folders of the addon under the previous name: the addon and its slots.
const LEGACY_FOLDER = new RegExp(`^${LEGACY_NAME}(_S\\d+)?$`, 'i');
export function legacyAddonFolders(wowDir) {
  const { addons } = wowPaths(wowDir);
  let names = [];
  try { names = fs.readdirSync(addons); } catch { /* no AddOns folder */ }
  return names.filter((n) => LEGACY_FOLDER.test(n)).map((n) => path.join(addons, n));
}

export const hasLegacyAddon = (wowDir) => legacyAddonFolders(wowDir).length > 0;

// Removes the addon under the previous name (best effort). Returns true when
// nothing of it is left. Never while the game runs: it may have it loaded.
export function removeLegacyAddon(wowDir) {
  let left = 0;
  for (const dir of legacyAddonFolders(wowDir)) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { left++; }
  }
  return left === 0 && !hasLegacyAddon(wowDir);
}

// Copies the saved chats to the current addon and, when the game is closed,
// removes the addon under the previous name. Safe to call often.
// wowRunning: true / false, or undefined to check (only when needed).
export function finishLegacyMigration(wowDir, { wowRunning, log = () => {} } = {}) {
  if (!hasLegacyAddon(wowDir)) return true;
  const copied = migrateSavedVariables(wowDir);
  if (copied.length) log(`Saved chats and settings copied to the new addon name (${copied.length} file${copied.length === 1 ? '' : 's'}).`);
  if (wowRunning ?? isWowRunning({ unknown: true })) return false; // the running game may still use it
  const removed = removeLegacyAddon(wowDir);
  log(removed ? 'Removed the addon folders with the previous name.' : 'Could not remove every addon folder with the previous name yet; will retry.');
  return removed;
}

// Copies only the addon's own files (Lua/toc). Used to update an existing install.
// The request key (request-key.js) belongs to this PC: never overwritten, and
// created when missing.
export function writeAddonFiles(wowDir, files = addonFiles()) {
  const p = wowPaths(wowDir);
  fs.mkdirSync(p.addonDir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    if (name === KEY_FILE) continue;
    fs.writeFileSync(path.join(p.addonDir, name), content);
  }
  ensureRequestKey(wowDir);
}

// True when every file of the addon this app carries is installed as it is
// here. The request key is this PC's own and is not compared.
export function sameAddonFiles(wowDir, files = addonFiles()) {
  const p = wowPaths(wowDir);
  return Object.entries(files).every(([name, content]) => {
    if (name === KEY_FILE) return true;
    try {
      return fs.readFileSync(path.join(p.addonDir, name), 'utf8') === content;
    } catch {
      return false;
    }
  });
}

export function install(cfg, { wowDir = cfg.wowDir, files = addonFiles(), log = console.log, resetState = true, wowRunning } = {}) {
  const p = wowPaths(wowDir);
  fs.mkdirSync(p.addons, { recursive: true });
  fs.mkdirSync(p.screenshots, { recursive: true });

  const iface = (files[TOC_NAME].match(/^## Interface:\s*(.+)$/m) || [])[1]?.trim() || '16001';

  writeAddonFiles(wowDir, files);
  fs.mkdirSync(p.sigDir, { recursive: true });
  writeAtomic(p.okSignal, silentWav());
  for (let i = 1; i <= cfg.signals; i++) writeAtomic(p.signal(i), Buffer.alloc(0));
  createStatusFiles(p);

  for (let i = 1; i <= cfg.slots; i++) {
    const dir = p.slotDir(i);
    fs.mkdirSync(dir, { recursive: true });
    const num = String(i).padStart(2, '0');
    fs.writeFileSync(path.join(dir, `${p.slotName(i)}.toc`), [
      `## Interface: ${iface}`,
      `## Title: |cff888888Forever AI Companion · inbox ${num}|r`,
      `## Title-esES: |cff888888Forever AI Companion · buzón ${num}|r`,
      `## Title-esMX: |cff888888Forever AI Companion · buzón ${num}|r`,
      '## Notes: Internal file of Forever AI Companion. Do not disable it.',
      '## Notes-esES: Archivo interno de Forever AI Companion. No lo desactives.',
      '## Notes-esMX: Archivo interno de Forever AI Companion. No lo desactives.',
      '## LoadOnDemand: 1',
      `## Dependencies: ${ADDON_NAME}`,
      `## Group: ${ADDON_NAME}`,
      '',
      'Inbox.lua',
      '',
    ].join('\n'));
    writeAtomic(path.join(dir, 'Inbox.lua'), inboxSource([], {}, p.inboxGlobal));
  }

  if (resetState) {
    // All signal files are empty again, so numbering restarts.
    const state = loadState();
    state.nextSig = 1;
    saveState(state);
  }

  finishLegacyMigration(wowDir, { wowRunning, log });
  log(`Addon installed in: ${p.addonDir}`);
  return p;
}

// Installs the addon when it is missing but the addon under the previous name
// is there (an update from before the rename), updates its files when this app
// bundles another version, and finishes moving away from the previous name.
// Returns true when the addon is ready.
export function ensureAddon(cfg, { wowDir = cfg.wowDir, files = addonFiles(), log = () => {}, wowRunning } = {}) {
  const bundled = bundledAddonVersion(files);
  if (!isAddonInstalled(wowDir, cfg)) {
    if (!hasLegacyAddon(wowDir)) return false;
    // Same signal numbering as before, so it matches the copied saved variables.
    install(cfg, { wowDir, files, log, resetState: false, wowRunning });
    log(`Addon ${bundled} installed under its new name (Forever AI Companion).`);
    return true;
  }
  if (installedAddonVersion(wowDir) !== bundled) {
    writeAddonFiles(wowDir, files);
    log(`Addon updated to ${bundled}`);
  } else if (!sameAddonFiles(wowDir, files)) {
    // The same version with other contents: a version keeps its number
    // while it is being tested, and the files still have to follow the app.
    writeAddonFiles(wowDir, files);
    log(`Addon ${bundled} replaced: its files were not the ones this app carries`);
  }
  // Installs from before the app status in the game (addon 1.9.0) lack them.
  createStatusFiles(wowPaths(wowDir));
  ensureRequestKey(wowDir);
  finishLegacyMigration(wowDir, { wowRunning, log });
  return true;
}

export function uninstall(cfg, wowDir = cfg.wowDir) {
  const p = wowPaths(wowDir);
  fs.rmSync(p.addonDir, { recursive: true, force: true });
  for (let i = 1; i <= cfg.slots; i++) fs.rmSync(p.slotDir(i), { recursive: true, force: true });
  removeLegacyAddon(wowDir);
  uninstallArmory(wowDir);
}

// The Armory ----------------------------------------------------------------------
// An optional second addon (character builds) that asks through ours. It needs
// no mailboxes, signals or key of its own, so installing it is copying its
// files; the player asks for it in the app's window, and from then on it is
// kept at the version this app carries, like the main addon.

export const ARMORY_TOC = `${ARMORY_ADDON}.toc`;
export const armoryDir = (wowDir) => path.join(wowPaths(wowDir).addons, ARMORY_ADDON);

// Version of the Armory this app carries, or null when it carries none.
export const bundledArmoryVersion = (files = armoryFiles()) => addonVersion(files[ARMORY_TOC]);

export function installedArmoryVersion(wowDir) {
  const toc = path.join(armoryDir(wowDir), ARMORY_TOC);
  return fs.existsSync(toc) ? addonVersion(fs.readFileSync(toc, 'utf8')) : null;
}

// A short id of the Armory's files this app carries: the first 8 hex digits
// of a SHA-256 over every file's name and contents, in name order. Every test
// build shows the same version, so the addon shows this id after it to tell
// which build is running.
export function armoryBuildId(files = armoryFiles()) {
  const hash = crypto.createHash('sha256');
  for (const name of Object.keys(files).sort()) {
    hash.update(`${name}\0`);
    hash.update(String(files[name]));
    hash.update('\0');
  }
  return hash.digest('hex').slice(0, 8);
}

// The files as installed: the .toc carries the build id ("## X-Build"),
// which the addon reads with the game's addon metadata function.
export function stampedArmoryFiles(files = armoryFiles()) {
  const toc = files[ARMORY_TOC];
  if (!toc) return files;
  const eol = toc.includes('\r\n') ? '\r\n' : '\n';
  const line = `## X-Build: ${armoryBuildId(files)}`;
  const plain = toc.replace(/^## X-Build:.*(\r?\n|$)/m, '');
  // After the version line, or else before the first line that is not a tag.
  const stamped = /^## Version:.*$/m.test(plain)
    ? plain.replace(/^(## Version:.*)$/m, `$1${eol}${line}`)
    : `${line}${eol}${plain}`;
  return { ...files, [ARMORY_TOC]: stamped };
}

// The build id of the installed Armory, or null (none installed, or one
// installed by hand without a stamp).
export function installedArmoryBuild(wowDir) {
  try {
    const toc = fs.readFileSync(path.join(armoryDir(wowDir), ARMORY_TOC), 'utf8');
    return (toc.match(/^## X-Build:\s*([0-9a-f]+)\s*$/m) || [])[1] || null;
  } catch {
    return null;
  }
}

// Writes the Armory's files, and removes Lua files an older version left behind.
export function installArmory(wowDir, { files = armoryFiles(), log = () => {} } = {}) {
  if (!files[ARMORY_TOC]) throw new Error('This copy of the app does not carry the Forever AI Armory addon.');
  const dir = armoryDir(wowDir);
  fs.mkdirSync(dir, { recursive: true });
  for (const name of fs.readdirSync(dir)) {
    if (/\.(lua|toc|xml)$/i.test(name) && !(name in files)) fs.rmSync(path.join(dir, name), { force: true });
  }
  for (const [name, content] of Object.entries(stampedArmoryFiles(files))) fs.writeFileSync(path.join(dir, name), content);
  log(`Forever AI Armory ${bundledArmoryVersion(files)} (build ${armoryBuildId(files)}) installed in: ${dir}`);
  return dir;
}

// True when every file of the Armory this app carries is installed as it is
// here, its .toc with this build's stamp.
export function sameArmoryFiles(wowDir, files = armoryFiles()) {
  const dir = armoryDir(wowDir);
  return Object.entries(stampedArmoryFiles(files)).every(([name, content]) => {
    try {
      return fs.readFileSync(path.join(dir, name), 'utf8') === content;
    } catch {
      return false;
    }
  });
}

// Updates an installed Armory when its files are not the ones this app
// carries: another version, or the same version with other contents (a
// version keeps its number while it is being tested). Never installs it by
// itself. Returns true when the Armory is installed.
export function ensureArmory(wowDir, { files = armoryFiles(), log = () => {} } = {}) {
  const installed = installedArmoryVersion(wowDir);
  if (!installed) return false;
  const bundled = bundledArmoryVersion(files);
  if (!bundled) return true;
  if (installed !== bundled) {
    installArmory(wowDir, { files });
    log(`Forever AI Armory updated to ${bundled}`);
  } else if (!sameArmoryFiles(wowDir, files)) {
    installArmory(wowDir, { files });
    log(`Forever AI Armory ${bundled} replaced: its files were not the ones this app carries`);
  }
  return true;
}

export function uninstallArmory(wowDir) {
  fs.rmSync(armoryDir(wowDir), { recursive: true, force: true });
}
