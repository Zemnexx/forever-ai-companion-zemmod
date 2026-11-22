// The Armory asks the AI for one JSON object. Not every provider can be made
// to return only JSON (the subscriptions run as plain chat, a web search adds
// its own sentences), so the object is dug out of whatever came back.

// The first complete top-level { ... } in `text`, ignoring braces inside strings.
function firstObject(text, from = 0) {
  const start = text.indexOf('{', from);
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') inString = false;
    } else if (c === '"') {
      inString = true;
    } else if (c === '{') {
      depth++;
    } else if (c === '}') {
      depth--;
      if (depth === 0) return { text: text.slice(start, i + 1), end: i + 1 };
    }
  }
  return null;
}

// What models add that JSON.parse refuses: // comments and trailing commas.
function relax(json) {
  let out = '';
  let inString = false;
  let escaped = false;
  for (let i = 0; i < json.length; i++) {
    const c = json[i];
    if (inString) {
      out += c;
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') inString = false;
    } else if (c === '"') {
      inString = true;
      out += c;
    } else if (c === '/' && json[i + 1] === '/') {
      while (i < json.length && json[i] !== '\n') i++;
      out += '\n';
    } else {
      out += c;
    }
  }
  return out.replace(/,(\s*[}\]])/g, '$1');
}

// The JSON object in an AI answer, or null. With several, the biggest one
// that parses: a model sometimes shows a small example before the real thing.
export function extractJson(text) {
  const s = String(text || '');
  let best = null;
  let at = 0;
  for (let n = 0; n < 20; n++) {
    const found = firstObject(s, at);
    if (!found) break;
    at = found.end;
    for (const candidate of [found.text, relax(found.text)]) {
      try {
        const value = JSON.parse(candidate);
        if (value && typeof value === 'object' && !Array.isArray(value) && (!best || found.text.length > best.size)) {
          best = { value, size: found.text.length };
        }
        break;
      } catch { /* try the relaxed copy, then the next object */ }
    }
  }
  return best ? best.value : null;
}

// Small helpers to read fields a model may have typed loosely.
export const str = (v, max = 400) => (typeof v === 'string' ? v.trim().slice(0, max) : typeof v === 'number' ? String(v) : '');
export const num = (v) => {
  const n = typeof v === 'string' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
};
export const list = (v) => (Array.isArray(v) ? v : v === undefined || v === null ? [] : [v]);
export const strings = (v, { max = 8, len = 300 } = {}) => list(v).map((x) => str(x, len)).filter(Boolean).slice(0, max);
export const round = (n, digits = 1) => {
  const m = 10 ** digits;
  return Math.round((Number(n) || 0) * m) / m;
};
