// Receives Forever AI Companion requests from the game, asks the AI, and delivers the
// answer back to the addon.
//
// Requests arrive as a strip of cells drawn by the addon. They are read
//  - straight from the screen (screen-reader.js), the normal way; or
//  - from screenshots in WoW's Screenshots folder (older addon versions).
import fs from 'node:fs';
import path from 'node:path';
import { wowPaths } from './config.js';
import { decodeImage } from './image.js';
import { GridUnreadableError, decodeGrid } from './grid.js';
import { publishInbox, resetSignals, ringSignal } from './inbox.js';
import { buildMessages, buildSystem, cleanAnswer, loadKnowledge, plainAnswer, playerLang } from './prompt.js';
import { guideFreshness } from './guide.js';
import { ask, canSearch } from './providers.js';
import { loadState, saveState } from './state.js';
import { loadContextCache, resolveContext, saveContextCache } from './context-cache.js';
import { startScreenReader } from './screen-reader.js';
import { probeReport, startProbeMonitor } from './probe.js';
import { startVoiceInbox } from './voice-inbox.js';
import { err, runInLang, t } from './i18n.js';
import { ensureRequestKey, hasRequestKey } from './request-key.js';

const SCREENSHOT_RE = /^WoWScrnShot_.*\.(png|tga|jpe?g)$/i;

export function parseRequest(payload) {
  const req = JSON.parse(payload.toString('utf8'));
  if (!req || typeof req.id !== 'string' || typeof req.question !== 'string') {
    throw new Error('Request without id or question');
  }
  return req;
}

// Reads one screenshot. Returns the parsed request or null if it is a normal screenshot.
export function readRequest(file) {
  if (/\.jpe?g$/i.test(file)) return null;
  const payload = decodeGrid(decodeImage(fs.readFileSync(file), file));
  return payload ? parseRequest(payload) : null;
}

export async function handleRequest(req, {
  cfg, paths, state, system, save = saveState, log = () => {}, onEvent = () => {},
  contextCache = {}, saveCache = () => {}, probeMonitor = null, talk = null,
}) {
  if (state.processed.includes(req.id)) return null;
  state.processed.push(req.id);

  if (req.resetSignals) {
    resetSignals(paths, cfg);
    state.nextSig = 1;
  }
  state.nextSig = Math.max(state.nextSig, Number(req.sig) || 1);

  // Fill in the sections the addon skipped because they did not change.
  const sentNow = Object.keys(req.context || {});
  const missing = resolveContext(req, contextCache);
  saveCache(contextCache);
  const extra = {};
  if (missing.length) {
    log(`Missing from the cache: ${missing.join(', ')}. Asking the addon to resend everything.`);
    extra.resync = Math.floor(Date.now() / 1000);
  }

  const ch = req.context?.character || {};
  const who = `${ch.name ?? '?'} (${ch.class ?? '?'} ${ch.level ?? '?'})` +
    (req.chat?.title ? ` · chat «${req.chat.title}»` : '');
  const lang = playerLang({ lang: req.lang, client: req.context?.client });
  if (req.listen) req.question = '';
  log(`${req.listen ? 'Voice question' : 'Question'} from ${who}${req.assistant ? ` for ${req.assistant}` : ''}${req.listen ? '' : `: ${req.question}`}`);
  if (req.context && typeof req.context === 'object') {
    log(`Secciones enviadas: ${sentNow.filter((k) => k !== 'diagnostics').join(', ') || '(ninguna)'}` +
      ` · sin cambios: ${Object.keys(req.same || {}).join(', ') || '(ninguna)'}`);
    // Why the addon could not read some sections: for the log, not for the AI.
    if (req.context.diagnostics) {
      log(`Sections with errors in the game: ${JSON.stringify(req.context.diagnostics)}`);
      delete req.context.diagnostics;
    }
  }
  onEvent({ type: 'question', id: req.id, who, question: req.listen ? t('talkEvent') : req.question });
  const started = Date.now();
  let answer;
  try {
    // Voice question: what the player said becomes the question (see talk.js).
    if (req.listen) {
      if (!talk) throw err('talkOff');
      req.question = await runInLang(lang, () => talk.finish(req));
      log(`Heard: ${req.question}`);
      onEvent({ type: 'heard', id: req.id, question: req.question });
    }
    // Channel probe: answered by the app itself, not by the AI. The addon
    // first asks the app to start watching the game's files (probeStart).
    const { text, model } = req.probeStart && probeMonitor
      ? (probeMonitor.activate(), { text: t('probeRecording'), model: 'prueba de canales' })
      : req.probe && probeMonitor
      ? { ...(await probeReport(req.probe, probeMonitor)), model: 'prueba de canales' }
      : await runInLang(lang, () => ask(cfg, typeof system === 'function' ? system(req) : system, buildMessages(req), req));
    answer = { id: req.id, ok: true, answer: cleanAnswer(text) || t('emptyAnswer'), model };
    log(`Respuesta (${model}, ${((Date.now() - started) / 1000).toFixed(1)} s):\n${answer.answer}`);
  } catch (e) {
    answer = { id: req.id, ok: false, answer: `Error: ${e.message}` };
    log(`Error: ${e.message}`);
  }
  // The addon shows what was heard as the question.
  if (req.listen && req.question) answer.question = req.question;
  onEvent({ type: 'answer', id: req.id, who, question: req.question, ok: answer.ok, answer: plainAnswer(answer.answer) });

  state.answers.push(answer);
  publishInbox(paths, cfg, state.answers, extra);
  if (state.nextSig <= cfg.signals) {
    ringSignal(paths, state.nextSig);
    state.nextSig++;
  }
  save(state);
  return answer;
}

