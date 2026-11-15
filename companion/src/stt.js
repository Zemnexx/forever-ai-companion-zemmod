// Speech to text for voice questions: OpenAI's transcription API, called with
// Node's own fetch/FormData (no SDK). The recording is sent once and never
// stored.
import { err } from './i18n.js';

export const DEFAULT_STT_MODEL = 'gpt-4o-mini-transcribe';
export const DEFAULT_STT_BASE_URL = 'https://api.openai.com/v1';
const MAX_PROMPT_CHARS = 600;

// Names the player is likely to say, from the character data sent with the
// question (zone, quests, target, open windows, gear): the model spells game
// names right more often when it has seen them.
export function vocabularyPrompt(context = {}) {
  const names = [];
  const add = (v) => {
    const s = typeof v === 'string' ? v.trim() : '';
    if (s && s.length <= 60 && !names.includes(s)) names.push(s);
  };
  const list = (v) => (Array.isArray(v) ? v : []);
  add(context.position?.zone);
  add(context.position?.subzone);
  for (const q of list(context.quests).slice(0, 20)) add(q?.title);
  add(context.target?.name);
  for (const w of ['questOffer', 'questProgress', 'questReward', 'questGreeting', 'gossip', 'merchant', 'trainer']) {
    add(context.screen?.[w]?.npc);
    add(context.screen?.[w]?.title);
  }
  for (const it of list(context.screen?.merchant?.items).slice(0, 10)) add(it?.name);
  for (const g of list(context.gear).slice(0, 12)) add(g?.name);
  let out = 'World of Warcraft: Forever.';
  for (const n of names) {
    const next = `${out} ${n}.`;
    if (next.length > MAX_PROMPT_CHARS) break;
    out = next;
  }
  return out;
}

// wav: Buffer. language: "en" | "es". Returns the text (may be empty).
export async function transcribe({
  wav, apiKey, model = DEFAULT_STT_MODEL, language = null, prompt = null, baseUrl = DEFAULT_STT_BASE_URL,
  fetchImpl = fetch, timeoutMs = 60000,
}) {
  if (!apiKey) throw err('talkNeedsKey');
  const form = new FormData();
  form.append('file', new Blob([wav], { type: 'audio/wav' }), 'question.wav');
  form.append('model', model);
  form.append('response_format', 'json');
  if (language) form.append('language', language);
  if (prompt) form.append('prompt', prompt);
  let res;
  try {
    res = await fetchImpl(`${String(baseUrl).replace(/\/$/, '')}/audio/transcriptions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}` },
      body: form,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    throw err('sttFailed', { error: e.message });
  }
  if (res.status === 401 || res.status === 403) throw err('sttBadKey');
  if (res.status === 429) throw err('apiRateLimit');
  if (!res.ok) throw err('sttFailed', { error: `HTTP ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}` });
  const json = await res.json().catch(() => ({}));
  return String(json.text || '').trim();
}
