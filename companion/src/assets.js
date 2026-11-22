// Files the app needs at runtime. In development they are read from disk;
// scripts/build.js replaces this whole module with embedded copies so the
// packaged ForeverAICompanion.exe is self-contained.
import fs from 'node:fs';
import path from 'node:path';
import { ADDON_SRC, ARMORY_SRC, ROOT } from './config.js';

// { "ForeverAICompanion.toc": "...", "Core.lua": "...", ... }
// RequestKey.lua is created per PC by the app (request-key.js): a copy left
// in the source folder is never shipped.
export function addonFiles() {
  const out = {};
  for (const name of fs.readdirSync(ADDON_SRC)) {
    const file = path.join(ADDON_SRC, name);
    if (name !== 'RequestKey.lua' && fs.statSync(file).isFile()) out[name] = fs.readFileSync(file, 'utf8');
  }
  return out;
}

// The Armory addon's files, the same way: { "ForeverAICompanionArmory.toc": "...", ... }.
// Empty when this copy of the app was built without them.
export function armoryFiles() {
  const out = {};
  let names = [];
  try { names = fs.readdirSync(ARMORY_SRC); } catch { /* not in this checkout */ }
  for (const name of names) {
    const file = path.join(ARMORY_SRC, name);
    if (fs.statSync(file).isFile()) out[name] = fs.readFileSync(file, 'utf8');
  }
  return out;
}

export function uiHtml() {
  return fs.readFileSync(path.join(ROOT, 'src', 'app', 'ui.html'), 'utf8');
}

export function sampleContext() {
  return JSON.parse(fs.readFileSync(path.join(ROOT, 'sample', 'sample-context.json'), 'utf8'));
}

// C# source of the silent voice; compiled on the player's PC with the
// compiler that ships with Windows.
export function ttsEngineSource() {
  return fs.readFileSync(path.join(ROOT, 'tts', 'ForeverAICompanionTts.cs'), 'utf8');
}

export function knowledgeReadme() {
  return fs.readFileSync(path.join(ROOT, 'knowledge', 'README.md'), 'utf8');
}

// Icon shown in the app window (tab / taskbar) and its header.
export function appIconPng() {
  return fs.readFileSync(path.join(ROOT, 'assets', 'icon-256.png'));
}

// Icon file for the program next to the clock (tray/Tray.cs).
export function appIconIco() {
  return fs.readFileSync(path.join(ROOT, 'assets', 'app.ico'));
}

export function trayCsSource() {
  return fs.readFileSync(path.join(ROOT, 'tray', 'Tray.cs'), 'utf8');
}

// Microphone helper for voice questions (mic/Mic.cs), compiled on the PC.
export function micCsSource() {
  return fs.readFileSync(path.join(ROOT, 'mic', 'Mic.cs'), 'utf8');
}

// Built-in guides about WoW Forever for the AI (knowledge-builtin/): the base
// guide (wow-forever.md) and the detailed topics (wow-forever-topics.md).
export const GUIDE_FILES = ['wow-forever.md', 'wow-forever-topics.md'];
export function foreverGuide(file = 'wow-forever.md') {
  try {
    return fs.readFileSync(path.join(ROOT, 'knowledge-builtin', file), 'utf8');
  } catch {
    return '';
  }
}
