// Receives requests through the silent "ForeverAICompanion" voice: the voice
// engine (tts/ForeverAICompanionTts.cs) drops every text the game "speaks"
// with it as a file in %APPDATA%\ForeverAICompanion\tts-inbox. Messages are
//   FAIC:<request id>:<part>/<parts>:<base64 chunk>
// and the joined chunks are a frame (see grid.parseFrame).
//
// Until the player updates the invisible sending (one administrator prompt),
// the voice registered by an install from before the rename keeps writing to
// the inbox under the project's previous name, and an addon from before the
// rename still loaded in a running game uses the previous prefix: both are
// still accepted.
import fs from 'node:fs';
import path from 'node:path';
import { APP_ID, LEGACY_NAME, roamingDir } from './config.js';
import { parseFrame } from './grid.js';

export const voiceInboxDir = () => path.join(roamingDir(), APP_ID, 'tts-inbox');
export const legacyVoiceInboxDir = () => path.join(roamingDir(), LEGACY_NAME, 'tts-inbox');

// The game wraps what it speaks in bookmarks named "Start" and "End"; older
// versions of the voice passed them through, so they may surround the message.
// "AZIA" is the prefix used before the rename.
const MESSAGE = /(?:FAIC|AZIA):([^:\s]+):(\d+)\/(\d+):([A-Za-z0-9+/=\s]*)/;
// The addon's voice test (/ia test-voice): logged so the player can see it arrived.
const VOICE_TEST = /^\s*FAIC-VOICE-(?:TEST|LONG) /;

function decodeParts(parts) {
  try {
    return parseFrame(Buffer.from(parts.join(''), 'base64'));
  } catch (first) {
    // Retry without a trailing "End" bookmark glued to a chunk.
    const cleaned = parts.map((p) => p.replace(/End$/, ''));
    if (cleaned.join('') === parts.join('')) throw first;
    return parseFrame(Buffer.from(cleaned.join(''), 'base64'));
  }
}

// Feeds one spoken text. Returns the frame payload when a request is complete.
export function createAssembler() {
  const pending = new Map(); // id -> { parts: [], total, at }
  return {
    add(text) {
      const m = String(text).trim().match(MESSAGE);
      if (!m) return null;
      const [, id, partStr, totalStr, data] = m;
      const part = Number(partStr);
      const total = Number(totalStr);
      if (!part || !total || part > total || total > 1000) return null;
      let p = pending.get(id);
      if (!p) { p = { parts: [], total, at: Date.now() }; pending.set(id, p); }
      p.parts[part - 1] = data.replace(/\s+/g, '');
      // Forget incomplete requests after a minute.
      for (const [k, v] of pending) if (Date.now() - v.at > 60000) pending.delete(k);
      if (p.parts.filter((x) => x !== undefined).length < p.total) return null;
      pending.delete(id);
      return decodeParts(p.parts);
    },
  };
}

// Polls the inbox folder (and the one from before the rename, when it
// exists). onPayload(Buffer) for each complete request.
export function startVoiceInbox({
  onPayload, log = () => {}, dir = voiceInboxDir(), legacyDirs = [legacyVoiceInboxDir()], intervalMs = 100,
}) {
  fs.mkdirSync(dir, { recursive: true });
  const assembler = createAssembler();
  let busy = false;
  const readDir = (d) => {
    const names = fs.readdirSync(d).filter((n) => n.endsWith('.txt')).sort();
    for (const name of names) {
      const file = path.join(d, name);
      let text;
      try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
      fs.rmSync(file, { force: true });
      try {
        // Any program can speak with the voice: text that is not ours is
        // dropped without logging it (current engines never deliver it).
        if (VOICE_TEST.test(text)) {
          log(`Voice test received (${text.length} characters): ${text.trim().split(/\s+/).slice(0, 2).join(' ')}`);
          continue;
        }
        const payload = assembler.add(text);
        if (payload) onPayload(payload);
      } catch (e) {
        log(`Invalid voice message: ${e.message}`);
      }
    }
  };
  const poll = () => {
    if (busy) return;
    busy = true;
    try {
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true }); // someone deleted it
      readDir(dir);
      // Never created here: it only exists while a voice from before the rename writes to it.
      for (const d of legacyDirs) if (d && fs.existsSync(d)) readDir(d);
    } catch (e) {
      log(`Error reading the voice inbox: ${e.message}`);
    } finally {
      busy = false;
    }
  };
  const timer = setInterval(poll, intervalMs);
  poll();
  return { stop: () => clearInterval(timer), poll };
}