// Starts listening. Returns { stop() }.
// guides: { current() -> newest Forever guide, onPatch() -> look for a newer one }.
// talk: voice questions (talk.js), or null.
export function startWatcher({ cfg, wowDir, log = () => {}, onEvent = () => {}, screenReader = true, guides = null, talk = null }) {
  const paths = wowPaths(wowDir);
  fs.mkdirSync(paths.screenshots, { recursive: true });
  const state = loadState();
  // The personality depends on the assistant the player picked (req.assistant).
  const knowledge = loadKnowledge();
  const system = (req) => {
    const client = req.context?.client || null;
    const guide = guides?.current();
    // The game was patched after the guide: fetch a newer guide for next time
    // (this answer already tells the AI to double-check).
    if (guide && guideFreshness(guide, { client }).gameNewer) guides.onPatch();
    return buildSystem(knowledge, req.assistant, { canSearch: canSearch(cfg), client, lang: req.lang, ...(guide ? { guide } : {}) });
  };
  const contextCache = loadContextCache();
  // Idle until the addon starts a channel test (see probe.js).
  const probeMonitor = startProbeMonitor({ wowDir, log });

  // Only requests with this PC's key (see request-key.js), whatever the channel.
  const key = ensureRequestKey(wowDir);
  let keyWarnedAt = 0;
  const authorized = (req) => {
    if (hasRequestKey(req, key)) {
      delete req.auth; // never logged or sent anywhere
      return true;
    }
    log('Ignored a request without this PC\'s addon key (an addon loaded before an update, or another program using the voice).');
    // An addon loaded before the update: its question fails with a hint to
    // reload. At most every 10 minutes, so others can't keep failing questions.
    if (Date.now() - keyWarnedAt > 600000) {
      keyWarnedAt = Date.now();
      reportFailure(t('reloadForKey'));
    }
    return false;
  };

  // One request at a time, whatever the source.
  let queue = Promise.resolve();
  const enqueue = (req) => {
    if (!authorized(req)) return queue;
    // The talk key was released: end that recording now, not after the queue.
    if (req.listenStop) {
      talk?.stop(req.listenStop);
      return queue;
    }
    // Voice question: start recording right away, even if another question
    // is still being answered.
    if (req.listen && talk && !state.processed.includes(req.id)) talk.begin(req);
    queue = queue
      .then(() => handleRequest(req, {
        cfg, paths, state, system, log, onEvent, contextCache, saveCache: saveContextCache, probeMonitor, talk,
      }))
      .catch((e) => log(`Error: ${e.message}`));
    return queue;
  };

  // A request we saw but could not read: tell the addon so the question
  // shows an error instead of "thinking..." forever.
  const reportFailure = (message) => {
    state.failure = { at: Math.floor(Date.now() / 1000), message };
    publishInbox(paths, cfg, state.answers, { failedAt: state.failure.at, failMessage: message });
    if (state.nextSig <= cfg.signals) {
      ringSignal(paths, state.nextSig);
      state.nextSig++;
    }
    saveState(state);
    onEvent({ type: 'problem', message });
  };

  // Strip read from the screen.
  const doneSeqs = new Set();
  const reader = screenReader
    ? startScreenReader({
      log,
      onFrame: (img) => {
        if (doneSeqs.has(img.seq)) return;
        let payload;
        try {
          payload = decodeGrid(img);
        } catch (e) {
          if (e instanceof GridUnreadableError && img.attempt >= 3) {
            doneSeqs.add(img.seq);
            log(`Franja ilegible: ${e.message}`);
            reportFailure(t('unreadableScreen'));
          }
          return;
        }
        if (!payload) return;
        doneSeqs.add(img.seq);
        try {
          enqueue(parseRequest(payload));
        } catch (e) {
          log(`Invalid request: ${e.message}`);
        }
      },
    })
    : null;

  // Invisible channel: the silent Windows voice.
  const voice = startVoiceInbox({
    log,
    onPayload: (payload) => {
      try {
        enqueue(parseRequest(payload));
      } catch (e) {
        log(`Invalid voice request: ${e.message}`);
      }
    },
  });

  // Screenshots (older addon versions).
  const seen = new Set();
  const sizes = new Map();
  let polling = false;
  const poll = async () => {
    if (polling) return;
    polling = true;
    try {
      for (const name of fs.readdirSync(paths.screenshots)) {
        if (!SCREENSHOT_RE.test(name) || seen.has(name)) continue;
        const file = path.join(paths.screenshots, name);
        let size;
        try { size = fs.statSync(file).size; } catch { continue; }
        if (size === 0 || sizes.get(name) !== size) { sizes.set(name, size); continue; }
        sizes.delete(name);
        let req;
        try {
          req = readRequest(file);
        } catch (e) {
          log(`Captura ${name}: ${e.message}`);
          seen.add(name);
          if (e instanceof GridUnreadableError) {
            fs.rmSync(file, { force: true });
            reportFailure(e.message);
          }
          continue;
        }
        if (!req) { seen.add(name); continue; }
        fs.rmSync(file, { force: true });
        await enqueue(req);
      }
    } catch (e) {
      log(`Error: ${e.message}`);
    } finally {
      polling = false;
    }
  };
  const timer = setInterval(poll, cfg.pollMs);
  poll();

  return {
    stop: () => {
      clearInterval(timer);
      if (reader) reader.stop();
      probeMonitor.stop();
      voice.stop();
    },
  };
}
