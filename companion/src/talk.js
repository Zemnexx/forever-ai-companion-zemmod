// Voice questions: the player holds the addon's talk key (or clicks Talk),
// says the question and lets go. The addon sends a "listen" request with the
// character data like any question; the app records it (mic.js), turns it
// into text with OpenAI's transcription API (stt.js) and answers it as if it
// had been typed, sending the words back so the chat shows them.
//
// begin(req) starts recording as soon as the request arrives (even while
// another question is being answered); finish(req) waits for the recording
// and transcribes it, with the request's character data as vocabulary.
// stop(id) ends a recording early (the talk key was released).
import { err } from './i18n.js';
import { playerLang } from './prompt.js';
import { DEFAULT_STT_BASE_URL, DEFAULT_STT_MODEL, transcribe, vocabularyPrompt } from './stt.js';
import { wavFromPcm } from './vad.js';

// Shorter than this sounds like a cough or a click, not a question.
const MIN_SPEECH_MS = 300;

// The key used for transcription: the voice settings' own, else the ChatGPT one.
export function talkKey(cfg) {
  return cfg.talk?.apiKey || cfg.keys?.chatgpt || null;
}

export function talkSettings(cfg) {
  const t = cfg.talk || {};
  return {
    enabled: Boolean(t.enabled),
    model: t.model || DEFAULT_STT_MODEL,
    baseUrl: t.baseUrl || DEFAULT_STT_BASE_URL,
    maxMs: Math.min(60, Math.max(5, Number(t.maxSeconds) || 30)) * 1000,
    silenceMs: Math.min(4000, Math.max(600, Number(t.silenceMs) || 1500)),
    keySource: t.apiKey ? 'own' : cfg.keys?.chatgpt ? 'chatgpt' : null,
  };
}

// getCfg(): current settings. mic: from mic.js createMic (made on first use).
export function createTalk({ getCfg, getMic, log = () => {}, transcribeImpl = transcribe }) {
  const recordings = new Map(); // request id -> { done, stop }
  const seen = new Set();
  let mic = null;
  const micNow = () => (mic ||= getMic());

  function begin(req) {
    const id = String(req.id);
    if (seen.has(id)) return;
    seen.add(id);
    if (seen.size > 200) seen.delete(seen.values().next().value);
    const cfg = getCfg();
    const s = talkSettings(cfg);
    let rec;
    if (!s.enabled) rec = { done: Promise.reject(err('talkOff')), stop() {} };
    else if (!talkKey(cfg)) rec = { done: Promise.reject(err('talkNeedsKey')), stop() {} };
    else {
      log('Voice question: listening.');
      rec = micNow().record({ maxMs: s.maxMs, silenceMs: s.silenceMs });
    }
    rec.done.catch(() => {});
    recordings.set(id, rec);
  }

  function stop(id) {
    recordings.get(String(id))?.stop();
  }

  async function finish(req) {
    const id = String(req.id);
    if (!recordings.has(id)) begin(req);
    const rec = recordings.get(id);
    try {
      const { pcm, reason, speechMs } = await rec.done;
      log(`Voice question: recorded ${(pcm.length / 32000).toFixed(1)} s (${reason}).`);
      if (reason === 'muted') throw err('micMuted');
      if (reason === 'nospeech' || speechMs < MIN_SPEECH_MS) throw err('notHeard');
      const cfg = getCfg();
      const s = talkSettings(cfg);
      const text = await transcribeImpl({
        wav: wavFromPcm(pcm), apiKey: talkKey(cfg), model: s.model, baseUrl: s.baseUrl,
        language: playerLang({ lang: req.lang, client: req.context?.client }), prompt: vocabularyPrompt(req.context || {}),
      });
      if (!text) throw err('notHeard');
      return text;
    } finally {
      recordings.delete(id);
    }
  }

  // The window's "Test microphone": records until a pause and transcribes it.
  async function test({ lang = null } = {}) {
    const cfg = getCfg();
    const s = talkSettings(cfg);
    if (!talkKey(cfg)) throw err('talkNeedsKey');
    const started = Date.now();
    const { pcm, reason, speechMs } = await micNow().record({ maxMs: 10000, silenceMs: s.silenceMs }).done;
    if (reason === 'muted') throw err('micMuted');
    if (reason === 'nospeech' || speechMs < MIN_SPEECH_MS) throw err('notHeard');
    const text = await transcribeImpl({ wav: wavFromPcm(pcm), apiKey: talkKey(cfg), model: s.model, baseUrl: s.baseUrl, language: lang });
    if (!text) throw err('notHeard');
    return { text, seconds: ((Date.now() - started) / 1000).toFixed(1) };
  }

  return {
    begin,
    stop,
    finish,
    test,
    close() {
      for (const r of recordings.values()) r.stop();
      recordings.clear();
      mic?.close();
      mic = null;
    },
  };
}
