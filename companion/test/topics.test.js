import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  GUIDE_FILE, TOPICS_FILE, currentGuide, normalizeText, selectTopics, sigFileOf, startGuideUpdates, topicSections, topicsUrl,
} from '../src/guide.js';
import { buildSystem } from '../src/prompt.js';
import { GUIDE_CONTEXT, encodeSignature, guideFields, signedMessage } from '../src/signing.js';

const topics = {
  meta: { date: '2026-11-15' },
  body: [
    '## Topics',
    '### Riding and mounts',
    'keywords: mount, riding, montura, equitacion, apprentice riding',
    '- Level 40: 100 gold.',
    '### The Drowned City',
    'keywords: drowned city, ciudad anegada, i\'lalai, stranglethorn, tuercespina',
    '- Levels 35-42, entrance west of Stranglethorn Vale.',
    '### Hall of Thanes',
    'keywords: hall of thanes, ironforge, forjaz',
    '- Levels 13-18.',
    '### Calendar',
    'keywords: always',
    '- Raids open December 9, 2026.',
  ].join('\n'),
};

test('topic sections and their keywords', () => {
  const s = topicSections(topics.body);
  assert.deepEqual(s.map((x) => x.title), ['Riding and mounts', 'The Drowned City', 'Hall of Thanes', 'Calendar']);
  assert.ok(s[1].keywords.includes(' ciudad anegada '));
  assert.equal(s[3].always, true);
  assert.equal(normalizeText('¿Dónde está La Ciudad Anegada?'), ' donde esta la ciudad anegada ');
  assert.equal(topicsUrl('https://x.test/companion/knowledge-builtin/wow-forever.md'), 'https://x.test/companion/knowledge-builtin/wow-forever-topics.md');
});

test('a question gets its sections (Spanish or English), plus the "always" ones', () => {
  const es = selectTopics(topics, { question: '¿Dónde está la entrada de La Ciudad Anegada?' });
  assert.match(es, /### The Drowned City/);
  assert.match(es, /### Calendar/);
  assert.doesNotMatch(es, /Riding|Hall of Thanes/);

  const en = selectTopics(topics, { question: 'how much is the mount?' });
  assert.match(en, /### Riding and mounts/);
  assert.doesNotMatch(en, /Drowned/);
});

test('an item or NPC named in the question finds the section that mentions it', () => {
  const withLoot = { meta: topics.meta, body: `${topics.body}\n### City of Dalaran\nkeywords: dalaran\n- Fel Ancient: Blightleaf Rope, Felbough Arm, Garb of Fallen Felbark.` };
  const picked = selectTopics(withLoot, { question: '¿Dónde consigo el Felbough Arm?' });
  assert.match(picked, /### City of Dalaran/);
  assert.doesNotMatch(selectTopics(withLoot, { question: '¿Dónde consigo un arma?' }), /City of Dalaran/, 'single common words are not names');
});

test('the player\'s zone helps, the budget is respected', () => {
  const ctx = { position: { zone: 'Stranglethorn Vale' } };
  assert.match(selectTopics(topics, { question: 'what dungeon is near?', context: ctx }), /Drowned City/);
  const tiny = selectTopics(topics, { question: 'mount and drowned city', budget: 120 });
  assert.ok(tiny.length <= 120);
});

test('the prompt includes only the picked topic sections', () => {
  const system = buildSystem('', 'fizzi', { topics, question: 'Where is the Hall of Thanes?' });
  assert.match(system, /## WoW Forever details for this question \(reviewed 2026-11-15/);
  assert.match(system, /Levels 13-18/);
  assert.doesNotMatch(system, /Levels 35-42/);
  const none = buildSystem('', 'fizzi', { topics: null, question: 'Where is the Hall of Thanes?' });
  assert.doesNotMatch(none, /details for this question/);
});

// A throwaway project key for the tests. The file name is part of what is signed.
const project = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const trustedKeys = [project.publicKey.export({ type: 'spki', format: 'der' }).toString('base64')];
const sign = (text, file) => encodeSignature(crypto.sign('sha256', signedMessage(GUIDE_CONTEXT,
  guideFields({ file, sha256: crypto.createHash('sha256').update(Buffer.from(text)).digest('hex') })), { key: project.privateKey, dsaEncoding: 'ieee-p1363' }));

test('the topics file is downloaded and kept like the base guide: signed, with its larger size limit', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'faic-topics-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const big = `---\ndate: 2099-01-01\ngameVersion: 1.61.0\nbuild: 71500\n---\n# World of Warcraft: Forever detailed topics\n### X\nkeywords: x\n${'Forever facts. '.repeat(20000)}`;
  assert.ok(Buffer.byteLength(big) > 200 * 1024, 'bigger than the base guide may be');
  const url = 'https://example.test/wow-forever-topics.md';
  const serve = (sig) => async (u) => {
    if (u === `${url}.sig`) return sig === null ? new Response('', { status: 404 }) : new Response(sig, { status: 200 });
    return new Response(big, { status: 200 });
  };
  const update = (sig, keys = trustedKeys) => {
    const u = startGuideUpdates({ url, dir, file: TOPICS_FILE, fetchImpl: serve(sig), intervalMs: 1e9, trustedKeys: keys });
    return u.check('manual').finally(() => u.stop());
  };

  // Refused: no signature, the base guide's signature for the same bytes.
  assert.equal(await update(null), false);
  assert.equal(await update(sign(big, GUIDE_FILE)), false, 'a base guide signature does not pass for the topics');
  assert.equal(fs.existsSync(path.join(dir, TOPICS_FILE)), false);
  // Without a trusted key, nothing is downloaded at all.
  assert.equal(await update(sign(big, TOPICS_FILE), []), false);
  assert.equal(fs.existsSync(path.join(dir, TOPICS_FILE)), false);

  // Signed for the topics file: kept, with its signature next to it.
  assert.equal(await update(sign(big, TOPICS_FILE)), true);
  assert.equal(currentGuide(dir, TOPICS_FILE, { trustedKeys }).meta.date, '2099-01-01');
  assert.equal(currentGuide(dir, TOPICS_FILE, { trustedKeys }).source, 'descargada');
  assert.notEqual(currentGuide(dir, GUIDE_FILE, { trustedKeys }).meta.date, '2099-01-01', 'the base guide is untouched');

  // Checked again when read from disk: a swapped signature, or none, falls back to the built-in copy.
  fs.writeFileSync(path.join(dir, sigFileOf(TOPICS_FILE)), sign(big, GUIDE_FILE));
  assert.equal(currentGuide(dir, TOPICS_FILE, { trustedKeys }).source, 'incluida');
  fs.rmSync(path.join(dir, sigFileOf(TOPICS_FILE)));
  assert.equal(currentGuide(dir, TOPICS_FILE, { trustedKeys }).source, 'incluida');
});

test('the AI searches Forever guides with its own tools, and never says where a fact came from', () => {
  const withSearch = buildSystem('', 'fizzi', { canSearch: true });
  assert.match(withSearch, /wowhead\.com\/forever\/guide/);
  assert.match(withSearch, /warcrafttavern\.com\/forever/);
  assert.doesNotMatch(withSearch, /wow_lookup|game database/i, 'no app-side lookups');
  assert.match(buildSystem('', 'fizzi', { canSearch: false }), /según los datos/);
});
